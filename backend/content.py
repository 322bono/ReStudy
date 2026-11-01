"""Validated, transactional import of human-authored learning content."""

from __future__ import annotations
import json
import re
import sqlite3
import tempfile
from pathlib import Path
from typing import Literal, Annotated
from pydantic import BaseModel, Field, ConfigDict, ValidationError
from .store import Store, DomainError


Identifier = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[\w-]+$")]


class Source(BaseModel):
    materialId: str = Field(min_length=1, max_length=100)
    page: int = Field(ge=1)


class Misconception(BaseModel):
    id: Identifier
    label: str
    correction: str


class Concept(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Identifier
    subject: str = Field(min_length=1, max_length=100)
    major: str = ""
    minor: str = ""
    name: str = Field(min_length=1, max_length=200)
    definition: str = Field(min_length=1, max_length=10000)
    properties: list[str] = Field(default_factory=list, max_length=100)
    misconceptions: list[Misconception] = Field(default_factory=list, max_length=100)
    sources: list[Source] = Field(default_factory=list, max_length=100)


class Feedback(BaseModel):
    explanation: str = ""
    misconceptionTag: str = ""


class BankItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Identifier
    conceptId: Identifier
    type: Literal[
        "객관식", "OX", "빈칸", "단답형", "서술형", "플래시카드", "문장 가리기"
    ]
    prompt: str = Field(min_length=1, max_length=20000)
    choices: list[str] = Field(default_factory=list, max_length=10)
    answer: str = Field(min_length=1, max_length=20000)
    acceptedAnswers: list[str] = Field(default_factory=list, max_length=100)
    explanation: str = Field(min_length=1, max_length=20000)
    choiceFeedback: dict[str, Feedback] = Field(default_factory=dict)
    correction: str = ""
    difficulty: Literal["기본", "보통", "심화"] = "보통"
    sources: list[Source] = Field(default_factory=list, max_length=100)
    modes: list[Literal["quiz", "memory", "check"]] = Field(
        default_factory=lambda: ["quiz", "check"], min_length=1, max_length=3
    )
    active: bool = True


class Mapping(BaseModel):
    questionId: str | None = None
    materialId: str | None = None
    number: int | None = Field(default=None, ge=1)
    page: int | None = Field(default=None, ge=1)
    conceptIds: list[Identifier] = Field(default_factory=list, max_length=100)
    answer: str | None = None
    explanation: str | None = None


class Package(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal[1] = 1
    concepts: list[Concept] = Field(default_factory=list, max_length=10000)
    items: list[BankItem] = Field(default_factory=list, max_length=50000)
    mappings: list[Mapping] = Field(default_factory=list, max_length=50000)
    materials: list[dict] = Field(default_factory=list, max_length=1000)


def resolve_mapping(store, mapping, db=None, questions=None):
    if mapping.get("questionId"):
        return store.get("questions", mapping["questionId"], db)
    matches = [
        q
        for q in (questions if questions is not None else store.list("questions", db))
        if q["materialId"] == mapping.get("materialId")
        and q["number"] == mapping.get("number")
        and (
            mapping.get("page") is None
            or q.get("page", q["regions"][0]["page"]) == mapping["page"]
        )
    ]
    if len(matches) != 1:
        raise DomainError(
            f"{mapping.get('number', '?')}번 매핑은 문제 ID 또는 정확한 자료·번호·페이지가 필요합니다."
        )
    return matches[0]


def validate_package(store: Store, raw, db=None):
    if db is None:
        with store.tx() as connection:
            return validate_package(store, raw, connection)
    errors, warnings = [], []
    try:
        package = Package.model_validate(raw).model_dump()
    except ValidationError as exc:
        return {
            "valid": False,
            "errors": [
                ".".join(str(p) for p in e["loc"]) + ": " + e["msg"]
                for e in exc.errors()
            ],
            "warnings": [],
            "counts": {},
        }
    concepts = {c["id"]: c for c in store.list("concepts", db)}
    concepts.update({c["id"]: c for c in package["concepts"]})
    materials = {m["id"]: m for m in store.list("materials", db)}
    pages_by_material = {
        mid: {p["number"]: p for p in store.pages(mid, db)} for mid in materials
    }
    questions = store.list("questions", db)
    for key in ["concepts", "items"]:
        ids = [i["id"] for i in package[key]]
        if len(ids) != len(set(ids)):
            errors.append(f"{key}: 중복된 ID가 있습니다.")

    def check_sources(sources, label):
        for source in sources:
            material = materials.get(source["materialId"])
            if not material:
                errors.append(
                    f"{label}: 출처 자료가 없습니다 ({source['materialId']})."
                )
                continue
            page = pages_by_material.get(source["materialId"], {}).get(source["page"])
            if not page or page["kind"] == "answers":
                errors.append(
                    f"{label}: 출처 {source['page']}쪽을 확인해 주세요. 정답·해설 페이지는 학습 출처로 사용할 수 없습니다."
                )

    for c in package["concepts"]:
        check_sources(c["sources"], c["name"])
        if not c["major"] or not c["minor"]:
            warnings.append(f"{c['name']}: 대단원 또는 소단원이 비어 있습니다.")
    for item in package["items"]:
        label = item["id"]
        if item["conceptId"] not in concepts:
            errors.append(f"{label}: 등록되지 않은 개념입니다.")
            continue
        check_sources(item["sources"], label)
        if item["type"] in ["객관식", "OX"]:
            if (
                len(set(item["choices"])) != len(item["choices"])
                or len(item["choices"]) < 2
                or item["answer"] not in item["choices"]
            ):
                errors.append(
                    f"{label}: 선택지·정답이 일치하지 않거나 선택지가 중복됩니다."
                )
            if item["type"] == "OX" and set(item["choices"]) != {"O", "X"}:
                errors.append(f"{label}: OX 선택지는 O, X여야 합니다.")
            for choice in item["choices"]:
                if (
                    choice != item["answer"]
                    and not item["choiceFeedback"].get(choice, {}).get("explanation")
                    and not item["correction"]
                ):
                    errors.append(
                        f"{label}: 오답 선택지 교정 설명이 필요합니다 ({choice})."
                    )
            if any(choice not in item["choices"] for choice in item["choiceFeedback"]):
                errors.append(f"{label}: 선택지에 없는 해설 키가 있습니다.")
        if not item["sources"] and not concepts[item["conceptId"]]["sources"]:
            warnings.append(
                f"{label}: 출처가 없어 자료 선택 학습에는 출제되지 않습니다."
            )
        declared = {m["id"] for m in concepts[item["conceptId"]]["misconceptions"]}
        for value in item["choiceFeedback"].values():
            if value["misconceptionTag"] and value["misconceptionTag"] not in declared:
                warnings.append(
                    f"{label}: 오개념 태그 {value['misconceptionTag']}가 개념 목록에 정의되지 않았습니다."
                )
    seen = set()
    merged_mappings = {q["id"]: store.concept_ids(q["id"], db) for q in questions}
    for mapping in package["mappings"]:
        try:
            q = resolve_mapping(store, mapping, db, questions)
            if q["id"] in seen:
                errors.append(f"{q['number']}번: 매핑이 중복됩니다.")
            seen.add(q["id"])
            merged_mappings[q["id"]] = mapping["conceptIds"]
            for cid in mapping["conceptIds"]:
                if cid not in concepts:
                    errors.append(f"{q['number']}번: 없는 개념 {cid}를 참조합니다.")
                elif concepts[cid]["subject"] != materials[q["materialId"]]["subject"]:
                    errors.append(f"{q['number']}번: 문제와 개념의 과목이 다릅니다.")
        except DomainError as exc:
            errors.append(exc.message)
    existing = {i["id"]: i for i in store.list("bank_items", db)}
    existing.update({i["id"]: i for i in package["items"]})
    by_id = {q["id"]: q for q in questions}
    for qid, cids in merged_mappings.items():
        q = by_id[qid]
        subject = materials[q["materialId"]]["subject"]
        for cid in cids:
            if cid not in concepts:
                errors.append(f"{q['number']}번: 연결된 개념 {cid}가 없습니다.")
            elif concepts[cid]["subject"] != subject:
                errors.append(
                    f"{q['number']}번: 기존 문제와 연결 개념의 과목이 다릅니다."
                )
    for item in existing.values():
        concept = concepts.get(item["conceptId"])
        if not concept:
            errors.append(f"{item['id']}: 연결된 개념이 없습니다.")
            continue
        for source in item.get("sources") or concept.get("sources", []):
            if (
                source["materialId"] in materials
                and materials[source["materialId"]]["subject"] != concept["subject"]
            ):
                errors.append(f"{item['id']}: 문항 출처와 개념의 과목이 다릅니다.")
    for c in package["concepts"]:
        count = sum(
            1
            for i in existing.values()
            if i["conceptId"] == c["id"] and i.get("active", True)
        )
        if count < 2:
            warnings.append(
                f"{c['name']}: 확인 문항이 {count}개입니다. 다른 문항으로 재확인하려면 2개 이상 준비하세요."
            )
    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "counts": {key: len(package[key]) for key in ["concepts", "items", "mappings"]},
    }


def import_package(store, raw):
    with store.tx() as db:
        result = validate_package(store, raw, db)
        if not result["valid"]:
            raise DomainError("콘텐츠 검사 실패: " + " / ".join(result["errors"][:5]))
        package = Package.model_validate(raw).model_dump()
        for c in package["concepts"]:
            store.put("concepts", c, db)
        for i in package["items"]:
            store.put("bank_items", i, db)
        questions = store.list("questions", db)
        for mapping in package["mappings"]:
            q = resolve_mapping(store, mapping, db, questions)
            previous_ids = store.concept_ids(q["id"], db)
            store.set_mapping(q["id"], mapping["conceptIds"], db)
            if set(previous_ids) != set(mapping["conceptIds"]):
                for mistake in store.list("mistakes", db):
                    if mistake["questionId"] == q["id"]:
                        mistake["conceptState"] = (
                            "reviewing" if mapping["conceptIds"] else "unregistered"
                        )
                        store.put("mistakes", mistake, db)
            for field in ["answer", "explanation"]:
                if mapping[field] is not None:
                    q[field] = mapping[field]
            store.put("questions", q, db)
    return {**result, "imported": True}


def export_package(store):
    with store.tx() as db:
        mappings = []
        for q in store.list("questions", db):
            ids = store.concept_ids(q["id"], db)
            mappings.append(
                {
                    "questionId": q["id"],
                    "materialId": q["materialId"],
                    "number": q["number"],
                    "page": q.get("page", q["regions"][0]["page"]),
                    "conceptIds": ids,
                    "answer": q.get("answer"),
                    "explanation": q.get("explanation"),
                }
            )
        return {
            "schemaVersion": 1,
            "concepts": store.list("concepts", db),
            "items": store.list("bank_items", db),
            "mappings": mappings,
            "materials": [
                {k: m.get(k) for k in ["id", "title", "hash"]}
                for m in store.list("materials", db)
            ],
        }


def content_check(store):
    package = export_package(store)
    result = validate_package(store, package)
    for q in store.list("questions"):
        if not store.concept_ids(q["id"]):
            result["warnings"].append(
                f"{q['number']}번 ({q.get('page', q['regions'][0]['page'])}쪽): 개념 미등록"
            )
        if not q.get("confirmed"):
            result["warnings"].append(f"{q['number']}번: 크롭 영역 확인 필요")
        if not q.get("cropFiles") or any(
            not store.local_file(f).is_file() for f in q.get("cropFiles", [])
        ):
            result["warnings"].append(
                f"{q['number']}번: 저장된 크롭 이미지가 없습니다."
            )
    return result


def sqlite_package_bytes(package):
    with tempfile.TemporaryDirectory() as temp:
        file = Path(temp) / "content.sqlite"
        db = sqlite3.connect(file)
        try:
            db.execute(
                "CREATE TABLE content_meta(schema_version INTEGER, materials TEXT)"
            )
            db.execute(
                "INSERT INTO content_meta VALUES(?,?)",
                (1, json.dumps(package.get("materials", []), ensure_ascii=False)),
            )
            for table, key in [
                ("concepts", "concepts"),
                ("bank_items", "items"),
                ("mappings", "mappings"),
            ]:
                db.execute(
                    f"CREATE TABLE {table}(id TEXT PRIMARY KEY,data TEXT NOT NULL)"
                )
                db.executemany(
                    f"INSERT INTO {table} VALUES(?,?)",
                    [
                        (
                            row.get("id") or row.get("questionId") or str(n),
                            json.dumps(row, ensure_ascii=False),
                        )
                        for n, row in enumerate(package[key])
                    ],
                )
            db.commit()
        finally:
            db.close()
        return file.read_bytes()


def read_package_file(data: bytes):
    if len(data) > 25 * 1024 * 1024:
        raise DomainError("콘텐츠 파일은 25MB 이하로 올려 주세요.")
    if data.startswith(b"SQLite format 3\x00"):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "import.sqlite"
            file.write_bytes(data)
            try:
                db = sqlite3.connect(file.as_uri() + "?mode=ro", uri=True)
                db.enable_load_extension(False)
                try:
                    version, materials = db.execute(
                        "SELECT schema_version,materials FROM content_meta LIMIT 1"
                    ).fetchone()
                    result = {
                        "schemaVersion": version,
                        "materials": json.loads(materials),
                    }
                    for table, key in [
                        ("concepts", "concepts"),
                        ("bank_items", "items"),
                        ("mappings", "mappings"),
                    ]:
                        result[key] = [
                            json.loads(r[0])
                            for r in db.execute(f"SELECT data FROM {table} LIMIT 50001")
                        ]
                    return result
                finally:
                    db.close()
            except (sqlite3.Error, ValueError, TypeError):
                raise DomainError("이 앱에서 내보낸 콘텐츠 SQLite 형식이 아닙니다.")
    try:
        return json.loads(data.decode("utf-8-sig"))
    except (ValueError, UnicodeError):
        raise DomainError("올바른 UTF-8 JSON 또는 콘텐츠 SQLite 파일을 선택해 주세요.")
