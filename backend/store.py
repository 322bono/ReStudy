"""Local persistence. Content edits never replace historical session snapshots."""

from __future__ import annotations
import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

TABLES = {
    "materials",
    "questions",
    "mistakes",
    "solve_sessions",
    "study_sessions",
    "concepts",
    "bank_items",
    "concept_memory",
    "legacy_concept_reviews",
}


class DomainError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message, self.status = message, status


def now():
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def new_id():
    return str(uuid.uuid4())


class Store:
    def __init__(self, root: Path | str | None = None, migrate=True):
        self.root = Path(
            root
            or os.environ.get("RE_DATA_DIR")
            or Path(__file__).resolve().parents[1] / "data"
        ).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "re-local.sqlite"
        with self.tx() as db:
            for table in sorted(TABLES):
                db.execute(
                    f"CREATE TABLE IF NOT EXISTS {table}(id TEXT PRIMARY KEY,data TEXT NOT NULL)"
                )
            db.executescript("""
                CREATE TABLE IF NOT EXISTS pages(material_id TEXT,number INTEGER,data TEXT NOT NULL,PRIMARY KEY(material_id,number));
                CREATE TABLE IF NOT EXISTS question_concepts(question_id TEXT,concept_id TEXT,PRIMARY KEY(question_id,concept_id));
                CREATE INDEX IF NOT EXISTS concept_questions ON question_concepts(concept_id);
                CREATE TABLE IF NOT EXISTS attempts(session_id TEXT,question_id TEXT,result TEXT,at TEXT,data TEXT NOT NULL,PRIMARY KEY(session_id,question_id));
                CREATE TABLE IF NOT EXISTS concept_attempts(session_id TEXT,item_id TEXT,bank_item_id TEXT,concept_id TEXT,result TEXT,at TEXT,misconception_tag TEXT,PRIMARY KEY(session_id,item_id));
                CREATE INDEX IF NOT EXISTS concept_history ON concept_attempts(concept_id,at);
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,data TEXT NOT NULL);
            """)
        if migrate:
            self.migrate_legacy()

    @contextmanager
    def tx(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=30000")
        db.execute("BEGIN IMMEDIATE")
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def get(self, table, id, db=None, required=True):
        if table not in TABLES:
            raise ValueError("Invalid table")
        if db is None:
            with self.tx() as connection:
                return self.get(table, id, connection, required)
        row = db.execute(f"SELECT data FROM {table} WHERE id=?", (id,)).fetchone()
        if row:
            return json.loads(row["data"])
        if required:
            raise DomainError("자료 또는 학습 기록을 찾을 수 없습니다.", 404)
        return None

    def list(self, table, db=None):
        if table not in TABLES:
            raise ValueError("Invalid table")
        if db is None:
            with self.tx() as connection:
                return self.list(table, connection)
        return [
            json.loads(row[0])
            for row in db.execute(f"SELECT data FROM {table} ORDER BY rowid DESC")
        ]

    def put(self, table, value, db=None):
        if table not in TABLES:
            raise ValueError("Invalid table")
        if db is None:
            with self.tx() as connection:
                return self.put(table, value, connection)
        db.execute(
            f"INSERT INTO {table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            (value["id"], json.dumps(value, ensure_ascii=False, allow_nan=False)),
        )
        return value

    def put_page(self, material_id, page, db=None):
        if db is None:
            with self.tx() as connection:
                return self.put_page(material_id, page, connection)
        db.execute(
            "INSERT OR REPLACE INTO pages VALUES(?,?,?)",
            (
                material_id,
                page["number"],
                json.dumps(page, ensure_ascii=False, allow_nan=False),
            ),
        )

    def pages(self, material_id, db=None):
        if db is None:
            with self.tx() as connection:
                return self.pages(material_id, connection)
        return [
            json.loads(r[0])
            for r in db.execute(
                "SELECT data FROM pages WHERE material_id=? ORDER BY number",
                (material_id,),
            )
        ]

    def concept_ids(self, question_id, db=None):
        if db is None:
            with self.tx() as connection:
                return self.concept_ids(question_id, connection)
        return [
            r[0]
            for r in db.execute(
                "SELECT concept_id FROM question_concepts WHERE question_id=? ORDER BY concept_id",
                (question_id,),
            )
        ]

    def set_mapping(self, question_id, ids, db):
        self.get("questions", question_id, db)
        db.execute("DELETE FROM question_concepts WHERE question_id=?", (question_id,))
        db.executemany(
            "INSERT INTO question_concepts VALUES(?,?)",
            [(question_id, c) for c in sorted(set(ids))],
        )

    def meta(self, key, default=None, db=None):
        if db is None:
            with self.tx() as connection:
                return self.meta(key, default, connection)
        row = db.execute("SELECT data FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_meta(self, key, value, db):
        db.execute(
            "INSERT OR REPLACE INTO meta VALUES(?,?)",
            (key, json.dumps(value, ensure_ascii=False)),
        )

    def local_file(self, path):
        resolved = Path(path).resolve()
        if not resolved.is_relative_to(self.root):
            raise DomainError("허용되지 않은 파일 경로입니다.", 403)
        return resolved

    def migrate_legacy(self):
        legacy = self.root / "restudy.sqlite"
        if self.meta("legacy_migration") is not None or not legacy.exists():
            return
        old = sqlite3.connect(legacy.as_uri() + "?mode=ro", uri=True)
        try:
            names = {
                r[0]
                for r in old.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            backup = self.root / "backups" / "restudy-before-local.sqlite"
            backup.parent.mkdir(exist_ok=True)
            if not backup.exists():
                target = sqlite3.connect(backup)
                try:
                    old.backup(target)
                finally:
                    target.close()
            counts = {}
            with self.tx() as db:
                for table in [
                    "materials",
                    "questions",
                    "mistakes",
                    "solve_sessions",
                    "study_sessions",
                    "concept_reviews",
                ]:
                    if table not in names:
                        continue
                    destination = (
                        "legacy_concept_reviews"
                        if table == "concept_reviews"
                        else table
                    )
                    count = 0
                    for id, raw in old.execute(f"SELECT id,data FROM {table}"):
                        value = json.loads(raw)
                        if self.get(destination, id, db, False) is not None:
                            continue
                        if table == "materials":
                            value.update(
                                legacySource=True,
                                status="uploaded",
                                progress=0,
                                sourceFile=str(self.root / "files" / id),
                            )
                        elif table == "questions":
                            value.update(
                                page=value.get("page")
                                or value.get("regions", [{"page": 1}])[0]["page"],
                                conceptIds=[],
                                cropFiles=[],
                            )
                            value.pop("source", None)
                            value["source"] = (
                                "manual" if value.get("confirmed") else "text"
                            )
                        elif table == "mistakes":
                            value.setdefault("correctCount", 0)
                        elif table == "study_sessions":
                            value.update(legacy=True, status="archived")
                        self.put(destination, value, db)
                        count += 1
                    counts[table] = count
                if "pages" in names:
                    for mid, number, raw in old.execute(
                        "SELECT material_id,number,data FROM pages"
                    ):
                        self.put_page(mid, json.loads(raw), db)
                if "attempts" in names:
                    for sid, qid, result, at in old.execute(
                        "SELECT session_id,question_id,result,at FROM attempts"
                    ):
                        db.execute(
                            "INSERT OR IGNORE INTO attempts VALUES(?,?,?,?,?)",
                            (
                                sid,
                                qid,
                                result,
                                at,
                                json.dumps({"result": result, "at": at}),
                            ),
                        )
                    for mistake in self.list("mistakes", db):
                        mistake["correctCount"] = db.execute(
                            "SELECT count(*) FROM attempts WHERE question_id=? AND result='correct'",
                            (mistake["questionId"],),
                        ).fetchone()[0]
                        self.put("mistakes", mistake, db)
                self.set_meta(
                    "legacy_migration",
                    {
                        "at": now(),
                        "counts": counts,
                        "backup": str(backup),
                        "note": "원본 자료와 학습 이력을 보존했습니다. 기존 학습 세션은 이력으로 보관합니다.",
                    },
                    db,
                )
        finally:
            old.close()
