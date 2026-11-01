import json
import pytest
from backend.store import Store, DomainError
from backend.content import validate_package, import_package, export_package


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path)
    s.put(
        "materials",
        {"id": "doc", "title": "내 교재", "subject": "수학", "pageCount": 2},
    )
    s.put_page(
        "doc",
        {"number": 1, "kind": "content", "width": 600, "height": 800, "text": "원본"},
    )
    s.put(
        "questions",
        {
            "id": "q47",
            "materialId": "doc",
            "number": 47,
            "page": 1,
            "regions": [{"page": 1, "x": 0.1, "y": 0.1, "w": 0.8, "h": 0.4}],
            "confirmed": True,
        },
    )
    return s


def content():
    return {
        "schemaVersion": 1,
        "concepts": [
            {
                "id": "bijection",
                "subject": "수학",
                "major": "함수",
                "minor": "함수의 종류",
                "name": "일대일대응",
                "definition": "일대일함수이면서 치역과 공역이 같은 함수",
                "properties": ["치역과 공역이 같다"],
                "misconceptions": [
                    {
                        "id": "injective-only",
                        "label": "일대일함수와 혼동",
                        "correction": "서로 다른 입력의 출력이 다른 조건만으로는 부족합니다.",
                    }
                ],
            }
        ],
        "items": [
            {
                "id": "check1",
                "conceptId": "bijection",
                "type": "객관식",
                "prompt": "일대일대응의 조건은?",
                "choices": [
                    "서로 다른 입력의 출력만 다름",
                    "일대일함수이며 치역과 공역이 같음",
                ],
                "answer": "일대일함수이며 치역과 공역이 같음",
                "explanation": "두 조건이 모두 필요합니다.",
                "choiceFeedback": {
                    "서로 다른 입력의 출력만 다름": {
                        "explanation": "그것은 일대일함수의 조건입니다. 치역과 공역도 같아야 합니다.",
                        "misconceptionTag": "injective-only",
                    }
                },
                "correction": "치역과 공역을 비교하세요.",
                "difficulty": "기본",
                "sources": [{"materialId": "doc", "page": 1}],
                "modes": ["quiz", "check"],
            }
        ],
        "mappings": [{"questionId": "q47", "conceptIds": ["bijection"]}],
    }


def test_atomic_import_and_edit_preserves_history(store):
    store.put("mistakes", {"id": "m", "questionId": "q47", "reviewCount": 4})
    package = content()
    assert validate_package(store, package)["valid"]
    import_package(store, package)
    package["concepts"][0]["definition"] = "검토 후 수정한 정의"
    import_package(store, package)
    assert store.get("mistakes", "m")["reviewCount"] == 4
    assert store.concept_ids("q47") == ["bijection"]
    bad = content()
    bad["items"][0]["conceptId"] = "missing"
    with pytest.raises(DomainError):
        import_package(store, bad)
    assert store.get("concepts", "bijection")["definition"] == "검토 후 수정한 정의"


def test_ambiguous_numbers_need_page_and_sources_are_checked(store):
    store.put(
        "questions",
        {
            "id": "q47-other",
            "materialId": "doc",
            "number": 47,
            "page": 2,
            "regions": [{"page": 2, "x": 0, "y": 0, "w": 1, "h": 1}],
        },
    )
    package = content()
    package["mappings"] = [
        {"materialId": "doc", "number": 47, "conceptIds": ["bijection"]}
    ]
    assert not validate_package(store, package)["valid"]
    package["mappings"][0]["page"] = 1
    assert validate_package(store, package)["valid"]
    package["items"][0]["sources"][0]["page"] = 999
    assert not validate_package(store, package)["valid"]


def test_export_reimport_has_stable_ids_and_does_not_contain_attempts(store):
    import_package(store, content())
    exported = export_package(store)
    assert exported["items"][0]["id"] == "check1"
    assert "attempts" not in exported
    assert validate_package(store, json.loads(json.dumps(exported)))["valid"]


def test_missing_content_is_never_inferred(store):
    assert store.concept_ids("q47") == []
    assert export_package(store)["concepts"] == []


def test_partial_concept_edit_validates_existing_mapping_subject(store):
    package = content()
    import_package(store, package)
    changed = {**package["concepts"][0], "subject": "영어"}
    result = validate_package(store, {"schemaVersion": 1, "concepts": [changed]})
    assert not result["valid"]
    assert any("과목" in error for error in result["errors"])


def test_content_ids_reject_path_separators(store):
    package = content()
    package["concepts"][0]["id"] = "bad/id"
    package["items"][0]["conceptId"] = "bad/id"
    package["mappings"][0]["conceptIds"] = ["bad/id"]
    assert not validate_package(store, package)["valid"]
