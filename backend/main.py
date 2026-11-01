from __future__ import annotations
import copy
import json
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse
from fastapi import FastAPI, Request, UploadFile, File, Form
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from .store import Store, DomainError, new_id, now
from .documents import DocumentService, validate_regions
from .pdf_processing import ocr_status
from .content import (
    validate_package,
    import_package,
    export_package,
    content_check,
    sqlite_package_bytes,
    read_package_file,
)
from .learning import (
    create_review,
    create_material_study,
    answer_session,
    public_session,
    concept_statistics,
    weak_cards,
    repeat_weak,
    parse_numbers,
    next_review,
)

ROOT = Path(__file__).resolve().parents[1]


def public_material(m):
    return {
        k: v
        for k, v in m.items()
        if k not in ["sourceFile", "originalFile", "legacySource"]
    }


def public_question(store, q, db=None, bank=None):
    ids = store.concept_ids(q["id"], db)
    items = bank if bank is not None else store.list("bank_items", db)
    return {
        **{
            k: v
            for k, v in q.items()
            if k not in ["cropFiles", "answer", "explanation"]
        },
        "conceptIds": ids,
        "hasContent": bool(ids)
        and all(
            any(
                i["conceptId"] == cid
                and i.get("active", True)
                and set(i["modes"]).intersection({"quiz", "check"})
                for i in items
            )
            for cid in ids
        ),
        "page": q.get("page", q["regions"][0]["page"]),
    }


def public_solve(store, session, db=None):
    return {
        **{k: v for k, v in session.items() if k != "questionSnapshots"},
        "questions": [
            public_question(store, q, db) for q in session.get("questionSnapshots", [])
        ],
    }


def create_app(data_root=None, synchronous_processing=False):
    @asynccontextmanager
    async def lifespan(app):
        store = Store(data_root)
        app.state.store = store
        documents = DocumentService(store, synchronous_processing)
        app.state.documents = documents
        # Only incomplete registrations/migrations are resumed. Prepared files are never reanalysed on launch.
        for m in store.list("materials"):
            if m["status"] in ["uploaded", "processing"] and not m.get("archived"):
                documents.enqueue(m["id"])
        yield
        documents.close()

    app = FastAPI(
        title="RE 로컬 학습",
        version="2.0.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.exception_handler(DomainError)
    async def domain_error(req, exc):
        return JSONResponse({"error": exc.message}, status_code=exc.status)

    @app.exception_handler(json.JSONDecodeError)
    async def bad_json(req, exc):
        return JSONResponse(
            {"error": "입력 파일 또는 요청의 JSON 형식을 확인해 주세요."},
            status_code=400,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(req, exc):
        return JSONResponse(
            {
                "error": "입력 내용을 확인해 주세요.",
                "details": [".".join(map(str, i["loc"])) for i in exc.errors()],
            },
            status_code=400,
        )

    @app.middleware("http")
    async def local_only(req, call_next):
        if req.url.path.startswith("/api/"):
            if req.method not in ["GET", "HEAD", "OPTIONS"]:
                origin = req.headers.get("origin")
                host = req.headers.get("host")
                if req.headers.get("sec-fetch-site") == "cross-site" or (
                    origin and urlparse(origin).netloc != host
                ):
                    return JSONResponse(
                        {"error": "다른 사이트에서 보낸 요청은 허용되지 않습니다."},
                        status_code=403,
                    )
                if int(req.headers.get("content-length", "0") or 0) > 55 * 1024 * 1024:
                    return JSONResponse(
                        {"error": "요청이 너무 큽니다. 50MB 이하로 나누어 주세요."},
                        status_code=413,
                    )
        result = await call_next(req)
        if req.url.path.startswith("/api/"):
            result.headers["Cache-Control"] = "no-store"
            result.headers["X-Content-Type-Options"] = "nosniff"
        return result

    def S(req):
        return req.app.state.store

    def D(req):
        return req.app.state.documents

    def file_result(store, file, mime="image/png", filename=None):
        path = store.local_file(file)
        if not path.is_file():
            raise DomainError(
                "저장된 파일이 없습니다. 콘텐츠 관리에서 사전 처리를 다시 실행해 주세요.",
                409,
            )
        return FileResponse(
            path, media_type=mime, filename=filename, content_disposition_type="inline"
        )

    @app.get("/api/health")
    def health(req: Request):
        return {"app": "RE", "version": 2, "local": True, "ocr": ocr_status()}

    @app.get("/api/state")
    def state(req: Request):
        s = S(req)
        with s.tx() as db:
            materials = [m for m in s.list("materials", db) if not m.get("archived")]
            active = {m["id"] for m in materials}
            banks = s.list("bank_items", db)
            qs = [q for q in s.list("questions", db) if q["materialId"] in active]
            qid = {q["id"] for q in qs}
            stats = concept_statistics(s, db)
            mistakes = []
            for m in s.list("mistakes", db):
                if m.get("archived") or m["questionId"] not in qid:
                    continue
                ids = s.concept_ids(m["questionId"], db)
                m["conceptState"] = (
                    "unregistered"
                    if not ids
                    else m.get("conceptState")
                    if m.get("conceptState") in ["reviewing", "understood"]
                    else "reviewing"
                )
                m.setdefault("correctCount", 0)
                attempted = [stats[c] for c in ids if c in stats]
                if attempted:
                    m["conceptAccuracy"] = round(
                        sum(x["accuracy"] for x in attempted) / len(attempted)
                    )
                mistakes.append(m)
            bank_stats = []
            for c in s.list("concepts", db):
                items = [
                    i
                    for i in banks
                    if i["conceptId"] == c["id"] and i.get("active", True)
                ]
                bank_stats.append(
                    {
                        "conceptId": c["id"],
                        "count": len(items),
                        "modes": sorted({mode for i in items for mode in i["modes"]}),
                    }
                )
            return {
                "materials": [public_material(m) for m in materials],
                "questions": [public_question(s, q, db, banks) for q in qs],
                "mistakes": mistakes,
                "sessions": [
                    {k: v for k, v in session.items() if k != "questionSnapshots"}
                    for session in s.list("solve_sessions", db)
                    if set(session["questionIds"]).issubset(qid)
                ][:50],
                "studies": [
                    public_session(session)
                    for session in s.list("study_sessions", db)
                    if not session.get("legacy")
                    and set(session.get("materialIds", [])).issubset(active)
                ][:50],
                "concepts": s.list("concepts", db),
                "bankStats": bank_stats,
                "migration": s.meta("legacy_migration", None, db),
            }

    @app.post("/api/materials", status_code=202)
    async def upload(
        req: Request,
        files: list[UploadFile] = File(...),
        subject: str = Form(...),
        kind: str = Form(...),
    ):
        if len(files) > 10:
            raise DomainError("한 번에 10개 이하로 올려 주세요.")
        payload = []
        total = 0
        for file in files:
            data = await file.read(50 * 1024 * 1024 + 1)
            total += len(data)
            if total > 50 * 1024 * 1024:
                raise DomainError("한 번에 총 50MB 이하로 올려 주세요.")
            payload.append((file.filename or "학습 자료", data))
        return {
            "materials": [
                public_material(m)
                for m in D(req).register(payload, subject.strip(), kind)
            ]
        }

    @app.get("/api/materials/{id}")
    def material(req: Request, id: str):
        s = S(req)
        with s.tx() as db:
            m = s.get("materials", id, db)
            m["lastOpenedAt"] = now()
            s.put("materials", m, db)
            return {
                "material": public_material(m),
                "pages": [
                    {k: v for k, v in p.items() if k not in ["imageFile", "items"]}
                    for p in s.pages(id, db)
                ],
                "questions": [
                    public_question(s, q, db)
                    for q in s.list("questions", db)
                    if q["materialId"] == id
                ],
            }

    @app.get("/api/materials/{id}/file")
    def source(req: Request, id: str):
        s = S(req)
        m = s.get("materials", id)
        return file_result(s, m.get("originalFile") or m["sourceFile"], m["mime"])

    @app.get("/api/materials/{id}/page/{number}")
    def page(req: Request, id: str, number: int):
        s = S(req)
        s.get("materials", id)
        p = next((p for p in s.pages(id) if p["number"] == number), None)
        if not p or not p.get("imageFile"):
            raise DomainError("페이지 사전 처리가 완료되지 않았습니다.", 409)
        return file_result(s, p["imageFile"])

    @app.post("/api/materials/{id}/retry")
    def retry(req: Request, id: str):
        s = S(req)
        m = s.get("materials", id)
        if m.get("archived"):
            raise DomainError("보관된 자료입니다.")
        D(req).enqueue(id)
        return {"ok": True}

    @app.patch("/api/materials/{id}/page-kind")
    async def page_kind(req: Request, id: str):
        body = await req.json()
        s = S(req)
        if body.get("kind") not in ["content", "answers", "uncertain"]:
            raise DomainError("페이지 종류를 확인해 주세요.")
        with s.tx() as db:
            m = s.get("materials", id, db)
            if m["status"] in ["uploaded", "processing"]:
                raise DomainError("사전 처리가 끝난 뒤 수정해 주세요.", 409)
            page = next(
                (p for p in s.pages(id, db) if p["number"] == body.get("page")), None
            )
            if not page:
                raise DomainError("페이지를 찾을 수 없습니다.", 404)
            page.update(kind=body["kind"], manualKind=True)
            s.put_page(id, page, db)
            if body["kind"] == "answers":
                for q in s.list("questions", db):
                    if q["materialId"] == id and any(
                        r["page"] == page["number"] for r in q["regions"]
                    ):
                        q["confirmed"] = False
                        s.put("questions", q, db)
                m["status"] = "needs_review"
                s.put("materials", m, db)
        return {"ok": True}

    @app.delete("/api/materials/{id}")
    def archive(req: Request, id: str):
        D(req).archive(id)
        return {"ok": True, "archived": True}

    @app.post("/api/questions")
    async def create_question(req: Request):
        return public_question(S(req), D(req).save_question(None, await req.json()))

    @app.patch("/api/questions/{id}")
    async def edit_question(req: Request, id: str):
        S(req).get("questions", id)
        return public_question(S(req), D(req).save_question(id, await req.json()))

    @app.get("/api/questions/{id}/image/{part}")
    def image(req: Request, id: str, part: int, session: str | None = None):
        s = S(req)
        if session:
            solve = s.get("solve_sessions", session)
            if id not in solve["questionIds"]:
                raise DomainError("이 풀이의 문제가 아닙니다.")
            q = next(
                (q for q in solve.get("questionSnapshots", []) if q["id"] == id), None
            ) or s.get("questions", id)
        else:
            q = s.get("questions", id)
        validate_regions(s, q["materialId"], q["regions"])
        if not 0 <= part < len(q.get("cropFiles", [])):
            raise DomainError(
                "저장된 문제 이미지가 없습니다. 콘텐츠 관리에서 영역을 저장해 주세요.",
                409,
            )
        return file_result(s, q["cropFiles"][part])

    @app.patch("/api/questions/{id}/mapping")
    async def mapping(req: Request, id: str):
        s = S(req)
        s.get("questions", id)
        body = await req.json()
        result = import_package(
            s, {"schemaVersion": 1, "mappings": [{"questionId": id, **body}]}
        )
        return {**result, "question": public_question(s, s.get("questions", id))}

    @app.post("/api/mistakes")
    async def add_mistakes(req: Request):
        body = await req.json()
        s = S(req)
        ids = body.get("questionIds") or []
        ambiguous = []
        missing = []
        if body.get("numbers") is not None:
            s.get("materials", body.get("materialId"))
            candidates = [
                q for q in s.list("questions") if q["materialId"] == body["materialId"]
            ]
            for number in parse_numbers(body["numbers"]):
                matches = [q for q in candidates if q["number"] == number]
                if len(matches) == 1:
                    ids.append(matches[0]["id"])
                elif len(matches) > 1:
                    ambiguous.append(number)
                else:
                    missing.append(number)
        if not ids and not ambiguous and not missing:
            raise DomainError("오답 번호 또는 문제를 선택해 주세요.")
        if len(ids) > 200:
            raise DomainError("한 번에 200개 이하로 등록해 주세요.")
        added = []
        reviewable = []
        unregistered = 0
        with s.tx() as db:
            for qid in dict.fromkeys(ids):
                q = s.get("questions", qid, db)
                existing = next(
                    (m for m in s.list("mistakes", db) if m["questionId"] == qid), None
                )
                if existing and not existing.get("archived"):
                    continue
                stamp = now()
                m = existing or {
                    "id": new_id(),
                    "questionId": qid,
                    "createdAt": stamp,
                    "dueAt": stamp,
                    "streak": 0,
                    "reviewCount": 0,
                    "correctCount": 0,
                }
                m.update(
                    cause=body.get("cause", ""),
                    archived=False,
                    conceptState=m.get("conceptState")
                    or ("reviewing" if s.concept_ids(qid, db) else "unregistered"),
                )
                s.put("mistakes", m, db)
                added.append(qid)
                if public_question(s, q, db)["hasContent"]:
                    reviewable.append(qid)
                else:
                    unregistered += 1
        session = create_review(s, reviewable) if reviewable else None
        return {
            "added": len(added),
            "ambiguous": ambiguous,
            "missing": missing,
            "unregistered": unregistered,
            "reviewSessionId": session["id"] if session else None,
        }

    @app.get("/api/mistakes/{id}")
    def mistake_history(req: Request, id: str):
        s = S(req)
        with s.tx() as db:
            m = s.get("mistakes", id, db)
            attempts = [
                dict(r)
                for r in db.execute(
                    "SELECT result,at FROM attempts WHERE question_id=? ORDER BY at DESC",
                    (m["questionId"],),
                )
            ]
            return {"mistake": m, "attempts": attempts}

    @app.delete("/api/mistakes/{id}")
    def remove_mistake(req: Request, id: str):
        s = S(req)
        with s.tx() as db:
            m = s.get("mistakes", id, db)
            m["archived"] = True
            s.put("mistakes", m, db)
        return {"ok": True}

    @app.post("/api/solve")
    async def solve(req: Request):
        s = S(req)
        ids = (await req.json()).get("questionIds", [])
        if not isinstance(ids, list) or not 1 <= len(ids) <= 200:
            raise DomainError("1~200개의 문제를 선택해 주세요.")
        ids = list(dict.fromkeys(ids))
        with s.tx() as db:
            snapshots = []
            for id in ids:
                q = s.get("questions", id, db)
                validate_regions(s, q["materialId"], q["regions"], db)
                if not q.get("confirmed") or len(q.get("cropFiles", [])) != len(
                    q["regions"]
                ):
                    raise DomainError(
                        f"{q['number']}번의 저장된 영역을 콘텐츠 관리에서 먼저 확인해 주세요.",
                        409,
                    )
                if any(not s.local_file(f).is_file() for f in q["cropFiles"]):
                    raise DomainError(
                        "미리 저장된 원본 크롭이 없습니다. 사전 처리를 다시 실행해 주세요.",
                        409,
                    )
                snapshots.append(copy.deepcopy(q))
            session = {
                "id": new_id(),
                "questionIds": ids,
                "questionSnapshots": snapshots,
                "answers": {},
                "drawings": {},
                "status": "active",
                "createdAt": now(),
            }
            s.put("solve_sessions", session, db)
        return public_solve(s, session)

    @app.get("/api/solve/{id}")
    def get_solve(req: Request, id: str):
        s = S(req)
        session = s.get("solve_sessions", id)
        for q in session.get("questionSnapshots", []):
            validate_regions(s, q["materialId"], q["regions"])
        return public_solve(s, session)

    @app.get("/api/solve/{id}/answer-key/{qid}")
    def answer_key(req: Request, id: str, qid: str):
        session = S(req).get("solve_sessions", id)
        if qid not in session["questionIds"]:
            raise DomainError("이 풀이의 문제가 아닙니다.")
        q = next(
            (q for q in session.get("questionSnapshots", []) if q["id"] == qid), None
        ) or S(req).get("questions", qid)
        return {
            "available": bool(q.get("answer")),
            "answer": q.get("answer", ""),
            "explanation": q.get("explanation", ""),
        }

    @app.post("/api/solve/{id}/drawing")
    @app.post("/api/solve/{id}/answer")
    async def solve_result(req: Request, id: str):
        body = await req.json()
        s = S(req)
        qid = body.get("questionId")
        drawings = body.get("strokes", [])
        if (
            not isinstance(drawings, list)
            or len(drawings) > 1000
            or len(json.dumps(drawings)) > 2_000_000
        ):
            raise DomainError("필기 데이터가 너무 큽니다.")
        with s.tx() as db:
            session = s.get("solve_sessions", id, db)
            if qid not in session["questionIds"]:
                raise DomainError("이 풀이의 문제가 아닙니다.")
            is_answer = req.url.path.endswith("/answer")
            if qid in session["answers"]:
                return public_solve(s, session, db)
            session.setdefault("drawings", {})[qid] = drawings
            if is_answer:
                result = body.get("result")
                if result not in ["correct", "wrong", "skip"]:
                    raise DomainError("채점 결과를 확인해 주세요.")
                at = now()
                entry = {
                    "result": result,
                    "at": at,
                    "answerText": str(body.get("answerText", ""))[:10000],
                }
                session["answers"][qid] = entry
                db.execute(
                    "INSERT OR IGNORE INTO attempts VALUES(?,?,?,?,?)",
                    (id, qid, result, at, json.dumps(entry, ensure_ascii=False)),
                )
                for m in s.list("mistakes", db):
                    if m["questionId"] == qid and result != "skip":
                        m.update(next_review(m.get("streak", 0), result, at))
                        m.update(
                            lastResult=result,
                            reviewCount=m.get("reviewCount", 0) + 1,
                            correctCount=m.get("correctCount", 0)
                            + (result == "correct"),
                        )
                        s.put("mistakes", m, db)
                session["status"] = (
                    "complete"
                    if all(qid in session["answers"] for qid in session["questionIds"])
                    else "active"
                )
            s.put("solve_sessions", session, db)
        return public_solve(s, session)

    @app.post("/api/lessons")
    async def lesson(req: Request):
        return public_session(
            create_review(S(req), [(await req.json()).get("questionId")])
        )

    @app.get("/api/study/weak")
    def weak(req: Request):
        return {"count": len(weak_cards(S(req)))}

    @app.post("/api/study/repeat")
    def repeat(req: Request):
        return public_session(repeat_weak(S(req)))

    @app.post("/api/study")
    async def study(req: Request):
        return public_session(create_material_study(S(req), await req.json()))

    @app.get("/api/study/{id}")
    def get_study(req: Request, id: str):
        return public_session(S(req).get("study_sessions", id))

    @app.post("/api/study/{id}/answer")
    async def answer_study(req: Request, id: str):
        body = await req.json()
        return public_session(
            answer_session(
                S(req),
                id,
                body.get("itemId"),
                body.get("response", ""),
                body.get("memory"),
                body.get("selfGrade"),
            )
        )

    @app.post("/api/study/{id}/reveal")
    async def reveal(req: Request, id: str):
        session = S(req).get("study_sessions", id)
        body = await req.json()
        item = next(
            (i for i in session["items"] if i["id"] == body.get("itemId")), None
        )
        if not item:
            raise DomainError("학습 항목을 찾을 수 없습니다.", 404)
        if session["mode"] != "memory" and item["type"] != "서술형":
            raise DomainError("암기 또는 자기 채점 문항에서만 답을 펼칠 수 있습니다.")
        return {"answer": item["answer"], "explanation": item["explanation"]}

    @app.get("/api/content")
    def contents(req: Request):
        package = export_package(S(req))
        issues = content_check(S(req))
        return {
            **package,
            "materials": [
                public_material(m)
                for m in S(req).list("materials")
                if not m.get("archived")
            ],
            "issues": issues,
            "counts": issues["counts"],
        }

    @app.post("/api/content/validate")
    async def validate(req: Request):
        return validate_package(S(req), (await req.json()).get("package"))

    @app.post("/api/content/import")
    async def import_content(req: Request):
        return import_package(S(req), (await req.json()).get("package"))

    @app.post("/api/content/validate-file")
    @app.post("/api/content/import-file")
    async def content_file(req: Request, file: UploadFile = File(...)):
        data = await file.read(25 * 1024 * 1024 + 1)
        package = read_package_file(data)
        return (
            validate_package(S(req), package)
            if req.url.path.endswith("validate-file")
            else import_package(S(req), package)
        )

    @app.get("/api/content/check")
    def check(req: Request):
        return content_check(S(req))

    @app.get("/api/content/template")
    def template(req: Request):
        current = export_package(S(req))
        package = {
            **current,
            "concepts": [],
            "items": [],
            "mappings": [
                {k: m[k] for k in ["questionId", "materialId", "number", "page"]}
                | {"conceptIds": []}
                for m in current["mappings"]
            ],
        }
        return Response(
            json.dumps(package, ensure_ascii=False, indent=2),
            media_type="application/json",
            headers={
                "Content-Disposition": 'attachment; filename="re-content-template.json"'
            },
        )

    @app.get("/api/content/export")
    def export(req: Request, format: str = "json"):
        package = export_package(S(req))
        if format == "sqlite":
            return Response(
                sqlite_package_bytes(package),
                media_type="application/vnd.sqlite3",
                headers={
                    "Content-Disposition": 'attachment; filename="re-content.sqlite"'
                },
            )
        if format != "json":
            raise DomainError("JSON 또는 SQLite 형식을 선택해 주세요.")
        return Response(
            json.dumps(package, ensure_ascii=False, indent=2),
            media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="re-content.json"'},
        )

    @app.put("/api/concepts/{id}")
    @app.put("/api/bank-items/{id}")
    async def edit_content(req: Request, id: str):
        body = await req.json()
        if body.get("id") != id:
            raise DomainError("편집 대상 ID가 일치하지 않습니다.")
        key = "concepts" if "/concepts/" in req.url.path else "items"
        return import_package(S(req), {"schemaVersion": 1, key: [body]})

    @app.get("/api/{path:path}")
    @app.post("/api/{path:path}")
    def missing_api(path: str):
        raise DomainError("요청한 기능을 찾을 수 없습니다.", 404)

    dist = ROOT / "dist"
    if dist.is_dir():
        if (dist / "assets").is_dir():
            app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")
        if (dist / "fonts").is_dir():
            app.mount("/fonts", StaticFiles(directory=dist / "fonts"), name="fonts")
        if (dist / "pdfjs").is_dir():
            app.mount("/pdfjs", StaticFiles(directory=dist / "pdfjs"), name="pdfjs")

    @app.get("/")
    def index():
        if not (dist / "index.html").is_file():
            raise DomainError("화면 파일이 없습니다. start.bat로 실행해 주세요.", 503)
        return FileResponse(dist / "index.html")

    return app


app = create_app()
