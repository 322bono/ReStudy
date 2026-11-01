"""Registration-time preparation and immutable original-image snapshots."""

from __future__ import annotations
import hashlib
import math
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import pymupdf
from .store import Store, DomainError, new_id, now
from .pdf_processing import preprocess_document, render_regions


def sniff(data):
    if not data or len(data) > 50 * 1024 * 1024:
        raise DomainError("파일은 0바이트 초과, 50MB 이하로 올려 주세요.")
    if b"%PDF-" in data[:1024]:
        return "application/pdf"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    raise DomainError("PDF, PNG, JPG, WebP 파일을 올려 주세요.")


def validate_regions(store, material_id, regions, db=None):
    if not isinstance(regions, list) or not 1 <= len(regions) <= 20:
        raise DomainError("문제 영역은 1~20개로 지정해 주세요.")
    pages = {p["number"]: p for p in store.pages(material_id, db)}
    for r in regions:
        try:
            if r["page"] not in pages or pages[r["page"]]["kind"] == "answers":
                raise DomainError("정답·해설 페이지는 문제 영역에 포함할 수 없습니다.")
            x, y, w, h = (r[k] for k in ["x", "y", "w", "h"])
            if (
                not all(
                    isinstance(v, (int, float)) and math.isfinite(v)
                    for v in [x, y, w, h]
                )
                or x < 0
                or y < 0
                or w <= 0.005
                or h <= 0.005
                or x + w > 1.001
                or y + h > 1.001
            ):
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise DomainError("원본 페이지 안에서 문제 전체 영역을 지정해 주세요.")


class DocumentService:
    def __init__(self, store: Store, synchronous=False):
        self.store = store
        self.synchronous = synchronous
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="re-prepare")
        self.pending = set()
        self.lock = threading.RLock()

    def close(self):
        self.pool.shutdown(wait=True, cancel_futures=False)

    def enqueue(self, id):
        with self.lock:
            if id in self.pending:
                return
            self.pending.add(id)
        if self.synchronous:
            self._process(id)
        else:
            self.pool.submit(self._process, id)

    def register(self, files, subject, kind):
        if (
            not subject.strip()
            or len(subject) > 100
            or kind not in ["문제집", "교과서", "학습지", "필기", "기타"]
        ):
            raise DomainError("과목과 자료 종류를 확인해 주세요.")
        if (
            not 1 <= len(files) <= 10
            or sum(len(f[1]) for f in files) > 50 * 1024 * 1024
        ):
            raise DomainError("한 번에 10개, 총 50MB 이하로 올려 주세요.")
        prepared = [
            (name, data, sniff(data), hashlib.sha256(data).hexdigest())
            for name, data in files
        ]
        added = []
        created = []
        try:
            with self.store.tx() as db:
                for filename, data, mime, digest in prepared:
                    existing = next(
                        (
                            m
                            for m in self.store.list("materials", db)
                            if m.get("hash") == digest
                            and m.get("subject") == subject
                            and not m.get("archived")
                        ),
                        None,
                    )
                    if existing:
                        added.append(existing)
                        continue
                    id = new_id()
                    folder = self.store.root / "files"
                    folder.mkdir(exist_ok=True)
                    original = folder / id
                    original.write_bytes(data)
                    created.append(original)
                    stamp = now()
                    m = {
                        "id": id,
                        "title": Path(filename).stem[:120] or "학습 자료",
                        "subject": subject,
                        "kind": kind,
                        "mime": mime,
                        "bytes": len(data),
                        "hash": digest,
                        "pageCount": 0,
                        "progress": 0,
                        "status": "uploaded",
                        "createdAt": stamp,
                        "lastOpenedAt": stamp,
                        "originalFile": str(original),
                        "sourceFile": str(original),
                        "archived": False,
                    }
                    self.store.put("materials", m, db)
                    added.append(m)
        except BaseException:
            for file in created:
                file.unlink(missing_ok=True)
            raise
        for m in added:
            if m["status"] == "uploaded":
                self.enqueue(m["id"])
        return added

    def _processing_source(self, m):
        original = self.store.local_file(
            m.get("originalFile")
            or m.get("sourceFile")
            or self.store.root / "files" / m["id"]
        )
        if not original.is_file():
            raise DomainError(
                "원본 파일을 찾을 수 없습니다. 백업한 files 폴더를 확인해 주세요."
            )
        if m.get("mime") == "application/pdf":
            return original
        source = self.store.root / "files" / (m["id"] + ".pdf")
        if not source.exists():
            # A lossless PDF container preserves imported image pixels for the same processing pipeline.
            from PIL import Image
            import io

            img = Image.open(io.BytesIO(original.read_bytes()))
            img.load()
            if img.width * img.height > 60_000_000:
                raise DomainError(
                    "이미지가 너무 큽니다. 6천만 픽셀 이하로 나누어 주세요."
                )
            png = io.BytesIO()
            img.save(png, format="PNG")
            doc = pymupdf.open()
            page = doc.new_page(width=img.width * 0.72, height=img.height * 0.72)
            page.insert_image(page.rect, stream=png.getvalue())
            doc.save(source)
            doc.close()
        return source

    def _process(self, id):
        s = self.store
        try:
            m = s.get("materials", id)

            def progress(percent, message):
                with s.tx() as db:
                    current = s.get("materials", id, db)
                    current.update(
                        status="processing",
                        progress=percent,
                        message=message,
                        error=None,
                    )
                    s.put("materials", current, db)

            progress(1, "원본 준비")
            source = self._processing_source(m)
            output = s.root / "prepared" / id / new_id()
            result = preprocess_document(source, output, progress, kind=m["kind"])
            old = [q for q in s.list("questions") if q["materialId"] == id]
            matched = set()
            questions = []
            for candidate in result["questions"]:
                match = next(
                    (
                        q
                        for q in old
                        if q["id"] not in matched
                        and q["number"] == candidate["number"]
                        and q.get("page", q["regions"][0]["page"])
                        == candidate.get("page", candidate["regions"][0]["page"])
                    ),
                    None,
                )
                if match:
                    matched.add(match["id"])
                    if match.get("confirmed"):
                        candidate = {**candidate, **match}
                        candidate["cropFiles"] = render_regions(
                            source, candidate["regions"], output / "reviewed" / new_id()
                        )
                    else:
                        candidate = {**match, **candidate}
                candidate.update(id=match["id"] if match else new_id(), materialId=id)
                questions.append(candidate)
            # Missing recognitions never delete a manually reviewed problem or its history.
            for q in old:
                if q["id"] not in matched:
                    if not q.get("cropFiles"):
                        q["cropFiles"] = render_regions(
                            source, q["regions"], output / "retained" / new_id()
                        )
                    questions.append(q)
            with s.tx() as db:
                previous_pages = {p["number"]: p for p in s.pages(id, db)}
                for page in result["pages"]:
                    previous = previous_pages.get(page["number"])
                    if previous and previous.get("manualKind"):
                        page.update(kind=previous["kind"], manualKind=True)
                    s.put_page(id, page, db)
                for q in questions:
                    latest = s.get("questions", q["id"], db, False)
                    if latest:
                        # Mapping/answer edits are independent of the preparation job.
                        for field in ["answer", "explanation"]:
                            if field in latest:
                                q[field] = latest[field]
                    s.put("questions", q, db)
                m = s.get("materials", id, db)
                m.update(
                    sourceFile=str(source),
                    originalFile=m.get("originalFile") or str(s.root / "files" / id),
                    pageCount=len(result["pages"]),
                    progress=100,
                    status="needs_review"
                    if any(not q.get("confirmed") for q in questions)
                    or any(p["kind"] == "uncertain" for p in result["pages"])
                    else "ready",
                    warnings=result["warnings"],
                    error=None,
                    message="사전 처리 완료",
                )
                s.put("materials", m, db)
        except Exception as exc:
            with s.tx() as db:
                m = s.get("materials", id, db, False)
                if m:
                    m.update(status="error", progress=0, error=str(exc)[:500])
                    s.put("materials", m, db)
        finally:
            with self.lock:
                self.pending.discard(id)

    def save_question(self, id, payload):
        s = self.store
        old = s.get("questions", id, required=False) if id else None
        mid = payload.get("materialId") or (old or {}).get("materialId")
        m = s.get("materials", mid)
        if old and old["materialId"] != mid:
            raise DomainError("문제의 원본 자료를 바꿀 수 없습니다.")
        if m["status"] in ["uploaded", "processing"]:
            raise DomainError("전체 사전 처리가 끝난 뒤 수정해 주세요.", 409)
        regions = payload.get("regions", (old or {}).get("regions", []))
        validate_regions(s, mid, regions)
        number = payload.get("number", (old or {}).get("number"))
        if not isinstance(number, int) or not 1 <= number <= 99999:
            raise DomainError("문제 번호를 확인해 주세요.")
        start_page = payload.get("page") or (old or {}).get("page")
        if start_page not in {r["page"] for r in regions}:
            if payload.get("page") is not None:
                raise DomainError(
                    "문항 시작 쪽은 저장한 영역의 페이지 중에서 선택해 주세요."
                )
            start_page = regions[
                min((old or {}).get("sharedRegionCount", 0), len(regions) - 1)
            ]["page"]
        source = s.local_file(m["sourceFile"])
        images = render_regions(source, regions, s.root / "crops" / new_id())
        value = {
            "id": id or new_id(),
            "materialId": mid,
            "number": number,
            "page": start_page,
            "unit": str(payload.get("unit", (old or {}).get("unit", "")))[:200],
            "text": (old or {}).get("text", ""),
            "regions": regions,
            "confirmed": bool(payload.get("confirmed", False)),
            "source": "manual",
            "confidence": 1 if payload.get("confirmed") else 0,
            "cropFiles": images,
            "revision": new_id(),
        }
        with s.tx() as db:
            current = s.get("materials", mid, db)
            if current["status"] in ["uploaded", "processing"]:
                raise DomainError(
                    "다른 화면에서 재처리를 시작했습니다. 완료 후 다시 저장해 주세요.",
                    409,
                )
            if old:
                latest = s.get("questions", id, db)
                if latest.get("revision") != old.get("revision"):
                    raise DomainError(
                        "다른 화면에서 영역을 수정했습니다. 다시 열어 확인해 주세요.",
                        409,
                    )
                value = {**latest, **value}
            s.put("questions", value, db)
            current.update(
                status="needs_review"
                if any(
                    not q.get("confirmed")
                    for q in s.list("questions", db)
                    if q["materialId"] == mid
                )
                else "ready"
            )
            s.put("materials", current, db)
        return value

    def archive(self, id):
        with self.store.tx() as db:
            m = self.store.get("materials", id, db)
            if m["status"] in ["uploaded", "processing"]:
                raise DomainError("처리가 끝난 후 보관해 주세요.", 409)
            m["archived"] = True
            self.store.put("materials", m, db)
