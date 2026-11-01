"""Real PDF fixtures for the local processor; no study content leaves tmp_path."""

from importlib import import_module
from pathlib import Path

import pymupdf as fitz
import pytest


def processor():
    try:
        return import_module("backend.pdf_processing")
    except ModuleNotFoundError:
        pytest.fail("The offline PDF preprocessing module is not implemented yet")


def write_pdf(path, build):
    with fitz.open() as doc:
        build(doc)
        doc.save(path)
    return path


def line(page, text, x, y, size=12):
    page.insert_text((x, y), text, fontsize=size)


def assert_png(path):
    image = Path(path)
    assert image.is_absolute() and image.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    pix = fitz.Pixmap(str(image))
    assert pix.width > 20 and pix.height > 20


def test_real_positions_columns_figures_answers_and_duplicate_numbers(tmp_path):
    def build(doc):
        p = doc.new_page(width=600, height=800)
        line(p, "17. Solve x + 2 = 5.", 40, 70)
        line(p, "A. 1   B. 2   C. 3", 40, 110)
        line(p, "24. Find the area in the figure.", 40, 360)
        p.draw_rect((45, 420, 255, 660), color=(0, 0, 0))
        line(p, "36. Read the table.", 335, 70)
        line(p, "x     1     2     3", 335, 110)
        p.draw_rect((335, 140, 555, 260), color=(0, 0, 0))
        a = doc.new_page(width=600, height=800)
        line(a, "Answer key", 40, 60, 22)
        line(a, "17. C  24. 160  36. B", 40, 110)
        p = doc.new_page(width=600, height=800)
        line(p, "17. Another unit question", 40, 70)

    path = write_pdf(tmp_path / "workbook.pdf", build)
    updates = []
    result = processor().preprocess_document(
        path, tmp_path / "processed", lambda n, text: updates.append((n, text))
    )
    assert [q["number"] for q in result["questions"]] == [17, 24, 36, 17]
    assert result["pages"][1]["kind"] == "answers"
    assert len(result["pages"]) == 3
    q24 = result["questions"][1]
    assert q24["regions"][0]["y"] < 0.44
    assert q24["regions"][0]["y"] + q24["regions"][0]["h"] > 0.825
    assert result["questions"][2]["regions"][0]["x"] > 0.45
    assert all(
        q["confirmed"] is False and q["source"] == "text" for q in result["questions"]
    )
    assert all(
        q["page"] == q["regions"][q.get("sharedRegionCount", 0)]["page"]
        for q in result["questions"]
    )
    for p in result["pages"]:
        assert_png(p["imageFile"])
    for q in result["questions"]:
        assert len(q["cropFiles"]) == len(q["regions"])
        for crop in q["cropFiles"]:
            assert_png(crop)
    assert updates[-1][0] == 100
    assert any("중복" in warning for warning in result["warnings"])


def test_table_cells_and_indented_numbered_choices_are_not_questions(tmp_path):
    def build(doc):
        p = doc.new_page(width=600, height=800)
        line(p, "10. Use the data below.", 40, 70)
        p.draw_rect((70, 120, 270, 240), color=(0, 0, 0))
        for x, value in [(85, "1."), (145, "2."), (205, "3.")]:
            line(p, value, x, 150)
        for y, value in [
            (280, "1) first choice"),
            (305, "2) second choice"),
            (330, "3) third choice"),
        ]:
            line(p, value, 65, y)
        line(p, "11. Next question.", 40, 400)
        line(p, "12. Right column question.", 335, 70)

    result = processor().preprocess_document(
        write_pdf(tmp_path / "cells.pdf", build), tmp_path / "out"
    )
    assert [q["number"] for q in result["questions"]] == [10, 11, 12]
    assert "third choice" in result["questions"][0]["text"]


def test_shared_stimulus_is_prepended_to_each_related_question(tmp_path):
    def build(doc):
        p = doc.new_page(width=600, height=800)
        line(p, "[1-2] Read the following passage.", 40, 65)
        line(p, "A shared source paragraph for both questions.", 40, 110)
        p.draw_rect((40, 130, 500, 200), color=(0, 0, 0))
        line(p, "1. What is the central claim?", 40, 270)
        line(p, "A. First   B. Second", 40, 310)
        line(p, "2. Which evidence supports the claim?", 40, 450)

    result = processor().preprocess_document(
        write_pdf(tmp_path / "shared.pdf", build), tmp_path / "out"
    )
    assert [q["number"] for q in result["questions"]] == [1, 2]
    a, b = result["questions"]
    assert a["sharedRegionCount"] == b["sharedRegionCount"] == 1
    assert a["regions"][0] == b["regions"][0]
    assert len(a["regions"]) == len(b["regions"]) == 2
    assert a["regions"][0]["y"] < 0.09
    assert a["regions"][0]["y"] + a["regions"][0]["h"] > 0.25
    assert "shared source paragraph" in b["text"]
    assert len(b["cropFiles"]) == 2


def test_explicit_cross_page_continuation_is_cropped_before_next_question(tmp_path):
    def build(doc):
        p = doc.new_page(width=600, height=800)
        line(p, "7. Study the information.", 40, 70)
        line(p, "continued on next page", 40, 730)
        p = doc.new_page(width=600, height=800)
        line(p, "(continued)", 40, 50)
        line(p, "A. First   B. Second   C. Third", 40, 100)
        p.draw_rect((40, 120, 300, 200), color=(0, 0, 0))
        line(p, "8. A separate question.", 40, 300)

    result = processor().preprocess_document(
        write_pdf(tmp_path / "continue.pdf", build), tmp_path / "out"
    )
    a, b = result["questions"]
    assert [r["page"] for r in a["regions"]] == [1, 2]
    assert a["regions"][1]["y"] + a["regions"][1]["h"] < b["regions"][0]["y"] + 0.01
    assert "Third" in a["text"]
    assert len(a["cropFiles"]) == 2


def test_unrelated_next_page_is_not_assumed_to_be_a_continuation(tmp_path):
    def build(doc):
        p = doc.new_page(width=600, height=800)
        line(p, "1. A complete question.", 40, 70)
        p = doc.new_page(width=600, height=800)
        line(p, "Chapter Two: A new section", 40, 50)
        line(p, "2. A separate question.", 40, 300)

    result = processor().preprocess_document(
        write_pdf(tmp_path / "separate.pdf", build), tmp_path / "out"
    )
    assert len(result["questions"][0]["regions"]) == 1


def test_rotated_page_has_visual_coordinates_and_precise_annotation_free_crops(
    tmp_path,
):
    def build(doc):
        p = doc.new_page(width=600, height=800)
        line(p, "9. A rotated problem.", 40, 70)
        p.draw_rect((40, 80, 200, 200), fill=(1, 0, 0), color=None)
        annotation = p.add_rect_annot((40, 80, 200, 200))
        annotation.set_colors(stroke=(0, 1, 0), fill=(0, 1, 0))
        annotation.update()
        p.set_rotation(90)

    path = write_pdf(tmp_path / "rotated.pdf", build)
    result = processor().preprocess_document(path, tmp_path / "out")
    page = result["pages"][0]
    assert (page["width"], page["height"]) == (800, 600)
    item = next(i for i in page["items"] if "rotated problem" in i["text"])
    assert item["x"] > 720 and 35 <= item["y"] <= 45
    q = result["questions"][0]
    assert q["regions"][0]["x"] < 0.75
    assert q["regions"][0]["x"] + q["regions"][0]["w"] > 0.9
    files = processor().render_regions(
        path,
        [{"page": 1, "x": 0.75, "y": 40 / 600, "w": 0.15, "h": 160 / 600}],
        tmp_path / "crop",
    )
    pix = fitz.Pixmap(files[0])
    assert pix.height / pix.width == pytest.approx(160 / 120, rel=0.02)
    assert pix.width >= 240
    samples = memoryview(pix.samples)
    pixel = (pix.height // 2 * pix.width + pix.width // 2) * pix.n
    assert samples[pixel] > 230 and samples[pixel + 1] < 30


def test_scanned_page_without_ocr_reports_manual_area_path(tmp_path, monkeypatch):
    module = processor()
    monkeypatch.setattr(
        module,
        "ocr_status",
        lambda: {
            "available": False,
            "languages": [],
            "message": "Tesseract is not installed",
        },
    )

    def build(doc):
        with fitz.open() as image_doc:
            p = image_doc.new_page(width=600, height=800)
            line(p, "1. This is scanned image content", 40, 80, 20)
            image = p.get_pixmap().tobytes("png")
        doc.new_page(width=600, height=800).insert_image((0, 0, 600, 800), stream=image)

    result = module.preprocess_document(
        write_pdf(tmp_path / "scan.pdf", build), tmp_path / "out"
    )
    assert result["questions"] == []
    assert result["pages"][0]["kind"] == "uncertain"
    assert_png(result["pages"][0]["imageFile"])
    assert any("OCR" in w and "직접" in w for w in result["warnings"])


def test_document_without_problem_markers_does_not_receive_uniform_fake_questions(
    tmp_path,
):
    def build(doc):
        p = doc.new_page(width=600, height=800)
        line(p, "A textbook paragraph with no numbered exercise markers.", 40, 80)
        line(
            p, "Reading material remains available for manual area selection.", 40, 260
        )

    result = processor().preprocess_document(
        write_pdf(tmp_path / "textbook.pdf", build), tmp_path / "out", kind="교과서"
    )
    assert result["questions"] == []
    assert result["warnings"]


def test_render_regions_rejects_invalid_bounds_and_missing_pages(tmp_path):
    path = write_pdf(
        tmp_path / "blank.pdf", lambda doc: doc.new_page(width=600, height=800)
    )
    for region in [
        {"page": 0, "x": 0, "y": 0, "w": 1, "h": 1},
        {"page": 2, "x": 0, "y": 0, "w": 1, "h": 1},
        {"page": 1, "x": -0.1, "y": 0, "w": 1, "h": 1},
        {"page": 1, "x": 0, "y": 0, "w": 0, "h": 1},
        {"page": 1, "x": 0, "y": 0, "w": float("nan"), "h": 1},
    ]:
        with pytest.raises(ValueError):
            processor().render_regions(path, [region], tmp_path / "bad")


def test_damaged_pdf_is_rejected_with_an_actionable_error(tmp_path):
    path = tmp_path / "broken.pdf"
    path.write_bytes(b"not a pdf")
    with pytest.raises(ValueError, match="PDF"):
        processor().preprocess_document(path, tmp_path / "out")


def test_ocr_status_explains_available_languages_without_network():
    result = processor().ocr_status()
    assert isinstance(result["available"], bool)
    assert isinstance(result["languages"], list)
    assert isinstance(result["message"], str) and result["message"]


def test_real_local_ocr_when_tesseract_is_installed(tmp_path):
    module = processor()
    if not module.ocr_status()["available"]:
        pytest.skip("Optional local Tesseract executable is not installed")

    def build(doc):
        with fitz.open() as image_doc:
            p = image_doc.new_page(width=600, height=800)
            line(p, "17. Find the correct answer.", 45, 100, 23)
            line(p, "A. First   B. Second", 45, 160, 23)
            image = p.get_pixmap(matrix=fitz.Matrix(2, 2)).tobytes("png")
        doc.new_page(width=600, height=800).insert_image((0, 0, 600, 800), stream=image)

    result = module.preprocess_document(
        write_pdf(tmp_path / "scan-ocr.pdf", build), tmp_path / "out"
    )
    assert [q["number"] for q in result["questions"]] == [17]
    assert result["questions"][0]["source"] == "ocr"
    assert_png(result["questions"][0]["cropFiles"][0])


def test_single_column_table_numerals_are_not_bare_question_markers(tmp_path):
    def build(doc):
        p = doc.new_page(width=600, height=800)
        line(p, "10. Use the values in this table.", 40, 70)
        p.draw_rect((70, 100, 240, 310), color=(0, 0, 0))
        for value, y in [("1", 150), ("2", 200), ("3", 250)]:
            line(p, value, 90, y)
        line(p, "11. The next question.", 40, 400)

    result = processor().preprocess_document(
        write_pdf(tmp_path / "vertical-table.pdf", build), tmp_path / "out"
    )
    assert [q["number"] for q in result["questions"]] == [10, 11]


def test_shared_passage_spanning_column_gutter_is_kept_at_full_width(tmp_path):
    def build(doc):
        p = doc.new_page(width=600, height=800)
        line(p, "[1-2] Read this shared passage.", 40, 60)
        line(
            p,
            "This passage extends across both columns and must stay intact for both problems.",
            40,
            110,
        )
        p.draw_rect((40, 140, 555, 210), color=(0, 0, 0))
        line(p, "1. Left question.", 40, 300)
        line(p, "2. Right question.", 335, 300)

    result = processor().preprocess_document(
        write_pdf(tmp_path / "wide-shared.pdf", build), tmp_path / "out"
    )
    assert len(result["questions"]) == 2
    shared = result["questions"][0]["regions"][0]
    assert shared["x"] + shared["w"] > 0.92
    assert result["questions"][1]["regions"][0] == shared


def test_explicit_shared_number_range_is_preserved_for_next_page_question(tmp_path):
    def build(doc):
        p = doc.new_page(width=600, height=800)
        line(p, "[1-2] Read this shared passage.", 40, 60)
        line(p, "The common passage is on the preceding page.", 40, 110)
        line(p, "1. First related question.", 40, 300)
        p = doc.new_page(width=600, height=800)
        line(p, "2. Second related question.", 40, 70)

    result = processor().preprocess_document(
        write_pdf(tmp_path / "shared-next.pdf", build), tmp_path / "out"
    )
    second = result["questions"][1]
    assert second["sharedRegionCount"] == 1
    assert [r["page"] for r in second["regions"]] == [1, 2]
    assert "preceding page" in second["text"]


def test_ocr_candidate_keeps_scanned_figure_below_recognized_text(
    tmp_path, monkeypatch
):
    # Only the optional external OCR process is substituted; layout, raster
    # bounds, original PDF rendering, and the resulting PNG are real.
    import subprocess

    module = processor()
    monkeypatch.setattr(
        module,
        "ocr_status",
        lambda: {
            "available": True,
            "executable": "local-tesseract",
            "selectedLanguage": "eng",
            "languages": ["eng"],
            "message": "Local OCR",
        },
    )
    tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
    for word, left, width in [
        ("17.", 100, 70),
        ("Study", 180, 120),
        ("the", 310, 60),
        ("figure.", 380, 140),
    ]:
        tsv += f"5\t1\t1\t1\t1\t1\t{left}\t170\t{width}\t40\t95\t{word}\n"
    monkeypatch.setattr(
        module,
        "_command",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args[0], 0, tsv.encode(), b""
        ),
    )

    def build(doc):
        with fitz.open() as image_doc:
            p = image_doc.new_page(width=600, height=800)
            line(p, "17. Study the figure.", 40, 80, 18)
            p.draw_rect((60, 180, 400, 550), color=(0, 0, 0), width=2)
            image = p.get_pixmap(matrix=fitz.Matrix(2, 2)).tobytes("png")
        doc.new_page(width=600, height=800).insert_image((0, 0, 600, 800), stream=image)

    result = module.preprocess_document(
        write_pdf(tmp_path / "ocr-figure.pdf", build), tmp_path / "out"
    )
    q = result["questions"][0]
    assert q["source"] == "ocr" and q["number"] == 17
    assert q["regions"][0]["y"] + q["regions"][0]["h"] > 0.68
    assert_png(q["cropFiles"][0])


def test_scanned_page_with_partial_native_overlay_still_requires_ocr_or_manual_areas(
    tmp_path, monkeypatch
):
    module = processor()
    monkeypatch.setattr(
        module,
        "ocr_status",
        lambda: {"available": False, "languages": [], "message": "No local OCR"},
    )

    def build(doc):
        with fitz.open() as image_doc:
            p = image_doc.new_page(width=600, height=800)
            line(p, "The problem body and diagram are image-only.", 40, 200, 19)
            p.draw_rect((40, 250, 400, 650), color=(0, 0, 0))
            image = p.get_pixmap().tobytes("png")
        p = doc.new_page(width=600, height=800)
        p.insert_image((0, 0, 600, 800), stream=image)
        line(p, "17. Only this marker has native selectable text.", 40, 70)

    result = module.preprocess_document(
        write_pdf(tmp_path / "partial-scan.pdf", build), tmp_path / "out"
    )
    assert result["questions"] == []
    assert result["pages"][0]["kind"] == "uncertain"
    assert any("OCR" in w for w in result["warnings"])


def test_dense_answer_key_continuation_is_excluded_without_a_repeated_heading(tmp_path):
    def build(doc):
        p = doc.new_page(width=600, height=800)
        line(p, "1. A real question with a complete prompt.", 40, 70)
        p = doc.new_page(width=600, height=800)
        line(p, "Answers", 40, 60, 20)
        for n in range(1, 6):
            line(p, f"{n}. A", 40, 100 + n * 30)
        p = doc.new_page(width=600, height=800)
        for n in range(6, 11):
            line(p, f"{n}. B", 40, 70 + (n - 6) * 30)
        p = doc.new_page(width=600, height=800)
        line(p, "11. A fresh unit question with a complete prompt.", 40, 70)

    result = processor().preprocess_document(
        write_pdf(tmp_path / "answer-continuation.pdf", build), tmp_path / "out"
    )
    assert [p["kind"] for p in result["pages"]] == [
        "content",
        "answers",
        "answers",
        "content",
    ]
    assert [q["number"] for q in result["questions"]] == [1, 11]


def test_korean_problem_numbers_and_answer_heading_use_native_text(tmp_path):
    def build(doc):
        p = doc.new_page(width=600, height=800)
        p.insert_text(
            (40, 70),
            "문제 17번 다음 표를 보고 답하시오.",
            fontname="korea",
            fontsize=12,
        )
        p = doc.new_page(width=600, height=800)
        p.insert_text((40, 60), "정답과 해설", fontname="korea", fontsize=20)
        p.insert_text(
            (40, 100), "17번 정답은 삼 번이다.", fontname="korea", fontsize=12
        )

    result = processor().preprocess_document(
        write_pdf(tmp_path / "korean.pdf", build), tmp_path / "out"
    )
    assert [q["number"] for q in result["questions"]] == [17]
    assert result["pages"][1]["kind"] == "answers"
