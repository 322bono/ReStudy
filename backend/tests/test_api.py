import copy
import json
import hashlib
from pathlib import Path
import pymupdf
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app
from backend.tests.test_content import content


def pdf_bytes():
    doc = pymupdf.open()
    page = doc.new_page(width=600, height=800)
    page.insert_text((45, 65), "47. Solve x + 2 = 5.", fontsize=14)
    page.insert_text((45, 110), "A. 1   B. 2   C. 3", fontsize=13)
    page.draw_rect((50, 130, 200, 200))
    page.insert_text((45, 350), "48. Read the graph.", fontsize=14)
    page.draw_rect((55, 390, 220, 490))
    ans = doc.new_page(width=600, height=800)
    ans.insert_text((45, 65), "Answer key", fontsize=18)
    ans.insert_text((45, 100), "47. C   48. B")
    raw = doc.tobytes()
    doc.close()
    return raw


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path, synchronous_processing=True)) as c:
        yield c


def upload(client):
    response = client.post(
        "/api/materials",
        data={"subject": "수학", "kind": "문제집"},
        files=[("files", ("교재.pdf", pdf_bytes(), "application/pdf"))],
    )
    assert response.status_code == 202, response.text
    material = response.json()["materials"][0]
    detail = client.get("/api/materials/" + material["id"]).json()
    assert detail["material"]["status"] != "error", detail
    assert detail["pages"][1]["kind"] == "answers"
    assert {q["number"] for q in detail["questions"]} == {47, 48}
    for q in detail["questions"]:
        response = client.patch(
            "/api/questions/" + q["id"], json={**q, "confirmed": True}
        )
        assert response.status_code == 200, response.text
    return material, detail["questions"]


def test_offline_full_flow_and_content_roundtrip(client):
    material, questions = upload(client)
    q = next(q for q in questions if q["number"] == 47)
    assert not client.get("/api/state").json()["questions"][0]["conceptIds"]
    assert client.post("/api/lessons", json={"questionId": q["id"]}).status_code == 409
    package = content()
    package["items"][0]["sources"] = [{"materialId": material["id"], "page": 1}]
    package["mappings"][0]["questionId"] = q["id"]
    package["items"].append(
        {
            **package["items"][0],
            "id": "check2",
            "prompt": "치역과 공역이 다르면 일대일대응인가?",
            "type": "OX",
            "choices": ["O", "X"],
            "answer": "X",
            "choiceFeedback": {
                "O": {
                    "explanation": "치역과 공역도 같아야 합니다.",
                    "misconceptionTag": "injective-only",
                }
            },
        }
    )
    assert client.post("/api/content/validate", json={"package": package}).json()[
        "valid"
    ]
    assert (
        client.post("/api/content/import", json={"package": package}).status_code == 200
    )
    registration = client.post(
        "/api/mistakes", json={"materialId": material["id"], "numbers": "47"}
    ).json()
    sid = registration["reviewSessionId"]
    session = client.get("/api/study/" + sid).json()
    assert "answer" not in session["items"][0]
    first = session["items"][0]
    bank = next(i for i in package["items"] if i["id"] == first["bankItemId"])
    wrong = next(c for c in bank["choices"] if c != bank["answer"])
    session = client.post(
        f"/api/study/{sid}/answer", json={"itemId": first["id"], "response": wrong}
    ).json()
    assert (
        next(i for i in session["items"] if i["id"] == first["id"])["feedback"]
        == bank["choiceFeedback"][wrong]["explanation"]
    )
    for _ in range(12):
        item = next((i for i in session["items"] if not i.get("result")), None)
        if not item:
            break
        answer = next(i for i in package["items"] if i["id"] == item["bankItemId"])[
            "answer"
        ]
        session = client.post(
            f"/api/study/{sid}/answer", json={"itemId": item["id"], "response": answer}
        ).json()
    assert session["status"] == "complete" and session["mastered"]
    solve = client.post("/api/solve", json={"questionIds": [q["id"]]}).json()
    original = client.get(f"/api/questions/{q['id']}/image/0?session={solve['id']}")
    assert original.status_code == 200 and original.content.startswith(b"\x89PNG")
    strokes = [
        {
            "region": 0,
            "color": "#3730a3",
            "width": 0.0025,
            "points": [{"x": 0.1, "y": 0.1}, {"x": 0.2, "y": 0.2}],
        }
    ]
    answer = {"questionId": q["id"], "result": "correct", "strokes": strokes}
    assert (
        client.post(f"/api/solve/{solve['id']}/answer", json=answer).status_code == 200
    )
    client.post(f"/api/solve/{solve['id']}/answer", json={**answer, "result": "wrong"})
    state = client.get("/api/state").json()
    mistake = next(m for m in state["mistakes"] if m["questionId"] == q["id"])
    assert (
        mistake["reviewCount"] == 1
        and mistake["correctCount"] == 1
        and mistake["conceptState"] == "understood"
    )
    # Updating the crop never replaces the source snapshot of an existing solve.
    changed = client.patch(
        "/api/questions/" + q["id"],
        json={
            **q,
            "regions": [{"page": 1, "x": 0.05, "y": 0.04, "w": 0.7, "h": 0.15}],
            "confirmed": True,
        },
    )
    assert changed.status_code == 200
    assert (
        client.get(f"/api/questions/{q['id']}/image/0?session={solve['id']}").content
        == original.content
    )
    exported = client.get("/api/content/export?format=sqlite")
    assert exported.content.startswith(b"SQLite format 3")
    preview = client.post(
        "/api/content/validate-file",
        files={"file": ("콘텐츠.sqlite", exported.content, "application/octet-stream")},
    )
    assert preview.json()["valid"], preview.text
    assert (
        client.post(
            "/api/content/import-file",
            files={
                "file": ("콘텐츠.sqlite", exported.content, "application/octet-stream")
            },
        ).status_code
        == 200
    )
    assert (
        client.get("/api/solve/" + solve["id"]).json()["answers"][q["id"]]["result"]
        == "correct"
    )


def test_failed_upload_batch_is_atomic_and_no_remote_ai_routes(client):
    before = len(client.get("/api/state").json()["materials"])
    response = client.post(
        "/api/materials",
        data={"subject": "수학", "kind": "문제집"},
        files=[
            ("files", ("a.pdf", pdf_bytes(), "application/pdf")),
            ("files", ("bad.pdf", b"not-pdf", "application/pdf")),
        ],
    )
    assert response.status_code == 400
    assert len(client.get("/api/state").json()["materials"]) == before
    assert client.get("/api/auth").status_code == 404
    assert (
        client.post("/api/materials/nope/vision", json={"page": 1}).status_code == 404
    )
    assert (
        client.post(
            "/api/solve",
            json={"questionIds": []},
            headers={"origin": "https://unrelated.invalid"},
        ).status_code
        == 403
    )


def test_answer_page_reclassification_blocks_cached_question_images(client):
    material, questions = upload(client)
    q = questions[0]
    session = client.post("/api/solve", json={"questionIds": [q["id"]]}).json()
    assert (
        client.patch(
            f"/api/materials/{material['id']}/page-kind",
            json={"page": 1, "kind": "answers"},
        ).status_code
        == 200
    )
    assert (
        client.get(
            f"/api/questions/{q['id']}/image/0?session={session['id']}"
        ).status_code
        == 400
    )


def test_material_archive_preserves_attempt_history(client):
    material, questions = upload(client)
    q = questions[0]
    client.post("/api/mistakes", json={"questionIds": [q["id"]]})
    session = client.post("/api/solve", json={"questionIds": [q["id"]]}).json()
    client.post(
        f"/api/solve/{session['id']}/answer",
        json={"questionId": q["id"], "result": "wrong", "strokes": []},
    )
    assert client.delete("/api/materials/" + material["id"]).status_code == 200
    assert client.get("/api/state").json()["materials"] == []
    assert (
        client.get("/api/solve/" + session["id"]).json()["answers"][q["id"]]["result"]
        == "wrong"
    )


def test_crop_edit_does_not_overwrite_concurrent_mapping_answer(client, monkeypatch):
    from backend.content import import_package
    import backend.documents as documents

    material, questions = upload(client)
    q = questions[0]
    s = client.app.state.store
    import_package(
        s,
        {
            "mappings": [
                {
                    "questionId": q["id"],
                    "conceptIds": [],
                    "answer": "old",
                    "explanation": "old explanation",
                }
            ]
        },
    )
    original = documents.render_regions

    def during_render(*args, **kwargs):
        result = original(*args, **kwargs)
        import_package(
            s,
            {
                "mappings": [
                    {
                        "questionId": q["id"],
                        "conceptIds": [],
                        "answer": "new",
                        "explanation": "new explanation",
                    }
                ]
            },
        )
        return result

    monkeypatch.setattr(documents, "render_regions", during_render)
    assert (
        client.patch(
            "/api/questions/" + q["id"], json={**q, "confirmed": True}
        ).status_code
        == 200
    )
    assert s.get("questions", q["id"])["answer"] == "new"
    assert s.get("questions", q["id"])["explanation"] == "new explanation"


def test_late_drawing_autosave_does_not_replace_final_attempt(client):
    material, questions = upload(client)
    q = questions[0]
    session = client.post("/api/solve", json={"questionIds": [q["id"]]}).json()
    final = [
        {
            "region": 0,
            "color": "#3730a3",
            "width": 0.0025,
            "points": [{"x": 0.9, "y": 0.9}],
        }
    ]
    old = [{**final[0], "points": [{"x": 0.1, "y": 0.1}]}]
    client.post(
        f"/api/solve/{session['id']}/answer",
        json={"questionId": q["id"], "result": "correct", "strokes": final},
    )
    client.post(
        f"/api/solve/{session['id']}/drawing",
        json={"questionId": q["id"], "strokes": old},
    )
    assert (
        client.get("/api/solve/" + session["id"]).json()["drawings"][q["id"]] == final
    )


def test_moving_all_regions_updates_start_page(client):
    material, questions = upload(client)
    q = questions[0]
    client.patch(
        f"/api/materials/{material['id']}/page-kind",
        json={"page": 2, "kind": "content"},
    )
    moved = client.patch(
        "/api/questions/" + q["id"],
        json={
            "materialId": material["id"],
            "number": q["number"],
            "unit": "",
            "confirmed": True,
            "regions": [{"page": 2, "x": 0.05, "y": 0.05, "w": 0.9, "h": 0.4}],
        },
    ).json()
    assert moved["page"] == 2
