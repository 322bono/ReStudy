/// <reference types="vite/client" />
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { TextItem, TextStyle } from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import type { Worker as OcrWorker, Page as OcrPage } from "tesseract.js";
import { storagePageText } from "../../domain/pdf-text";

/** Coordinates are fractions of the displayed, rotated PDF page, from top left. */
export interface PageTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
}
export interface PreparedPage {
  number: number;
  width: number;
  height: number;
  text: string;
  items: PageTextItem[];
  kind: "content" | "answers" | "uncertain";
  source: "text" | "ocr";
  image: Blob;
  warnings: string[];
}
export interface Region {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface ProblemCandidate {
  number: number;
  page: number;
  unit: "";
  text: string;
  regions: Region[];
  confidence: number;
  confirmed: false;
  source: "text" | "ocr";
  sharedRegionCount?: number;
}

export type PageProgress = (progress: number, message?: string) => void;
const PAGE_PIXELS = 14_000_000;

function asset(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  return new URL(
    `${base.endsWith("/") ? base : `${base}/`}${path}`,
    document.baseURI,
  ).href;
}

export async function openPdf(
  source: Blob | Uint8Array | string,
): Promise<PDFDocumentProxy> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = asset("pdfjs/pdf.worker.min.mjs");
  const input =
    typeof source === "string"
      ? { url: source }
      : {
          data:
            source instanceof Uint8Array
              ? source.slice()
              : new Uint8Array(await source.arrayBuffer()),
        };
  return pdfjs.getDocument({
    ...input,
    cMapUrl: asset("pdfjs/cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: asset("pdfjs/standard_fonts/"),
    wasmUrl: asset("pdfjs/wasm/"),
    iccUrl: asset("pdfjs/iccs/"),
    enableXfa: false,
  }).promise;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("원본 PNG 이미지를 저장하지 못했습니다.")),
      "image/png",
    ),
  );
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  if (!canvas.getContext("2d"))
    throw new Error("이 브라우저에서 PDF 이미지를 만들 수 없습니다.");
  return canvas;
}

function pageScale(page: PDFPageProxy, preferred: number): number {
  const view = page.getViewport({ scale: 1 });
  return Math.min(
    preferred,
    Math.sqrt(PAGE_PIXELS / (view.width * view.height)),
    12000 / Math.max(view.width, view.height),
  );
}

function nativeItem(
  item: TextItem,
  viewport: PageViewport,
  styles: Record<string, TextStyle>,
): PageTextItem | undefined {
  if (!item.str.trim()) return;
  const [a, b, c, d, e, f] = viewport.transform;
  const t = item.transform;
  const m = [
    a * t[0] + c * t[1],
    b * t[0] + d * t[1],
    a * t[2] + c * t[3],
    b * t[2] + d * t[3],
    a * t[4] + c * t[5] + e,
    b * t[4] + d * t[5] + f,
  ];
  const fontHeight = Math.hypot(m[2], m[3]) || item.height * viewport.scale;
  const advance = Math.hypot(m[0], m[1]) || 1;
  const ux = m[0] / advance,
    uy = m[1] / advance;
  const ascent =
    styles[item.fontName]?.ascent ??
    1 + (styles[item.fontName]?.descent ?? -0.2);
  const vx = Math.hypot(m[2], m[3]) ? m[2] : -uy * fontHeight;
  const vy = Math.hypot(m[2], m[3]) ? m[3] : ux * fontHeight;
  const width = item.width * viewport.scale;
  const corners = [
    [m[4] + vx * ascent, m[5] + vy * ascent],
    [m[4] + ux * width + vx * ascent, m[5] + uy * width + vy * ascent],
    [m[4] + vx * (ascent - 1), m[5] + vy * (ascent - 1)],
    [
      m[4] + ux * width + vx * (ascent - 1),
      m[5] + uy * width + vy * (ascent - 1),
    ],
  ];
  const x = clamp(Math.min(...corners.map((p) => p[0])) / viewport.width);
  const y = clamp(Math.min(...corners.map((p) => p[1])) / viewport.height);
  const x1 = clamp(Math.max(...corners.map((p) => p[0])) / viewport.width);
  const y1 = clamp(Math.max(...corners.map((p) => p[1])) / viewport.height);
  if (x1 <= x || y1 <= y) return;
  return { text: item.str, x, y, width: x1 - x, height: y1 - y };
}

/** PDF.js 6 records each painted image as three normalized parallelogram corners. */
function imageCoverage(
  coordinates: ArrayLike<number> | null | undefined,
): number {
  let largest = 0;
  if (!coordinates) return largest;
  const gridSize = 32,
    covered = new Uint8Array(gridSize * gridSize);
  for (let i = 0; i + 5 < coordinates.length; i += 6) {
    const ax = coordinates[i + 2] - coordinates[i],
      ay = coordinates[i + 3] - coordinates[i + 1];
    const bx = coordinates[i + 4] - coordinates[i],
      by = coordinates[i + 5] - coordinates[i + 1];
    const determinant = ax * by - ay * bx;
    largest = Math.max(largest, Math.abs(determinant));
    if (Math.abs(determinant) < 1e-10) continue;
    const x0 = coordinates[i],
      y0 = coordinates[i + 1];
    const xs = [x0, x0 + ax, x0 + bx, x0 + ax + bx],
      ys = [y0, y0 + ay, y0 + by, y0 + ay + by];
    for (
      let y = Math.floor(clamp(Math.min(...ys)) * gridSize);
      y < Math.ceil(clamp(Math.max(...ys)) * gridSize);
      y++
    ) {
      for (
        let x = Math.floor(clamp(Math.min(...xs)) * gridSize);
        x < Math.ceil(clamp(Math.max(...xs)) * gridSize);
        x++
      ) {
        const dx = (x + 0.5) / gridSize - x0,
          dy = (y + 0.5) / gridSize - y0;
        const u = (dx * by - dy * bx) / determinant,
          v = (ax * dy - ay * dx) / determinant;
        if (u >= 0 && u <= 1 && v >= 0 && v <= 1) covered[y * gridSize + x] = 1;
      }
    }
  }
  // Union coverage catches tiled scans without double-counting repeated logos.
  return Math.max(
    largest,
    covered.reduce((total, value) => total + value, 0) / covered.length,
  );
}

let ocrWorker: OcrWorker | undefined;
let ocrWorkerPromise: Promise<OcrWorker> | undefined;
let ocrController = new AbortController();
let ocrQueue: Promise<unknown> = Promise.resolve();
let ocrProgress: PageProgress | undefined;

function aborted(): DOMException {
  return new DOMException("PDF OCR 작업을 중단했습니다.", "AbortError");
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted());
    signal.addEventListener("abort", cancel, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", cancel));
  });
}

async function worker(signal: AbortSignal): Promise<OcrWorker> {
  if (!ocrWorkerPromise) {
    let rejectInitialization!: (reason: Error) => void;
    const initializationError = new Promise<never>((_, reject) => {
      rejectInitialization = reject;
    });
    const creating = import("tesseract.js")
      .then(({ createWorker }) =>
        createWorker(["kor", "eng"], 1, {
          workerPath: asset("ocr/worker.min.js"),
          corePath: asset("ocr/core/"),
          langPath: asset("ocr/lang/"),
          workerBlobURL: false,
          gzip: true,
          logger: ({ progress, status }) => {
            if (!signal.aborted)
              ocrProgress?.(
                0.3 + clamp(progress) * 0.65,
                status === "recognizing text"
                  ? "문자와 문제 번호를 읽고 있어요."
                  : "한국어·영어 OCR을 준비하고 있어요.",
              );
          },
          // Tesseract 7 does not reject its creation promise for every language-load
          // failure. Race that callback so a missing local language remains retryable.
          errorHandler: () =>
            rejectInitialization(
              new Error("로컬 OCR 초기화 또는 인식에 실패했습니다."),
            ),
        }),
      )
      .then(async (created) => {
        if (signal.aborted) {
          await created.terminate();
          throw aborted();
        }
        await created.setParameters({
          tessedit_pageseg_mode: "3" as import("tesseract.js").PSM,
          preserve_interword_spaces: "1",
          user_defined_dpi: "216",
        });
        if (signal.aborted) {
          await created.terminate();
          throw aborted();
        }
        ocrWorker = created;
        return created;
      });
    const pending = Promise.race([creating, initializationError]);
    ocrWorkerPromise = pending;
    void pending.catch(() => {
      if (ocrWorkerPromise === pending) {
        ocrWorkerPromise = undefined;
        ocrWorker = undefined;
      }
    });
  }
  return abortable(ocrWorkerPromise, signal);
}

function ocrItems(
  data: OcrPage,
  width: number,
  height: number,
): PageTextItem[] {
  const result: PageTextItem[] = [];
  for (const block of data.blocks ?? [])
    for (const paragraph of block.paragraphs ?? [])
      for (const line of paragraph.lines ?? []) {
        if (!line.text.trim() || line.confidence < 30) continue;
        const x = clamp(line.bbox.x0 / width),
          y = clamp(line.bbox.y0 / height);
        const x1 = clamp(line.bbox.x1 / width),
          y1 = clamp(line.bbox.y1 / height);
        if (x1 > x && y1 > y)
          result.push({
            text: line.text.trim(),
            x,
            y,
            width: x1 - x,
            height: y1 - y,
            confidence: clamp(line.confidence / 100),
          });
      }
  return result;
}

async function recognize(
  canvas: HTMLCanvasElement,
  onProgress: PageProgress | undefined,
  signal: AbortSignal,
): Promise<{ items: PageTextItem[]; text: string }> {
  const run = ocrQueue.then(async () => {
    if (signal.aborted) throw aborted();
    ocrProgress = onProgress;
    try {
      const current = await worker(signal);
      const result = await abortable(
        current.recognize(canvas, {}, { text: true, blocks: true }),
        signal,
      );
      return {
        items: ocrItems(result.data, canvas.width, canvas.height),
        text: result.data.text.trim(),
      };
    } finally {
      ocrProgress = undefined;
    }
  });
  ocrQueue = run.catch(() => undefined);
  return abortable(run, signal);
}

/** Stops in-flight/queued OCR; the next page starts a fresh local worker. */
export async function closeOcr(): Promise<void> {
  const active = ocrWorker;
  ocrController.abort();
  ocrController = new AbortController();
  ocrWorker = undefined;
  ocrWorkerPromise = undefined;
  ocrProgress = undefined;
  ocrQueue = Promise.resolve();
  if (active) await active.terminate();
}

/** Produces a page checkpoint without any network AI or database operations. */
export async function preparePage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  onProgress?: PageProgress,
): Promise<PreparedPage> {
  validatePage(pdf, pageNumber);
  const signal = ocrController.signal;
  onProgress?.(0, "원본 페이지를 준비하고 있어요.");
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  if (signal.aborted) throw aborted();
  let items = content.items.flatMap((item) => {
    if (!("str" in item)) return [];
    const parsed = nativeItem(item, viewport, content.styles);
    return parsed ? [parsed] : [];
  });
  onProgress?.(0.1, "원본 이미지를 저장하고 있어요.");
  const renderView = page.getViewport({ scale: pageScale(page, 3) });
  const canvas = makeCanvas(renderView.width, renderView.height);
  const render = page.render({
    canvas,
    viewport: renderView,
    annotationMode: 0,
    background: "white",
    recordImages: true,
  });
  const cancelRender = () => render.cancel();
  signal.addEventListener("abort", cancelRender, { once: true });
  try {
    await abortable(render.promise, signal);
    const image = await canvasBlob(canvas);
    const count = items.reduce(
      (sum, i) => sum + i.text.replace(/\s/g, "").length,
      0,
    );
    const scan = imageCoverage(page.imageCoordinates) > 0.5 && count < 220;
    let source: PreparedPage["source"] = "text";
    const warnings: string[] = [];
    let text = [...items]
      .sort(order)
      .map((i) => i.text)
      .join("\n");
    if (scan || count < 12) {
      source = "ocr";
      onProgress?.(0.3, "한국어·영어 OCR로 원본을 읽고 있어요.");
      try {
        const recognized = await recognize(canvas, onProgress, signal);
        items = recognized.items;
        text = recognized.text;
      } catch (error) {
        if (
          signal.aborted ||
          (error instanceof Error && error.name === "AbortError")
        )
          throw aborted();
        // No substitute text or success checkpoint: callers can retry this page.
        throw new Error(
          `${pageNumber}쪽 OCR에 실패했습니다. OCR 파일을 확인하고 이 페이지를 다시 시도하세요.`,
          { cause: error },
        );
      }
      warnings.push(
        "OCR 후보입니다. 문제 번호·수식·지문을 원본 이미지와 비교해 확인하세요.",
      );
    }
    const lines = textLines(items);
    const fallback =
      items.reduce((sum, i) => sum + i.text.trim().length, 0) < 25
        ? "uncertain"
        : "content";
    const kind = pageKind(lines, fallback);
    if (kind === "uncertain")
      warnings.push(
        "읽을 수 있는 글자가 적습니다. 원본을 보고 문항 영역을 직접 확인하세요.",
      );
    if (kind !== "answers" && findAnchors(lines).length === 0)
      warnings.push(
        "확실한 문항 번호 경계를 찾지 못했습니다. 관리 화면에서 문항 영역을 지정하세요.",
      );
    onProgress?.(1, "페이지 원본과 추출 후보를 준비했어요.");
    return storagePageText({
      number: pageNumber,
      width: viewport.width,
      height: viewport.height,
      text,
      items,
      kind,
      source,
      image,
      warnings,
    });
  } finally {
    signal.removeEventListener("abort", cancelRender);
    canvas.width = 0;
    canvas.height = 0;
  }
}

function validatePage(pdf: PDFDocumentProxy, page: number): void {
  if (!Number.isInteger(page) || page < 1 || page > pdf.numPages)
    throw new Error("PDF 페이지 번호가 올바르지 않습니다.");
}

/** Renders clean original PNGs, in region order, without a full-page intermediate. */
export async function renderRegions(
  pdf: PDFDocumentProxy,
  regions: Region[],
): Promise<Blob[]> {
  for (const r of regions) {
    validatePage(pdf, r.page);
    if (
      ![r.x, r.y, r.w, r.h].every(Number.isFinite) ||
      r.x < 0 ||
      r.y < 0 ||
      r.w <= 0 ||
      r.h <= 0 ||
      r.x + r.w > 1 + 1e-9 ||
      r.y + r.h > 1 + 1e-9
    )
      throw new Error("크롭 영역은 페이지 안의 정규화된 좌표여야 합니다.");
  }
  const result: Blob[] = [];
  for (const region of regions) {
    const page = await pdf.getPage(region.page);
    const original = page.getViewport({ scale: 1 });
    const scale = Math.min(
      3,
      Math.sqrt(
        PAGE_PIXELS / (original.width * region.w * original.height * region.h),
      ),
      12000 / Math.max(original.width * region.w, original.height * region.h),
    );
    const viewport = page.getViewport({ scale });
    const canvas = makeCanvas(
      viewport.width * region.w,
      viewport.height * region.h,
    );
    try {
      await page.render({
        canvas,
        viewport,
        annotationMode: 0,
        background: "white",
        transform: [
          1,
          0,
          0,
          1,
          -region.x * viewport.width,
          -region.y * viewport.height,
        ],
      }).promise;
      result.push(await canvasBlob(canvas));
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  return result;
}

const NUMBER =
  /^\s*(?:(?:문제|Question|Q)\s*)?(\d{1,4})\s*(?:[.．](?!\d)|\)|번(?:\s|$))\s*(.*)$/i;
const BARE = /^\s*(\d{1,4})\s*$/;
const NUMERIC_CELL = /^\s*\d+[.)．]?\s*$/;
const RANGE =
  /^(?:\s*[\[【(]|\s*(?:Questions?|문항)\s+)(\d{1,4})\s*[~～\-–—]\s*(\d{1,4})\s*[\]】)]?/i;
const ANSWERS =
  /^\s*(?:정답\s*(?:(?:과|및|[·ㆍ/])\s*해설|해설)?|빠른\s*정답|해답|해설(?:지)?|정답표|Answers?(?:\s*(?:key|sheet))?|Solutions?(?:\s+(?:and\s+)?(?:answers?|explanations?))?)(?:\s*[:：-].*|\s*\d+|\s*)$/i;
const ANSWER_ENTRY =
  /^\s*\d{1,4}\s*(?:[.)．]|번)\s*(?:[①-⑤A-EＯＸOX×○]|[-+]?\d+(?:\.\d+)?)(?:\s*[,;]\s*(?:[①-⑤A-EＯＸOX×○]|[-+]?\d+(?:\.\d+)?))*\s*$/i;
const CHOICE_ANSWER_ENTRY =
  /^\s*\d{1,4}\s*(?:[.)．]|번)\s*[①-⑤A-EＯＸOX×○](?:\s*[,;]\s*[①-⑤A-EＯＸOX×○])*\s*$/i;
const NEXT =
  /continued\s+on\s+(?:the\s+)?next\s+page|다음\s*(?:쪽|페이지).{0,8}(?:계속|이어)|뒷면에\s*계속/i;
const CONTINUED =
  /^\s*[\[(]?(?:continued\b|계속(?:\s|[\])]|$)|앞\s*(?:쪽|페이지).{0,8}(?:계속|이어))/i;
const clamp = (value: number, low = 0, high = 1) =>
  Math.max(low, Math.min(high, value));
const right = (item: PageTextItem) => item.x + item.width;
const bottom = (item: PageTextItem) => item.y + item.height;
const order = (a: PageTextItem, b: PageTextItem) => a.y - b.y || a.x - b.x;

/** Keep table cells separate; join adjacent fragments of an ordinary text line. */
function textLines(items: PageTextItem[]): PageTextItem[] {
  const lines: PageTextItem[] = [];
  for (const source of [...items].sort(order)) {
    if (
      !source.text.trim() ||
      ![source.x, source.y, source.width, source.height].every(Number.isFinite)
    )
      continue;
    const item = { ...source, text: source.text.trim() };
    const previous = lines.findLast(
      (l) =>
        Math.abs(l.y - item.y) <
          Math.max(0.004, Math.min(l.height, item.height) * 0.5) &&
        item.x >= right(l) - 0.002 &&
        item.x - right(l) < Math.max(0.025, item.height * 1.5) &&
        !NUMERIC_CELL.test(l.text) &&
        !NUMERIC_CELL.test(item.text),
    );
    if (previous) {
      previous.text += `${item.x - right(previous) > 0.003 ? " " : ""}${item.text}`;
      previous.width = Math.max(right(previous), right(item)) - previous.x;
      previous.height = Math.max(bottom(previous), bottom(item)) - previous.y;
      previous.confidence = Math.min(
        previous.confidence ?? 1,
        item.confidence ?? 1,
      );
    } else lines.push(item);
  }
  return lines
    .sort(order)
    .filter((l) => !(l.y > 0.94 && /^[\s\-–—]*\d{1,4}[\s\-–—]*$/.test(l.text)));
}

function pageKind(
  lines: PageTextItem[],
  fallback: PreparedPage["kind"],
  previousAnswers = false,
): PreparedPage["kind"] {
  if (
    fallback === "answers" ||
    lines.some(
      (l) =>
        l.y < 0.2 &&
        (ANSWERS.test(l.text) || ANSWERS.test(l.text.replace(/\s/g, ""))),
    )
  )
    return "answers";
  if (
    lines.length >= 3 &&
    lines.filter((l) => CHOICE_ANSWER_ENTRY.test(l.text)).length >=
      lines.length * 0.8
  )
    return "answers";
  // A continued key is excluded only when the preceding page is itself a key.
  if (
    previousAnswers &&
    lines.length >= 3 &&
    lines.filter((l) => ANSWER_ENTRY.test(l.text)).length >= lines.length * 0.8
  )
    return "answers";
  return fallback;
}

interface Anchor {
  number: number;
  line: PageTextItem;
  bare: boolean;
  column: number;
}
interface Shared {
  start: number;
  end: number;
  column: number;
  top: number;
  region: Region;
  text: string;
  fullWidth: boolean;
}
interface Layout {
  page: PreparedPage;
  lines: PageTextItem[];
  anchors: Anchor[];
  columns: [number, number][];
  shared: Shared[];
  kind: PreparedPage["kind"];
}

function findAnchors(lines: PageTextItem[]): Anchor[] {
  const candidates: Anchor[] = [];
  for (const line of lines) {
    if (RANGE.test(line.text)) continue;
    const labelled = NUMBER.exec(line.text),
      bare = BARE.exec(line.text),
      match = labelled || bare;
    if (!match || +match[1] < 1) continue;
    const numberOnly = NUMERIC_CELL.test(line.text);
    const bodyEvidence = lines.some(
      (other) =>
        other !== line &&
        other.x >= right(line) - 0.001 &&
        other.x - right(line) < 0.09 &&
        Math.abs(other.y - line.y) < Math.max(0.004, line.height * 0.7) &&
        /[A-Za-z가-힣]/.test(other.text) &&
        other.text.length >= 4,
    );
    // Separate numeric tokens occur in both genuine columns and table cells.
    // Nearby prose corroborates a question; alignment alone never does.
    if (numberOnly && !bodyEvidence) continue;
    candidates.push({
      number: +match[1],
      line,
      bare: numberOnly || (!!bare && !labelled),
      column: 0,
    });
  }
  return candidates.filter(
    (a) =>
      !(
        a.number <= 5 &&
        /^\s*\d+[).．]/.test(a.line.text) &&
        candidates.some(
          (outer) =>
            outer !== a &&
            outer.line.y < a.line.y - 0.006 &&
            a.line.x - outer.line.x > 0.012 &&
            a.line.x - outer.line.x < 0.18,
        )
      ),
  );
}

function columns(layout: Layout): void {
  const xs = layout.anchors.map((a) => a.line.x).sort((a, b) => a - b);
  let split: number | undefined;
  let largestGap = 0.27;
  for (let i = 0; i < xs.length - 1; i++) {
    const gap = xs[i + 1] - xs[i];
    if (gap <= largestGap) continue;
    largestGap = gap;
    const leftEnds = layout.lines
      .filter((l) => l.x <= xs[i] + 0.025 && right(l) < xs[i + 1] - 0.015)
      .map(right);
    const edge = Math.max(xs[i] + gap * 0.65, ...leftEnds);
    split = clamp((edge + xs[i + 1]) / 2, xs[i] + 0.04, xs[i + 1] - 0.015);
  }
  layout.columns =
    split === undefined
      ? [[0, 1]]
      : [
          [0, split],
          [split, 1],
        ];
  for (const a of layout.anchors)
    a.column = layout.columns.findIndex(
      ([l, r]) => a.line.x >= l && a.line.x < r,
    );
  layout.anchors.sort((a, b) => a.column - b.column || order(a.line, b.line));
}

function area(
  layout: Layout,
  column: number,
  top: number,
  end: number,
  fullWidth = false,
): { region: Region; text: string } {
  const [left, rightEdge] = fullWidth ? [0, 1] : layout.columns[column];
  const y = clamp(top - 0.007),
    y1 = clamp(Math.max(y + 0.01, end - 0.004));
  // Full column bands preserve diagrams, equations and tables omitted by OCR.
  const region = {
    page: layout.page.number,
    x: left,
    y,
    w: rightEdge - left,
    h: y1 - y,
  };
  const text = layout.lines
    .filter(
      (l) =>
        l.x < rightEdge - 0.002 &&
        right(l) > left + 0.002 &&
        l.y >= top - 0.003 &&
        l.y < end - 0.002,
    )
    .map((l) => l.text)
    .join("\n");
  return { region, text };
}

function detectPage(layout: Layout): ProblemCandidate[] {
  if (layout.kind === "answers") return [];
  layout.anchors = findAnchors(layout.lines);
  columns(layout);
  for (const line of layout.lines) {
    const match = RANGE.exec(line.text);
    if (
      !match ||
      +match[1] < 1 ||
      +match[2] < +match[1] ||
      +match[2] - +match[1] > 50
    )
      continue;
    const column = Math.max(
      0,
      layout.columns.findIndex(([l, r]) => line.x >= l && line.x < r),
    );
    const members = layout.anchors.filter(
      (a) =>
        a.number >= +match[1] && a.number <= +match[2] && a.line.y > line.y,
    );
    if (!members.length) continue;
    const first = Math.min(
      ...members.filter((a) => a.column === column).map((a) => a.line.y),
      ...members.map((a) => a.line.y),
    );
    const fullWidth =
      layout.columns.length > 1 &&
      layout.lines.some(
        (l) =>
          l.y >= line.y &&
          l.y < first &&
          l.x < layout.columns[column][1] - 0.013 &&
          right(l) > layout.columns[column][1] + 0.013,
      );
    const crop = area(layout, column, line.y, first, fullWidth);
    layout.shared.push({
      start: +match[1],
      end: +match[2],
      column,
      top: line.y,
      ...crop,
      fullWidth,
    });
  }
  return layout.anchors.map((anchor) => {
    const after = layout.anchors
      .filter(
        (a) =>
          a.column === anchor.column &&
          a.line.y > anchor.line.y + Math.max(0.005, anchor.line.height / 2),
      )
      .map((a) => a.line.y);
    after.push(
      ...layout.shared
        .filter((s) => s.column === anchor.column && s.top > anchor.line.y)
        .map((s) => s.top),
    );
    const crop = area(
      layout,
      anchor.column,
      anchor.line.y,
      Math.min(0.975, ...after),
    );
    const context = layout.shared
      .filter(
        (s) =>
          s.start <= anchor.number &&
          anchor.number <= s.end &&
          (s.fullWidth ||
            s.column < anchor.column ||
            (s.column === anchor.column && s.top < anchor.line.y)),
      )
      .at(-1);
    return {
      number: anchor.number,
      page: layout.page.number,
      unit: "",
      text: context ? `${context.text}\n${crop.text}` : crop.text,
      regions: context ? [{ ...context.region }, crop.region] : [crop.region],
      confidence: Math.min(
        layout.page.source === "ocr" ? 0.58 : 0.76,
        anchor.line.confidence ?? 1,
        anchor.bare ? 0.6 : 1,
        layout.kind === "uncertain" ? 0.45 : 1,
      ),
      confirmed: false,
      source: layout.page.source,
      sharedRegionCount: context ? 1 : 0,
    };
  });
}

/** Finds review candidates from observed markers; never fills missing numbers. */
export function detectProblems(pages: PreparedPage[]): ProblemCandidate[] {
  const questions: ProblemCandidate[] = [];
  let previous: Layout | undefined;
  for (const page of [...pages].sort((a, b) => a.number - b.number)) {
    const lines = textLines(page.items);
    const adjacent = previous && previous.page.number === page.number - 1;
    const layout: Layout = {
      page,
      lines,
      anchors: [],
      columns: [[0, 1]],
      shared: [],
      kind: pageKind(
        lines,
        page.kind,
        !!adjacent && previous?.kind === "answers",
      ),
    };
    const candidates = detectPage(layout);
    if (
      adjacent &&
      previous &&
      previous.kind !== "answers" &&
      layout.kind !== "answers"
    ) {
      const priorPageNumber = previous.page.number;
      const prior = questions.filter((q) => q.page === priorPageNumber);
      const first = layout.anchors[0];
      const preceding = first
        ? lines.filter((l) => l.y < first.line.y - 0.005)
        : [];
      if (
        prior.length &&
        candidates.length &&
        preceding.every((l) => CONTINUED.test(l.text))
      ) {
        for (const shared of previous.shared) {
          const lastNumber = prior.at(-1)!.number;
          if (!(
            shared.start <= lastNumber &&
            lastNumber < shared.end &&
            candidates[0].number === lastNumber + 1
          ))
            continue;
          for (const q of candidates)
            if (
              !q.sharedRegionCount &&
              shared.start <= q.number &&
              q.number <= shared.end
            ) {
              q.regions.unshift({ ...shared.region });
              q.sharedRegionCount = 1;
              q.text = `${shared.text}\n${q.text}`;
              q.confidence = Math.min(q.confidence, 0.6);
            }
          layout.shared.push(shared);
        }
      }
      const last = questions
        .filter((q) => q.regions.at(-1)?.page === priorPageNumber)
        .at(-1);
      const boundary = Math.min(
        0.975,
        ...layout.anchors.filter((a) => a.column === 0).map((a) => a.line.y),
      );
      const topLines = lines.filter(
        (l) => l.x < layout.columns[0][1] && l.y < boundary - 0.005,
      );
      if (
        last &&
        topLines.length &&
        (NEXT.test(last.text) || CONTINUED.test(topLines[0].text))
      ) {
        const continuation = area(layout, 0, topLines[0].y, boundary);
        last.regions.push(continuation.region);
        last.text += `\n${continuation.text}`;
        last.confidence = Math.min(last.confidence, 0.6);
      }
    }
    questions.push(...candidates);
    previous = layout;
  }
  return questions;
}
