"""Deterministic selection and marking of pre-authored content. No inference."""

from __future__ import annotations
import copy
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from .store import Store, DomainError, new_id, now


def parse_numbers(value, limit=200):
    if not isinstance(value, str) or len(value) > 4000:
        raise DomainError("번호 입력을 확인해 주세요.")
    result = []
    for token in re.split(r"[\s,，、]+", value.strip()):
        match = re.fullmatch(r"(\d{1,5})(?:[-~–](\d{1,5}))?", token)
        if not match:
            raise DomainError(f"번호를 확인해 주세요: {token}")
        start = int(match[1])
        end = int(match[2] or start)
        if start < 1 or end < start or end - start >= limit:
            raise DomainError(f"한 번에 {limit}개 이하의 번호를 입력해 주세요.")
        result.extend(range(start, end + 1))
        if len(result) > limit:
            raise DomainError(f"한 번에 {limit}개 이하의 번호를 입력해 주세요.")
    return list(dict.fromkeys(result))


def normalize(value):
    # Case and mathematical signs remain meaningful; accepted variants are authored explicitly.
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value.strip()))


def next_review(streak, result, at=None):
    date = datetime.fromisoformat((at or now()).replace("Z", "+00:00"))
    days = (
        1
        if result == "wrong"
        else 0
        if result == "skip"
        else [1, 3, 7, 14][min(streak, 3)]
    )
    return {
        "streak": 0
        if result == "wrong"
        else streak + 1
        if result == "correct"
        else streak,
        "dueAt": (date + timedelta(days=days)).isoformat().replace("+00:00", "Z"),
    }


def concept_statistics(store, db=None):
    if db is None:
        with store.tx() as connection:
            return concept_statistics(store, connection)
    return {
        r["concept_id"]: {
            "total": r["n"],
            "wrong": r["wrong"],
            "accuracy": round(100 * (r["n"] - r["wrong"]) / r["n"]),
        }
        for r in db.execute(
            "SELECT concept_id,count(*) n,sum(CASE WHEN result='wrong' THEN 1 ELSE 0 END) wrong FROM concept_attempts GROUP BY concept_id"
        )
    }


def _pool(store, cids, mode, db):
    allowed = {"check", "quiz"} if mode == "review" else {mode}
    return [
        i
        for i in store.list("bank_items", db)
        if i.get("active", True)
        and i["conceptId"] in cids
        and allowed.intersection(i.get("modes", []))
    ]


def _select(store, pool, cids, count, db, exclude=None):
    excluded = set(exclude or [])
    stats = concept_statistics(store, db)
    history = {
        r["bank_item_id"]: (r["n"], r["last_correct"] or "")
        for r in db.execute(
            "SELECT bank_item_id,count(*) n,max(CASE WHEN result='correct' THEN at ELSE NULL END) last_correct FROM concept_attempts GROUP BY bank_item_id"
        )
    }

    def concept_key(cid):
        stat = stats.get(cid, {"total": 0, "wrong": 0})
        return (-stat["wrong"] / max(1, stat["total"]), stat["total"], cid)

    def item_key(item):
        attempts, last = history.get(item["id"], (0, ""))
        return (item["id"] in excluded, attempts > 0, attempts, last, item["id"])

    ordered = sorted(pool, key=item_key)
    selected = []
    for cid in sorted(cids, key=concept_key):
        candidate = next(
            (i for i in ordered if i["conceptId"] == cid and i["id"] not in excluded),
            None,
        )
        if candidate:
            selected.append(candidate)
        if len(selected) >= count:
            return selected
    selected_ids = {i["id"] for i in selected}
    for item in sorted(
        ordered, key=lambda i: (concept_key(i["conceptId"]), item_key(i))
    ):
        if item["id"] not in excluded | selected_ids:
            selected.append(item)
            selected_ids.add(item["id"])
        if len(selected) >= count:
            break
    return selected


def _snapshot(store, item, db):
    concept = store.get("concepts", item["conceptId"], db)
    return {
        **copy.deepcopy(item),
        "bankItemId": item["id"],
        "id": new_id(),
        "concept": concept["name"],
        "conceptDefinition": concept["definition"],
        "conceptProperties": concept.get("properties", []),
        "misconceptionLabels": {
            m["id"]: m["label"] for m in concept.get("misconceptions", [])
        },
        "sources": item.get("sources") or concept.get("sources", []),
    }


def create_review(store: Store, question_ids: list[str]):
    with store.tx() as db:
        cids = []
        for qid in question_ids:
            q = store.get("questions", qid, db)
            mapped = store.concept_ids(qid, db)
            if not mapped:
                raise DomainError(
                    f"{q['number']}번: 개념 미등록입니다. 콘텐츠 관리에서 매핑을 가져와 주세요.",
                    409,
                )
            cids.extend(mapped)
        cids = list(dict.fromkeys(cids))
        pool = _pool(store, cids, "review", db)
        missing = [cid for cid in cids if not any(i["conceptId"] == cid for i in pool)]
        if missing:
            raise DomainError(
                "복습 문항 미등록: "
                + ", ".join(store.get("concepts", c, db)["name"] for c in missing),
                409,
            )
        chosen = _select(store, pool, cids, 5, db)
        covered = {i["conceptId"] for i in chosen}
        session = {
            "id": new_id(),
            "mode": "check",
            "label": "개념 복습",
            "originQuestionIds": list(dict.fromkeys(question_ids)),
            "conceptIds": cids,
            "understoodConceptIds": [],
            "remainingConceptIds": [cid for cid in cids if cid not in covered],
            "items": [_snapshot(store, i, db) for i in chosen],
            "materialIds": list(
                dict.fromkeys(
                    store.get("questions", q, db)["materialId"] for q in question_ids
                )
            ),
            "status": "active",
            "createdAt": now(),
            "rechecks": {},
            "notice": "",
        }
        return store.put("study_sessions", session, db)


def create_material_study(store, input):
    if input.get("mode") not in ["quiz", "memory", "check"]:
        raise DomainError("학습 방식을 확인해 주세요.")
    if not 1 <= input.get("count", 0) <= 20:
        raise DomainError("문제 수는 1~20개로 선택해 주세요.")
    with store.tx() as db:
        allowed = set()
        subjects = set()
        mids = []
        for choice in input.get("materials", []):
            m = store.get("materials", choice["id"], db)
            if m.get("archived"):
                raise DomainError("보관된 자료는 새 학습에서 선택할 수 없습니다.")
            subjects.add(m["subject"])
            mids.append(m["id"])
            pages = [
                p["number"] for p in store.pages(m["id"], db) if p["kind"] != "answers"
            ]
            selected = (
                parse_numbers(choice["pages"], 500)
                if choice.get("pages", "").strip()
                else pages
            )
            if not set(selected).issubset(pages):
                raise DomainError(f"{m['title']}: 출처 페이지 범위를 확인해 주세요.")
            allowed.update((m["id"], n) for n in selected)
        if len(subjects) != 1:
            raise DomainError("한 과목의 자료를 선택해 주세요.")
        concepts = {c["id"]: c for c in store.list("concepts", db)}
        pool = []
        for item in store.list("bank_items", db):
            if concepts.get(item["conceptId"], {}).get("subject") not in subjects:
                continue
            if not item.get("active", True) or input["mode"] not in item["modes"]:
                continue
            if input["mode"] == "quiz" and item["type"] != input["type"]:
                continue
            if item["difficulty"] != input.get("difficulty", "보통"):
                continue
            sources = item.get("sources") or concepts.get(item["conceptId"], {}).get(
                "sources", []
            )
            if sources and all(
                (s["materialId"], s["page"]) in allowed for s in sources
            ):
                pool.append(item)
        if not pool:
            raise DomainError(
                "선택한 자료·페이지·유형에 연결된 사전 문항이 없습니다. 콘텐츠 관리에서 등록해 주세요.",
                409,
            )
        cids = list(dict.fromkeys(i["conceptId"] for i in pool))
        chosen = _select(store, pool, cids, input["count"], db)
        session = {
            "id": new_id(),
            "mode": input["mode"],
            "label": {"quiz": "문제 풀기", "memory": "암기하기", "check": "개념 확인"}[
                input["mode"]
            ],
            "originQuestionIds": [],
            "conceptIds": cids,
            "understoodConceptIds": [],
            "items": [_snapshot(store, i, db) for i in chosen],
            "materialIds": list(dict.fromkeys(mids)),
            "status": "active",
            "createdAt": now(),
            "notice": f"등록된 문항 {len(chosen)}개로 시작합니다."
            if len(chosen) < input["count"]
            else "",
        }
        return store.put("study_sessions", session, db)


def _update_review_queue(store, session, item, db):
    cid = item["conceptId"]
    understood = set(session.get("understoodConceptIds", []))
    if item["result"] == "correct":
        understood.add(cid)
    else:
        understood.discard(cid)
        counts = session.setdefault("rechecks", {})
        counts[cid] = counts.get(cid, 0) + 1
        pending = any(
            i["conceptId"] == cid
            and i["id"] != item["id"]
            and not i.get("result")
            and i["bankItemId"] != item["bankItemId"]
            for i in session["items"]
        )
        if not pending and counts[cid] <= 3:
            pool = _pool(store, [cid], "review", db)
            used = {i["bankItemId"] for i in session["items"]}
            chosen = _select(store, pool, [cid], 1, db, used)
            if not chosen:
                chosen = _select(
                    store,
                    [i for i in pool if i["id"] != item["bankItemId"]],
                    [cid],
                    1,
                    db,
                )
            if not chosen:
                chosen = _select(store, pool, [cid], 1, db)
            if chosen:
                extra = _snapshot(store, chosen[0], db)
                if chosen[0]["id"] == item["bankItemId"]:
                    extra["repeatReason"] = (
                        "다른 확인 문항이 없어 같은 문제로 재확인합니다."
                    )
                session["items"].append(extra)
    session["understoodConceptIds"] = sorted(understood)
    if all(i.get("result") for i in session["items"]) and session.get(
        "remainingConceptIds"
    ):
        remaining = session["remainingConceptIds"]
        pool = _pool(store, remaining, "review", db)
        chosen = _select(store, pool, remaining, 5, db)
        session["items"].extend(_snapshot(store, i, db) for i in chosen)
        covered = {i["conceptId"] for i in chosen}
        session["remainingConceptIds"] = [c for c in remaining if c not in covered]
        if not chosen:
            session["notice"] = (
                "남은 개념에 사용할 문항이 없습니다. 콘텐츠를 확인해 주세요."
            )
            session["remainingConceptIds"] = []


def answer_session(
    store, session_id, item_id, response="", memory=None, self_grade=None
):
    with store.tx() as db:
        session = store.get("study_sessions", session_id, db)
        item = next((i for i in session["items"] if i["id"] == item_id), None)
        if not item:
            raise DomainError("학습 항목을 찾을 수 없습니다.", 404)
        if item.get("result") or item.get("memory"):
            return session
        if session["mode"] == "memory":
            if memory not in ["known", "unsure", "unknown"]:
                raise DomainError("암기 상태를 선택해 주세요.")
            item["memory"] = memory
        else:
            if not isinstance(response, str) or len(response) > 20000:
                raise DomainError("답변을 확인해 주세요.")
            if item["type"] == "서술형":
                item["response"] = response or item.get("response", "")
                item["requiresSelfGrade"] = True
                item["responseSubmitted"] = True
                if self_grade is None:
                    store.put("study_sessions", session, db)
                    return session
                if self_grade not in ["correct", "wrong"]:
                    raise DomainError("자기 채점 결과를 선택해 주세요.")
                result = self_grade
            elif item["type"] in ["객관식", "OX"]:
                if response not in item["choices"]:
                    raise DomainError("선택지에서 답을 선택해 주세요.")
                result = "correct" if response == item["answer"] else "wrong"
            else:
                if not response.strip():
                    raise DomainError("답변을 입력해 주세요.")
                accepted = [item["answer"], *item.get("acceptedAnswers", [])]
                result = (
                    "correct"
                    if normalize(response) in {normalize(a) for a in accepted}
                    else "wrong"
                )
            item.update(
                result=result,
                response=item.get("response") or response,
                answeredAt=now(),
            )
            selected_feedback = (
                item.get("choiceFeedback", {}).get(response, {})
                if result == "wrong"
                else {}
            )
            item["feedback"] = (
                selected_feedback.get("explanation")
                or (item.get("correction") if result == "wrong" else "")
                or item["explanation"]
            )
            item["misconceptionTag"] = selected_feedback.get("misconceptionTag", "")
            item["misconceptionLabel"] = item.get("misconceptionLabels", {}).get(
                item["misconceptionTag"], ""
            )
            db.execute(
                "INSERT OR IGNORE INTO concept_attempts VALUES(?,?,?,?,?,?,?)",
                (
                    session_id,
                    item_id,
                    item["bankItemId"],
                    item["conceptId"],
                    result,
                    item["answeredAt"],
                    item["misconceptionTag"],
                ),
            )
            if session.get("originQuestionIds"):
                _update_review_queue(store, session, item, db)
            else:
                understood = set(session.get("understoodConceptIds", []))
                if result == "correct":
                    understood.add(item["conceptId"])
                else:
                    understood.discard(item["conceptId"])
                session["understoodConceptIds"] = sorted(understood)
        weak = memory in ["unsure", "unknown"] or item.get("result") == "wrong"
        store.put(
            "concept_memory",
            {
                "id": item["bankItemId"],
                "bankItemId": item["bankItemId"],
                "conceptId": item["conceptId"],
                "memory": memory or ("unknown" if weak else "known"),
                "updatedAt": now(),
            },
            db,
        )
        session["status"] = (
            "complete"
            if all(
                i.get("memory") if session["mode"] == "memory" else i.get("result")
                for i in session["items"]
            )
            and not session.get("remainingConceptIds")
            else "active"
        )
        if session["status"] == "complete" and session.get("originQuestionIds"):
            understood = set(session.get("understoodConceptIds", []))
            session["mastered"] = set(session["conceptIds"]).issubset(understood)
            if not session["mastered"]:
                session["notice"] = (
                    "복습은 마쳤지만 이해가 확인되지 않은 개념이 있습니다. 오답 노트에서 다시 복습할 수 있습니다."
                )
            for mistake in store.list("mistakes", db):
                if mistake["questionId"] in session["originQuestionIds"]:
                    ids = store.concept_ids(mistake["questionId"], db)
                    mistake["conceptState"] = (
                        "understood"
                        if ids and set(ids).issubset(understood)
                        else "reviewing"
                    )
                    store.put("mistakes", mistake, db)
        return store.put("study_sessions", session, db)


def public_session(session):
    result = copy.deepcopy(session)
    for item in result["items"]:
        reveal = (
            item.get("result") or item.get("memory") or item.get("responseSubmitted")
        )
        if not reveal:
            for key in [
                "answer",
                "explanation",
                "choiceFeedback",
                "correction",
                "acceptedAnswers",
            ]:
                item.pop(key, None)
        item.pop("active", None)
    return result


def weak_cards(store, db=None):
    banks = {i["id"]: i for i in store.list("bank_items", db) if i.get("active", True)}
    return [
        banks[m["bankItemId"]]
        for m in store.list("concept_memory", db)
        if m.get("memory") != "known" and m.get("bankItemId") in banks
    ]


def repeat_weak(store):
    with store.tx() as db:
        cards = weak_cards(store, db)
        if not cards:
            raise DomainError("다시 볼 개념이 없습니다.")
        items = [_snapshot(store, i, db) for i in cards[:30]]
        session = {
            "id": new_id(),
            "mode": "memory",
            "label": "다시 볼 개념",
            "originQuestionIds": [],
            "conceptIds": list({i["conceptId"] for i in cards}),
            "understoodConceptIds": [],
            "items": items,
            "materialIds": list({s["materialId"] for i in items for s in i["sources"]}),
            "createdAt": now(),
            "status": "active",
        }
        return store.put("study_sessions", session, db)
