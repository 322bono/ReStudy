import hashlib
import json
import sqlite3
from backend.store import Store


def test_legacy_migration_is_repeatable_and_keeps_original_history(tmp_path):
    legacy = tmp_path / "restudy.sqlite"
    db = sqlite3.connect(legacy)
    for table in [
        "materials",
        "questions",
        "mistakes",
        "solve_sessions",
        "study_sessions",
        "concept_reviews",
    ]:
        db.execute(f"CREATE TABLE {table}(id TEXT PRIMARY KEY,data TEXT NOT NULL)")
    db.execute("CREATE TABLE pages(material_id TEXT,number INTEGER,data TEXT)")
    db.execute(
        "CREATE TABLE attempts(session_id TEXT,question_id TEXT,result TEXT,at TEXT)"
    )
    records = {
        "materials": {
            "id": "doc",
            "title": "내 자료",
            "subject": "수학",
            "mime": "application/pdf",
            "status": "ready",
        },
        "questions": {
            "id": "q",
            "materialId": "doc",
            "number": 47,
            "regions": [{"page": 1, "x": 0, "y": 0, "w": 1, "h": 1}],
            "confirmed": True,
        },
        "mistakes": {
            "id": "m",
            "questionId": "q",
            "reviewCount": 3,
            "dueAt": "2026-11-03T00:00:00Z",
        },
        "solve_sessions": {
            "id": "s",
            "questionIds": ["q"],
            "answers": {"q": {"result": "correct", "at": "2026-10-30T00:00:00Z"}},
            "drawings": {"q": [{"points": [{"x": 0.1, "y": 0.1}]}]},
            "status": "complete",
        },
    }
    for table, value in records.items():
        db.execute(f"INSERT INTO {table} VALUES(?,?)", (value["id"], json.dumps(value)))
    db.execute(
        "INSERT INTO pages VALUES(?,?,?)",
        ("doc", 1, json.dumps({"number": 1, "kind": "content"})),
    )
    db.execute(
        "INSERT INTO attempts VALUES(?,?,?,?)",
        ("s", "q", "correct", "2026-10-30T00:00:00Z"),
    )
    db.commit()
    db.close()
    digest = hashlib.sha256(legacy.read_bytes()).digest()
    s = Store(tmp_path)
    assert s.get("mistakes", "m")["reviewCount"] == 3
    assert s.get("mistakes", "m")["dueAt"] == "2026-11-03T00:00:00Z"
    assert (
        s.get("solve_sessions", "s")["drawings"]
        == records["solve_sessions"]["drawings"]
    )
    assert s.concept_ids("q") == []
    assert (tmp_path / "backups/restudy-before-local.sqlite").is_file()
    assert hashlib.sha256(legacy.read_bytes()).digest() == digest
    again = Store(tmp_path)
    assert len(again.list("mistakes")) == 1
    with again.tx() as db:
        assert db.execute("SELECT count(*) FROM attempts").fetchone()[0] == 1
