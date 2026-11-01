from backend.learning import create_review, answer_session, create_material_study
from backend.store import DomainError
from backend.tests.test_content import store, content
from backend.content import import_package
import pytest


def prepared(store):
    package = content()
    second = {
        **package["items"][0],
        "id": "check2",
        "type": "OX",
        "prompt": "일대일함수이면 항상 일대일대응이다.",
        "choices": ["O", "X"],
        "answer": "X",
        "choiceFeedback": {
            "O": {
                "explanation": "공역과 치역의 일치도 필요합니다.",
                "misconceptionTag": "injective-only",
            }
        },
    }
    package["items"].append(second)
    import_package(store, package)


def test_correction_uses_prepared_choice_and_rechecks_another_item(store):
    prepared(store)
    session = create_review(store, ["q47"])
    first = session["items"][0]
    # Choose the deliberately wrong stored option; this tests the actual bank, not a mock.
    wrong = next(c for c in first["choices"] if c != first["answer"])
    session = answer_session(store, session["id"], first["id"], wrong)
    answered = next(i for i in session["items"] if i["id"] == first["id"])
    assert answered["result"] == "wrong"
    assert answered["feedback"] == first["choiceFeedback"][wrong]["explanation"]
    assert answered["misconceptionTag"] == "injective-only"
    assert any(
        i["bankItemId"] != first["bankItemId"] and not i.get("result")
        for i in session["items"]
    )
    for _ in range(12):
        pending = next((i for i in session["items"] if not i.get("result")), None)
        if not pending:
            break
        session = answer_session(store, session["id"], pending["id"], pending["answer"])
    assert session["status"] == "complete"
    assert "bijection" in session["understoodConceptIds"]
    assert session["originQuestionIds"] == ["q47"]


def test_unmapped_problem_cannot_start_concept_learning(store):
    with pytest.raises(DomainError, match="개념 미등록"):
        create_review(store, ["q47"])


def test_material_study_does_not_use_unselected_sources(store):
    prepared(store)
    session = create_material_study(
        store,
        {
            "materials": [{"id": "doc", "pages": "1"}],
            "mode": "quiz",
            "type": "객관식",
            "count": 5,
            "difficulty": "기본",
        },
    )
    assert len(session["items"]) == 1
    with pytest.raises(DomainError):
        create_material_study(
            store,
            {
                "materials": [{"id": "doc", "pages": "2"}],
                "mode": "quiz",
                "type": "객관식",
                "count": 5,
                "difficulty": "기본",
            },
        )


def test_editing_bank_does_not_change_active_session_answers(store):
    prepared(store)
    session = create_review(store, ["q47"])
    first = session["items"][0]
    bank = store.get("bank_items", first["bankItemId"])
    bank["answer"] = "수정된 답"
    store.put("bank_items", bank)
    saved = store.get("study_sessions", session["id"])
    assert saved["items"][0]["answer"] == first["answer"]


def test_free_response_requires_self_grading_and_duplicate_submit_is_idempotent(store):
    package = content()
    item = package["items"][0]
    item.update(
        type="서술형", choices=[], choiceFeedback={}, prompt="일대일대응을 설명하세요."
    )
    import_package(store, package)
    session = create_review(store, ["q47"])
    first = session["items"][0]
    session = answer_session(store, session["id"], first["id"], "나의 설명")
    assert not session["items"][0].get("result")
    assert session["items"][0]["requiresSelfGrade"]
    session = answer_session(
        store, session["id"], first["id"], "나의 설명", self_grade="correct"
    )
    answer_session(store, session["id"], first["id"], "다른 설명", self_grade="wrong")
    assert store.get("study_sessions", session["id"])["items"][0]["result"] == "correct"
