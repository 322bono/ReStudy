"""Offline, evidence-based PDF candidates and pre-rendered original-page crops.

This is a conservative layout heuristic, not a workbook parser. Every candidate
requires review. No concepts, answers, or missing content are generated here.
Text positions and vector/image extents determine boundaries; pages without
usable problem markers are left for the manual area editor.
"""

from __future__ import annotations

import csv
import io
import math
import os
import re
import shutil
import subprocess
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import pymupdf as fitz
import cv2
import numpy as np


_NUMBER = re.compile(
    r"^\s*(?:(?:문제|Question|Q)\s*)?(\d{1,4})\s*(?:[.．](?!\d)|\)|번(?:\s|$))\s*(.*)$",
    re.I,
)
_BARE = re.compile(r"^\s*(\d{1,4})\s*$")
_RANGE = re.compile(
    r"(?:^\s*[\[【(]|^\s*(?:Questions?|문항)\s+)(\d{1,4})\s*[~～\-–—]\s*(\d{1,4})\s*[\]】)]?",
    re.I,
)
_ANSWERS = re.compile(
    r"^\s*(?:정답\s*(?:(?:과|및|[·ㆍ/])\s*해설|해설)?|빠른\s*정답|해답|해설(?:지)?|정답표|Answers?(?:\s*(?:key|sheet))?|Solutions?(?:\s+(?:and\s+)?(?:answers?|explanations?))?)(?:\s*[:：-].*|\s*\d+|\s*)$",
    re.I,
)
_ANSWER_ENTRY = re.compile(
    r"^\s*\d{1,4}\s*(?:[.)．]|번)\s*(?:[①-⑤A-EＯＸOX×○]|[-+]?\d+(?:\.\d+)?)(?:\s*[,;]\s*(?:[①-⑤A-EＯＸOX×○]|[-+]?\d+(?:\.\d+)?))*\s*$",
    re.I,
)
_NEXT = re.compile(
    r"continued\s+on\s+(?:the\s+)?next\s+page|다음\s*(?:쪽|페이지).{0,8}(?:계속|이어)|뒷면에\s*계속",
    re.I,
)
_CONTINUED = re.compile(
    r"^\s*[\[(]?(?:continued\b|계속\b|앞\s*(?:쪽|페이지).{0,8}(?:계속|이어))", re.I
)


@dataclass
class _Line:
    text: str
    rect: fitz.Rect
    confidence: float = 1.0


@dataclass
class _Anchor:
    number: int
    line: _Line
    bare: bool = False
    column: int = 0


@dataclass
class _Layout:
    number: int
    width: float
    height: float
    visual_width: float
    visual_height: float
    transform: fitz.Matrix
    lines: list[_Line]
    graphics: list[fitz.Rect]
    source: str = "text"
    kind: str = "content"
    anchors: list[_Anchor] = field(default_factory=list)
    columns: list[tuple[float, float]] = field(default_factory=list)
    shared: list[tuple] = field(default_factory=list)


def _command(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    # CREATE_NO_WINDOW prevents flashing console windows on Windows. There is
    # deliberately no shell, downloading, model loading, or network fallback.
    return subprocess.run(
        args,
        capture_output=True,
        check=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        **kwargs,
    )


def ocr_status() -> dict:
    """Inspect a locally installed Tesseract executable and language packs."""
    candidates = [
        os.environ.get("TESSERACT_CMD"),
        str(
            Path(__file__).resolve().parents[1]
            / "tools"
            / "tesseract"
            / "tesseract.exe"
        ),
        shutil.which("tesseract"),
    ]
    if os.name == "nt":
        for root in (os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
            if root:
                candidates.append(str(Path(root) / "Tesseract-OCR" / "tesseract.exe"))
    executable = next(
        (str(Path(p).resolve()) for p in candidates if p and Path(p).is_file()), None
    )
    if not executable:
        return {
            "available": False,
            "executable": None,
            "languages": [],
            "selectedLanguage": None,
            "message": "로컬 Tesseract OCR이 없습니다. Tesseract와 kor/eng 언어를 설치한 뒤 다시 처리하거나 콘텐츠 관리에서 문항 영역을 직접 지정하세요.",
        }
    try:
        result = _command([executable, "--list-langs"], timeout=10)
        languages = sorted(
            {
                s.strip()
                for s in result.stdout.decode("utf-8", "replace").splitlines()
                if re.fullmatch(r"[\w/-]+", s.strip()) and s.strip() != "osd"
            }
        )
        selected = "+".join(lang for lang in ("kor", "eng") if lang in languages)
        if not selected and languages:
            selected = languages[0]
        if not selected:
            return {
                "available": False,
                "executable": executable,
                "languages": [],
                "selectedLanguage": None,
                "message": "Tesseract의 OCR 언어 데이터가 없습니다. kor/eng 언어를 설치하거나 문항 영역을 직접 지정하세요.",
            }
        message = f"로컬 OCR 사용 가능 ({', '.join(languages)}). OCR 문항 경계와 번호는 직접 확인해야 합니다."
        if "kor" not in languages:
            message += " 한국어 kor 언어 데이터가 없어 한국어 인식이 제한됩니다."
        return {
            "available": True,
            "executable": executable,
            "languages": languages,
            "selectedLanguage": selected,
            "message": message,
        }
    except (OSError, subprocess.SubprocessError) as exc:
        return {
            "available": False,
            "executable": executable,
            "languages": [],
            "selectedLanguage": None,
            "message": f"로컬 OCR 실행을 확인하지 못했습니다 ({type(exc).__name__}). 설치와 언어 데이터를 확인하거나 문항 영역을 직접 지정하세요.",
        }


def _open(source: Path) -> fitz.Document:
    try:
        doc = fitz.open(str(source))
        if not doc.is_pdf or doc.needs_pass or not len(doc):
            doc.close()
            raise ValueError("암호가 없고 페이지가 있는 PDF 파일을 사용하세요.")
        if len(doc) > 500:
            doc.close()
            raise ValueError(
                "PDF는 한 파일당 500쪽까지 지원합니다. 파일을 나누어 등록하세요."
            )
        return doc
    except (
        fitz.FileDataError,
        fitz.EmptyFileError,
        FileNotFoundError,
        RuntimeError,
    ) as exc:
        raise ValueError(
            "PDF 파일을 읽을 수 없습니다. 손상 여부를 확인하고 정상 PDF로 다시 저장하세요."
        ) from exc


def _save_png(pixmap: fitz.Pixmap, destination: Path) -> str:
    temporary = destination.with_name(destination.name + ".tmp")
    temporary.write_bytes(pixmap.tobytes("png"))
    temporary.replace(destination)
    return str(destination.resolve())


def _scale(page: fitz.Page, preferred: float = 2.0) -> float:
    return min(preferred, 4000 / max(page.rect.width, page.rect.height))


def _validate_regions(
    doc: fitz.Document, regions: list[dict]
) -> list[tuple[int, fitz.Rect]]:
    validated = []
    for region in regions:
        try:
            number = region["page"]
            if (
                isinstance(number, bool)
                or not isinstance(number, int)
                or not 1 <= number <= len(doc)
            ):
                raise ValueError("존재하는 PDF 페이지 번호가 필요합니다.")
            x, y, w, h = (float(region[key]) for key in ("x", "y", "w", "h"))
            if not all(math.isfinite(v) for v in (x, y, w, h)):
                raise ValueError("PDF 문항 영역에 유효하지 않은 좌표가 있습니다.")
            if min(x, y) < 0 or min(w, h) <= 0 or x + w > 1.000001 or y + h > 1.000001:
                raise ValueError("PDF 문항 영역은 페이지 안의 0~1 좌표여야 합니다.")
            page = doc[number - 1]
            rect = fitz.Rect(
                x * page.rect.width,
                y * page.rect.height,
                min(1, x + w) * page.rect.width,
                min(1, y + h) * page.rect.height,
            )
            if rect.width < 0.5 or rect.height < 0.5:
                raise ValueError("PDF 문항 영역이 너무 작습니다.")
            validated.append((number, rect))
        except (KeyError, TypeError, OverflowError) as exc:
            raise ValueError(
                "PDF 문항 영역에는 page, x, y, w, h가 필요합니다."
            ) from exc
    return validated


def _render(doc: fitz.Document, regions: list[dict], output_dir: Path) -> list[str]:
    validated = _validate_regions(doc, regions)
    output_dir.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    result = []
    for index, (number, rect) in enumerate(validated):
        page = doc[number - 1]
        # MuPDF display-list clips use rotated visual coordinates already.
        pixmap = page.get_pixmap(
            matrix=fitz.Matrix(_scale(page, 2.5), _scale(page, 2.5)),
            clip=rect,
            alpha=False,
            annots=False,
        )
        result.append(_save_png(pixmap, output_dir / f"crop-{token}-{index:03d}.png"))
    return result


def render_regions(source: Path, regions: list[dict], output_dir: Path) -> list[str]:
    """Render validated visual-page regions at high resolution, without annotations.

    Unique filenames preserve previous session snapshots when an area is edited.
    All regions are validated before any crop is written.
    """
    with _open(Path(source)) as doc:
        return _render(doc, regions, Path(output_dir).resolve())


def _text_lines(page: fitz.Page) -> tuple[list[_Line], bool]:
    data = page.get_text("dict", flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)
    records = [
        line
        for block in data["blocks"]
        if block["type"] == 0
        for line in block["lines"]
    ]
    # Normally text extraction is in unrotated coordinates. Some landscape
    # sources paint vertical native text then rotate the page to make it upright.
    vertical = sum(abs(line.get("dir", (1, 0))[1]) > 0.8 for line in records)
    visual_analysis = bool(page.rotation in (90, 270) and vertical > len(records) / 2)
    lines = []
    for record in records:
        text = "".join(span["text"] for span in record["spans"]).strip()
        if text:
            rect = fitz.Rect(record["bbox"])
            if visual_analysis:
                rect *= page.rotation_matrix
            lines.append(_Line(text, rect))
    return lines, visual_analysis


def _ocr_lines(page: fitz.Page, status: dict) -> list[_Line]:
    scale = _scale(page, 2.5)
    pixmap = page.get_pixmap(
        matrix=fitz.Matrix(scale, scale), alpha=False, annots=False
    )
    completed = _command(
        [
            status["executable"],
            "stdin",
            "stdout",
            "-l",
            status["selectedLanguage"],
            "--psm",
            "3",
            "tsv",
        ],
        input=pixmap.tobytes("png"),
        timeout=120,
    )
    grouped: dict[tuple, list[tuple[str, fitz.Rect, float]]] = defaultdict(list)
    for row in csv.DictReader(
        io.StringIO(completed.stdout.decode("utf-8", "replace")), delimiter="\t"
    ):
        try:
            text, confidence = row.get("text", "").strip(), float(row.get("conf", "-1"))
            if not text or confidence < 30 or row.get("level") != "5":
                continue
            left, top, width, height = (
                float(row[key]) for key in ("left", "top", "width", "height")
            )
            rect = fitz.Rect(
                left / pixmap.width * page.rect.width,
                top / pixmap.height * page.rect.height,
                (left + width) / pixmap.width * page.rect.width,
                (top + height) / pixmap.height * page.rect.height,
            )
            grouped[(row["block_num"], row["par_num"], row["line_num"])].append(
                (text, rect, confidence / 100)
            )
        except (KeyError, ValueError):
            continue
    lines = []
    for words in grouped.values():
        rect = fitz.Rect(words[0][1])
        for _, word_rect, _ in words[1:]:
            rect |= word_rect
        lines.append(
            _Line(
                " ".join(w[0] for w in words),
                rect,
                sum(w[2] for w in words) / len(words),
            )
        )
    return lines


def _graphics(page: fitz.Page, visual: bool) -> list[fitz.Rect]:
    rectangles = [fitz.Rect(d["rect"]) for d in page.get_drawings()]
    rectangles.extend(fitz.Rect(image["bbox"]) for image in page.get_image_info())
    result = []
    bounds = page.rect if visual else page.rect * page.derotation_matrix
    for rect in rectangles:
        if visual:
            rect *= page.rotation_matrix
        rect &= bounds
        if rect.is_empty or rect.width < 2 or rect.height < 2:
            continue
        # Page-sized scan backgrounds and borders are not individual figures.
        if rect.width > bounds.width * 0.93 and rect.height > bounds.height * 0.9:
            continue
        result.append(rect)
    return result


def _raster_graphics(page: fitz.Page) -> list[fitz.Rect]:
    """Find actual ink extents in scans, including diagrams OCR cannot read.

    These connected components supplement OCR positions; they never create
    problem numbers and cannot cause uniform page subdivision.
    """
    scale = min(2.0, 1800 / max(page.rect.width, page.rect.height))
    pixmap = page.get_pixmap(
        matrix=fitz.Matrix(scale, scale), alpha=False, annots=False
    )
    pixels = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
        pixmap.height, pixmap.width, pixmap.n
    )
    gray = cv2.cvtColor(pixels, cv2.COLOR_RGB2GRAY)
    _, ink = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((3, 7), dtype=np.uint8))
    contours, _ = cv2.findContours(ink, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    rectangles = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if (
            w * h < 35
            or w < 3
            or h < 3
            or (w > pixmap.width * 0.93 and h > pixmap.height * 0.9)
        ):
            continue
        rectangles.append(
            fitz.Rect(
                x / pixmap.width * page.rect.width,
                y / pixmap.height * page.rect.height,
                (x + w) / pixmap.width * page.rect.width,
                (y + h) / pixmap.height * page.rect.height,
            )
        )
    return rectangles


def _content_lines(layout: _Layout) -> list[_Line]:
    return [
        line
        for line in layout.lines
        if not (
            line.rect.y0 > layout.height * 0.94
            and re.fullmatch(r"[\s\-–—]*\d{1,4}[\s\-–—]*", line.text)
        )
    ]


def _find_anchors(layout: _Layout) -> list[_Anchor]:
    lines = _content_lines(layout)
    candidates = []
    for line in lines:
        if _RANGE.search(line.text):
            continue
        labelled, bare = _NUMBER.match(line.text), _BARE.match(line.text)
        match = labelled or bare
        if not match or int(match[1]) < 1:
            continue
        # Multiple small numeric cells on one row are evidence of a table,
        # even when MuPDF extracts each cell as its own separate text line.
        number_only = bool(re.fullmatch(r"\s*\d+[.)．]?\s*", line.text))
        same_row = [
            other
            for other in lines
            if other is not line
            and abs(other.rect.y0 - line.rect.y0) < max(3, line.rect.height * 0.4)
            and re.fullmatch(r"\s*\d+[.)．]?\s*", other.text)
        ]
        if number_only and same_row:
            continue
        if number_only and any(
            shape.width > 40
            and shape.height > 30
            and shape.contains(line.rect)
            and sum(
                shape.contains(other.rect)
                and bool(re.fullmatch(r"\s*\d+[.)．]?\s*", other.text))
                for other in lines
            )
            >= 2
            for shape in layout.graphics
        ):
            continue
        if bare:
            if line.rect.y0 > layout.height * 0.9:
                continue
            nearby = any(
                other is not line
                and other.rect.x0 > line.rect.x1
                and other.rect.x0 - line.rect.x1 < 55
                and abs(other.rect.y0 - line.rect.y0) < line.rect.height * 0.7
                and re.search(r"[A-Za-z가-힣]", other.text)
                for other in lines
            )
            aligned = [
                other
                for other in lines
                if other is not line
                and _BARE.fullmatch(other.text)
                and abs(other.rect.x0 - line.rect.x0) < 5
            ]
            if not nearby and not aligned:
                continue
        candidates.append(_Anchor(int(match[1]), line, bool(bare and not labelled)))
    if not candidates:
        return []
    # Indented 1)..5) lines below an outer question are commonly answer
    # choices or subparts. Keep them in the outer crop rather than inventing
    # separate questions. A large x separation remains eligible as a column.
    result = []
    for anchor in candidates:
        outer = [
            other
            for other in candidates
            if other.line.rect.y0 < anchor.line.rect.y0 - 5
            and 8 < anchor.line.rect.x0 - other.line.rect.x0 < layout.width * 0.18
        ]
        if outer and anchor.number <= 5 and re.match(r"^\s*\d+\)", anchor.line.text):
            continue
        result.append(anchor)
    return result


def _set_columns(layout: _Layout) -> None:
    anchors = layout.anchors
    xs = sorted(anchor.line.rect.x0 for anchor in anchors)
    boundaries = []
    if len(xs) > 1:
        gaps = [(xs[i + 1] - xs[i], xs[i], xs[i + 1]) for i in range(len(xs) - 1)]
        gap, left, right = max(gaps)
        if gap > layout.width * 0.27:
            left_ends = [
                line.rect.x1
                for line in _content_lines(layout)
                if line.rect.x0 <= left + 15
                and line.rect.x1 < right - 10
                and line.rect.y0 >= min(a.line.rect.y0 for a in anchors) - 5
            ]
            edge = max(left_ends, default=left + gap * 0.65)
            boundaries = [min(right - 10, max(left + 20, (edge + right) / 2))]
    edges = [0.0, *boundaries, layout.width]
    layout.columns = list(zip(edges, edges[1:]))
    for anchor in anchors:
        anchor.column = next(
            i
            for i, (left, right) in enumerate(layout.columns)
            if left <= anchor.line.rect.x0 < right
        )
    layout.anchors.sort(key=lambda a: (a.column, a.line.rect.y0, a.line.rect.x0))


def _region(layout: _Layout, rectangle: fitz.Rect) -> dict:
    rect = rectangle * layout.transform
    rect &= fitz.Rect(0, 0, layout.visual_width, layout.visual_height)
    return {
        "page": layout.number,
        "x": rect.x0 / layout.visual_width,
        "y": rect.y0 / layout.visual_height,
        "w": rect.width / layout.visual_width,
        "h": rect.height / layout.visual_height,
    }


def _in_area(
    rect: fitz.Rect, left: float, right: float, top: float, bottom: float
) -> bool:
    return (
        rect.x0 < right - 2
        and rect.x1 > left + 2
        and rect.y0 >= top - 2
        and rect.y0 < bottom
    )


def _area(
    layout: _Layout,
    column: int,
    top: float,
    bottom: float,
    anchor_x: float | None = None,
) -> tuple[dict, str]:
    left, right = layout.columns[column]
    return _area_bounds(layout, left, right, top, bottom, anchor_x)


def _area_bounds(
    layout: _Layout,
    left: float,
    right: float,
    top: float,
    bottom: float,
    anchor_x: float | None = None,
) -> tuple[dict, str]:
    lines = [
        line
        for line in _content_lines(layout)
        if _in_area(line.rect, left, right, top, bottom)
    ]
    figures = [r for r in layout.graphics if _in_area(r, left, right, top, bottom)]
    rectangles = [line.rect for line in lines] + figures
    x0 = (
        min(
            (r.x0 for r in rectangles),
            default=anchor_x if anchor_x is not None else left + 10,
        )
        - 7
    )
    x1 = max((r.x1 for r in rectangles), default=x0 + 40) + 7
    y1 = max((r.y1 for r in rectangles), default=top + 20) + 7
    rect = fitz.Rect(
        max(left, x0), max(0, top - 5), min(right, x1), min(bottom - 3, y1)
    )
    if rect.height < 5:
        rect.y1 = min(layout.height, rect.y0 + 10)
    text = "\n".join(
        line.text
        for line in sorted(lines, key=lambda line: (line.rect.y0, line.rect.x0))
    )
    return _region(layout, rect), text


def _questions(layout: _Layout) -> list[dict]:
    if layout.kind == "answers" or layout.source == "manual":
        return []
    layout.anchors = _find_anchors(layout)
    _set_columns(layout)
    shared = []
    for line in layout.lines:
        match = _RANGE.search(line.text)
        if not match or not 0 < int(match[1]) <= int(match[2]) <= int(match[1]) + 50:
            continue
        column = next(
            (
                i
                for i, (left, right) in enumerate(layout.columns)
                if left <= line.rect.x0 < right
            ),
            0,
        )
        starts = [
            a.line.rect.y0
            for a in layout.anchors
            if a.column == column
            and a.line.rect.y0 > line.rect.y0
            and int(match[1]) <= a.number <= int(match[2])
        ]
        if starts:
            bottom = min(starts)
            left, right = layout.columns[column]
            crossing = any(
                rect.x0 < right - 8
                and rect.x1 > right + 8
                and line.rect.y0 <= rect.y0 < bottom
                for rect in [item.rect for item in layout.lines] + layout.graphics
            )
            if crossing:
                bottom = min(
                    (
                        a.line.rect.y0
                        for a in layout.anchors
                        if int(match[1]) <= a.number <= int(match[2])
                        and a.line.rect.y0 > line.rect.y0
                    ),
                    default=bottom,
                )
                region, text = _area_bounds(
                    layout, 0, layout.width, line.rect.y0, bottom
                )
            else:
                region, text = _area(layout, column, line.rect.y0, bottom)
            shared.append(
                (int(match[1]), int(match[2]), column, line.rect.y0, region, text)
            )
    layout.shared = shared
    questions = []
    for anchor in layout.anchors:
        after = [
            a.line.rect.y0
            for a in layout.anchors
            if a.column == anchor.column
            and a.line.rect.y0
            > anchor.line.rect.y0 + max(4, anchor.line.rect.height / 2)
        ]
        after.extend(
            s[3] for s in shared if s[2] == anchor.column and s[3] > anchor.line.rect.y0
        )
        bottom = min(after, default=layout.height * 0.965)
        region, text = _area(
            layout, anchor.column, anchor.line.rect.y0, bottom, anchor.line.rect.x0
        )
        contexts = [
            s
            for s in shared
            if s[0] <= anchor.number <= s[1]
            and (s[2], s[3]) < (anchor.column, anchor.line.rect.y0)
        ]
        context = max(contexts, key=lambda s: (s[2], s[3])) if contexts else None
        regions = [context[4], region] if context else [region]
        questions.append(
            {
                "number": anchor.number,
                "page": layout.number,
                "unit": "",
                "text": (context[5] + "\n" if context else "") + text,
                "regions": regions,
                "confidence": round(
                    min(
                        0.58 if layout.source == "ocr" else 0.76, anchor.line.confidence
                    ),
                    3,
                ),
                "confirmed": False,
                "source": layout.source,
                "sharedRegionCount": 1 if context else 0,
            }
        )
    return questions


def _inherit_shared(
    previous: _Layout,
    current: _Layout,
    prior_questions: list[dict],
    candidates: list[dict],
    warnings: list[str],
) -> None:
    if (
        previous.kind == "answers"
        or current.kind == "answers"
        or not candidates
        or not previous.shared
    ):
        return
    prior = [q for q in prior_questions if q["page"] == previous.number]
    if not prior or not current.anchors:
        return
    first_anchor = current.anchors[0]
    preceding = [
        line
        for line in _content_lines(current)
        if line.rect.y0 < first_anchor.line.rect.y0 - 4
    ]
    if any(not _CONTINUED.match(line.text) for line in preceding):
        return
    for shared in previous.shared:
        start, end, _, _, region, text = shared
        last_number = prior[-1]["number"]
        # An explicit number range and adjacent sequence are both necessary.
        if not (
            start <= last_number < end and candidates[0]["number"] == last_number + 1
        ):
            continue
        for candidate in candidates:
            if (
                start <= candidate["number"] <= end
                and not candidate["sharedRegionCount"]
            ):
                candidate["regions"].insert(0, region)
                candidate["sharedRegionCount"] = 1
                candidate["text"] = text + "\n" + candidate["text"]
                candidate["confidence"] = min(candidate["confidence"], 0.6)
        current.shared.append(shared)
        warnings.append(
            f"{previous.number}쪽 공통 지문을 명시된 {start}~{end}번 범위와 연속 번호를 근거로 {current.number}쪽 문항에 연결했습니다. 지문 연결을 확인하세요."
        )


def _continue(
    previous: _Layout, current: _Layout, questions: list[dict], warnings: list[str]
) -> None:
    if previous.kind == "answers" or current.kind == "answers":
        return
    prior = [q for q in questions if q["regions"][-1]["page"] == previous.number]
    lines = _content_lines(current)
    if not prior or not lines:
        return
    last = prior[-1]
    # A continuation is attached only with explicit textual evidence. A new
    # unnumbered heading on the next page alone never proves continuation.
    first_column = 0
    boundary = min(
        (a.line.rect.y0 for a in current.anchors if a.column == first_column),
        default=current.height * 0.965,
    )
    top_lines = sorted(
        [line for line in lines if line.rect.y0 < boundary - 4],
        key=lambda l: (l.rect.y0, l.rect.x0),
    )
    if not top_lines:
        return
    explicit = bool(_NEXT.search(last["text"]) or _CONTINUED.match(top_lines[0].text))
    if not explicit:
        return
    top = min(line.rect.y0 for line in top_lines)
    region, text = _area(current, first_column, top, boundary)
    last["regions"].append(region)
    last["text"] += "\n" + text
    last["confidence"] = min(last["confidence"], 0.6)
    warnings.append(
        f"{previous.number}~{current.number}쪽의 {last['number']}번은 계속 표시를 근거로 연결한 후보입니다. 이어지는 영역을 확인하세요."
    )


def preprocess_document(
    source: Path,
    output_dir: Path,
    progress: Callable[[int, str], None] | None = None,
    kind: str = "문제집",
) -> dict:
    """Pre-render every page and every candidate region using local tools only."""
    source, output_dir = Path(source), Path(output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    pages, layouts, questions, warnings = [], [], [], []
    status = None
    emit = progress or (lambda value, message: None)
    emit(1, "PDF 페이지와 원본 텍스트를 확인하고 있어요.")
    with _open(source) as doc:
        for index, page in enumerate(doc):
            number = index + 1
            emit(
                2 + int(index / len(doc) * 62),
                f"{number}/{len(doc)}쪽을 로컬에서 처리하고 있어요.",
            )
            image_file = _save_png(
                page.get_pixmap(
                    matrix=fitz.Matrix(_scale(page), _scale(page)),
                    alpha=False,
                    annots=False,
                ),
                output_dir / f"page-{number:04d}.png",
            )
            lines, visual = _text_lines(page)
            text_length = sum(len(line.text.strip()) for line in lines)
            image_coverage = max(
                (
                    fitz.Rect(i["bbox"]).get_area() / page.rect.get_area()
                    for i in page.get_image_info()
                ),
                default=0,
            )
            is_scan = (text_length < 25 and image_coverage > 0.25) or (
                text_length < 200 and image_coverage > 0.65
            )
            method = "manual" if is_scan else "text"
            if is_scan:
                if status is None:
                    status = ocr_status()
                if status["available"]:
                    emit(
                        2 + int(index / len(doc) * 62),
                        f"{number}쪽을 설치된 로컬 OCR로 읽고 있어요.",
                    )
                    try:
                        recognized = _ocr_lines(page, status)
                        if recognized:
                            lines, visual, method = recognized, True, "ocr"
                            warnings.append(
                                f"{number}쪽은 로컬 OCR 후보입니다. 번호·지문·그림의 영역을 콘텐츠 관리에서 직접 확인하세요."
                            )
                            if "kor" not in status["languages"]:
                                warnings.append(
                                    f"{number}쪽 OCR에 한국어 kor 언어 데이터가 없습니다. 한국어 인식이 제한됩니다."
                                )
                        else:
                            warnings.append(
                                f"{number}쪽 OCR에서 읽을 수 있는 문항을 찾지 못했습니다. 콘텐츠 관리에서 영역을 직접 지정하세요."
                            )
                    except (OSError, subprocess.SubprocessError, ValueError) as exc:
                        warnings.append(
                            f"{number}쪽 로컬 OCR이 완료되지 않았습니다 ({type(exc).__name__}). 설치를 확인하거나 콘텐츠 관리에서 영역을 직접 지정하세요."
                        )
                else:
                    warnings.append(
                        f"{number}쪽은 스캔 이미지이며 OCR을 사용할 수 없습니다. {status['message']} 콘텐츠 관리에서 문항 영역을 직접 지정할 수 있습니다."
                    )
            native = page.rect * page.derotation_matrix
            layout = _Layout(
                number,
                page.rect.width if visual else native.width,
                page.rect.height if visual else native.height,
                page.rect.width,
                page.rect.height,
                fitz.Matrix(1, 1) if visual else page.rotation_matrix,
                lines,
                _graphics(page, visual),
                method,
            )
            if is_scan and visual:
                layout.graphics.extend(_raster_graphics(page))
            text = "\n".join(
                line.text
                for line in sorted(lines, key=lambda line: (line.rect.y0, line.rect.x0))
            )
            heading_lines = [
                line for line in lines if line.rect.y0 < layout.height * 0.2
            ]
            if any(_ANSWERS.fullmatch(line.text) for line in heading_lines):
                layout.kind = "answers"
            elif (
                layouts
                and layouts[-1].kind == "answers"
                and len(lines) >= 3
                and sum(bool(_ANSWER_ENTRY.fullmatch(line.text)) for line in lines)
                >= len(lines) * 0.8
            ):
                layout.kind = "answers"
                warnings.append(
                    f"{number}쪽은 앞쪽 해설에 이어지는 짧은 답안 목록으로 판단해 제외했습니다. 페이지 종류가 맞는지 확인하세요."
                )
            elif method == "manual" or sum(len(line.text) for line in lines) < 25:
                layout.kind = "uncertain"
            items = []
            for line in lines:
                rect = line.rect * layout.transform
                items.append(
                    {
                        "text": line.text,
                        "x": rect.x0,
                        "y": rect.y0,
                        "width": rect.width,
                        "height": rect.height,
                    }
                )
            pages.append(
                {
                    "number": number,
                    "width": page.rect.width,
                    "height": page.rect.height,
                    "text": text,
                    "kind": layout.kind,
                    "items": items,
                    "imageFile": image_file,
                }
            )
            candidates = _questions(layout)
            if layouts:
                _inherit_shared(layouts[-1], layout, questions, candidates, warnings)
                _continue(layouts[-1], layout, questions, warnings)
            questions.extend(candidates)
            layouts.append(layout)
            if layout.kind != "answers" and not candidates and not is_scan:
                warnings.append(
                    f"{number}쪽에서 신뢰할 문항 번호 경계를 찾지 못했습니다. 원본을 보고 콘텐츠 관리에서 문항 영역을 직접 지정하세요."
                )
        for index, question in enumerate(questions):
            emit(
                65 + int(index / max(1, len(questions)) * 34),
                f"{index + 1}/{len(questions)}개 문항 후보의 원본 영역 이미지를 저장하고 있어요.",
            )
            question["cropFiles"] = _render(doc, question["regions"], output_dir)
    if questions:
        warnings.append(
            "자동 감지한 모든 문항은 미확인 후보입니다. 콘텐츠 관리에서 공통 지문·그림·선택지·문항 경계를 확인한 뒤 확정하세요. 임의의 문제집에서 완전한 자동 분리를 보장하지 않습니다."
        )
    duplicate_numbers = [
        number
        for number, count in Counter(q["number"] for q in questions).items()
        if count > 1
    ]
    if duplicate_numbers:
        warnings.append(
            f"중복 문항 번호({', '.join(map(str, sorted(duplicate_numbers)))})가 있습니다. 번호만으로 선택하지 말고 페이지와 원본 영역을 함께 확인하세요."
        )
    emit(100, "페이지와 문항 후보 이미지 저장을 마쳤어요.")
    return {
        "pages": pages,
        "questions": questions,
        "warnings": list(dict.fromkeys(warnings)),
    }
