/// <reference types="vite/client" />
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { TextItem, TextStyle } from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import type { Worker as OcrWorker, Page as OcrPage } from "tesseract.js";
import { storagePageText } from "../../domain/pdf-text";
import { installPdfStreamCompatibility } from "./runtime-compat.mjs";

/** Coordinates are fractions of the displayed, rotated PDF page, from top left. */
export interface PageTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
  fontName?: string;
  fontSize?: number;
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
  words?: PageTextItem[];
  numberMarkers?: PageTextItem[];
  numberLayerVersion?: string;
  preparationPurpose?: "textbook" | "workbook";
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
  installPdfStreamCompatibility();
  // Mozilla supports Safari through its translated/polyfilled legacy bundle.
  // Keep the worker on the same build so it also has the required polyfills.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = `${asset("pdfjs/pdf.worker.legacy.min.mjs")}?v=6.4.299-stream-iterator-v1`;
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
  return { text: item.str, x, y, width: x1 - x, height: y1 - y,fontName:item.fontName,fontSize:fontHeight/viewport.height };
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
): { items: PageTextItem[]; words: PageTextItem[]; text: string } {
  // Tesseract 7's JSON includes non-text/image blocks with no paragraphs.
  // Check the message boundary once; never assume worker collections iterable.
  const collection = (value: unknown, name: string): any[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error(`OCR 결과의 ${name} 배열 형식이 올바르지 않습니다.`);
    return value;
  };
  if (!data || typeof data.text !== "string") throw new Error("OCR 결과의 text 형식이 올바르지 않습니다.");
  const item = (value: any): PageTextItem | undefined => {
    if (!value || typeof value.text !== "string" || !value.text.trim() || !Number.isFinite(value.confidence) || value.confidence < 30) return;
    const box = value.bbox;
    if (!box || ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) return;
    const x = clamp(box.x0 / width), y = clamp(box.y0 / height), x1 = clamp(box.x1 / width), y1 = clamp(box.y1 / height);
    if (x1 <= x || y1 <= y) return;
    return { text: value.text.trim(), x, y, width: x1 - x, height: y1 - y, confidence: clamp(value.confidence / 100) };
  };
  const items: PageTextItem[] = [], words: PageTextItem[] = [];
  for (const block of collection(data.blocks, "blocks"))
    for (const paragraph of collection(block?.paragraphs, "paragraphs"))
      for (const line of collection(paragraph?.lines, "lines")) {
        const parsed = item(line);
        if (parsed) items.push(parsed);
        for (const word of collection(line?.words, "words")) {
          const parsedWord = item(word);
          if (parsedWord) words.push(parsedWord);
        }
      }
  return { items, words, text: data.text.trim() };
}

async function recognize(
  canvas: HTMLCanvasElement,
  onProgress: PageProgress | undefined,
  signal: AbortSignal,
  numeric = false,
): Promise<{ items: PageTextItem[]; words:PageTextItem[];text: string }> {
  const run = ocrQueue.then(async () => {
    if (signal.aborted) throw aborted();
    ocrProgress = onProgress;
    try {
      const current = await worker(signal);
      await current.setParameters({tessedit_pageseg_mode:(numeric?'11':'3') as import('tesseract.js').PSM,tessedit_char_whitelist:numeric?'0123456789':''});
      const result = await abortable(
        current.recognize(canvas, {}, { text: true, blocks: true }),
        signal,
      );
      return ocrItems(result.data, canvas.width, canvas.height);
    } finally {
      ocrProgress = undefined;
    }
  });
  ocrQueue = run.catch(() => undefined);
  return abortable(run, signal);
}

export const NUMBER_LAYER_VERSION='color-digits-2026-11-02-v1';
async function numberLayer(canvas:HTMLCanvasElement,signal:AbortSignal):Promise<PageTextItem[]>{
  const context=canvas.getContext('2d')!,pixels=context.getImageData(0,0,canvas.width,canvas.height);let ink=0;
  for(let i=0;i<pixels.data.length;i+=4){const r=pixels.data[i],g=pixels.data[i+1],b=pixels.data[i+2],hi=Math.max(r,g,b),lo=Math.min(r,g,b),colored=hi-lo>45&&(hi-lo)/Math.max(1,hi)>.25&&lo<170;const v=colored?0:255;if(colored)ink++;pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=v;pixels.data[i+3]=255;
    if(i>0&&i%(canvas.width*4*96)===0){await new Promise(resolve=>setTimeout(resolve,0));if(signal.aborted)throw aborted();}}
  if(ink<6)return[];
  context.putImageData(pixels,0,0);
  const recognized=await recognize(canvas,undefined,signal,true);
  return recognized.items.filter(i=>/^\d{1,4}$/.test(i.text.trim())&&Number(i.text)>0&&(i.confidence??0)>=.55).map(i=>({...i,text:i.text.trim()}));
}
/** A cached scan can repair only its colored number layer without repeating body OCR. */
export async function prepareNumberMarkers(pdf:PDFDocumentProxy,pageNumber:number):Promise<PageTextItem[]>{
  validatePage(pdf,pageNumber);const signal=ocrController.signal,page=await pdf.getPage(pageNumber),view=page.getViewport({scale:pageScale(page,3)}),canvas=makeCanvas(view.width,view.height),render=page.render({canvas,viewport:view,annotationMode:0,background:'white'});
  const cancel=()=>render.cancel();signal.addEventListener('abort',cancel,{once:true});
  try{await abortable(render.promise,signal);return await numberLayer(canvas,signal);}finally{signal.removeEventListener('abort',cancel);canvas.width=canvas.height=0;}
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
  options: { purpose?: "textbook" | "workbook" } = {},
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
    let source: PreparedPage["source"] = "text",words:PageTextItem[]=[];
    const warnings: string[] = [];
    let text = [...items]
      .sort(order)
      .map((i) => i.text)
      .join("\n");
    const textbook = options.purpose === "textbook";
    if (textbook ? count === 0 || (scan && count < 12) : scan || count < 12) {
      source = "ocr";
      onProgress?.(0.3, "한국어·영어 OCR로 원본을 읽고 있어요.");
      try {
        const recognized = await recognize(canvas, onProgress, signal);
        items = recognized.items;
        words = recognized.words;
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
      warnings.push(textbook ? "OCR로 읽은 본문입니다. 개념·수식은 원본 이미지와 비교해 확인하세요." : "OCR 후보입니다. 문제 번호·수식·지문을 원본 이미지와 비교해 확인하세요.");
    }
    const numberMarkers=!textbook&&source==='ocr'?await numberLayer(canvas,signal):[];
    const lines = textLines([...items,...numberMarkers]);
    const fallback =
      items.reduce((sum, i) => sum + i.text.trim().length, 0) < 25
        ? "uncertain"
        : "content";
    const kind = textbook ? fallback : pageKind(lines, fallback);
    if (kind === "uncertain")
      warnings.push(
        textbook ? "읽을 수 있는 본문이 적습니다. 원본의 개념과 수식을 확인하세요." : "읽을 수 있는 글자가 적습니다. 원본을 보고 문항 영역을 직접 확인하세요.",
      );
    if (!textbook && kind !== "answers" && findAnchors(lines).length === 0)
      warnings.push(
        "확실한 문항 번호 경계를 찾지 못했습니다. 관리 화면에서 문항 영역을 지정하세요.",
      );
    onProgress?.(1, textbook ? "페이지 원본과 개념 분석용 본문을 준비했어요." : "페이지 원본과 추출 후보를 준비했어요.");
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
      words,numberMarkers,numberLayerVersion:NUMBER_LAYER_VERSION,
      preparationPurpose: textbook ? "textbook" as const : "workbook" as const,
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
  /^(?:\s*[\[［【(（|｜]|\s*(?:Questions?|문항)\s+)\s*(\d{1,4})\s*[~～\-–—]\s*(\d{1,4})\s*[\]］】)）|｜]?/i;
const BRACKETED_RANGE =
  /^[\[［【(（|｜]\s*\d{1,4}\s*[~～\-–—]\s*\d{1,4}\s*[\]］】)）|｜]/;
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

/** Rejoin an explicit passage heading without joining ordinary numeric cells. */
function joinRangeHeadings(lines: PageTextItem[]): PageTextItem[] {
  const consumed = new Set<PageTextItem>();
  const headings = new Map<PageTextItem, PageTextItem>();
  for (const opener of lines) {
    if (!/^[\[［【(（|｜]\s*(?:\d{1,4}\s*(?:[~～\-–—]\s*)?)?$/.test(opener.text) || consumed.has(opener)) continue;
    const neighbours = lines.filter((line) =>
      line !== opener && line.x >= right(opener) - .002 &&
      Math.abs(line.y - opener.y) < Math.max(.004, opener.height * .45),
    ).sort((a, b) => a.x - b.x);
    const fragments = [opener];
    let heading = { ...opener };
    for (const part of neighbours.slice(0, 4)) {
      if (consumed.has(part) || part.x - right(heading) > .015) break;
      fragments.push(part);
      heading = {
        ...heading,
        text: heading.text + " " + part.text,
        width: right(part) - opener.x,
        height: Math.max(bottom(heading), bottom(part)) - opener.y,
      };
      if (!BRACKETED_RANGE.test(heading.text)) continue;
      headings.set(opener, heading);
      for (const fragment of fragments.slice(1)) consumed.add(fragment);
      break;
    }
  }
  return lines.filter((line) => !consumed.has(line)).map((line) => headings.get(line) ?? line);
}

/** Keep table cells separate; join adjacent fragments of an ordinary text line. */
function textLines(items: PageTextItem[]): PageTextItem[] {
  const fragments = items
    .filter((item) => item.text.trim() &&
      [item.x, item.y, item.width, item.height].every(Number.isFinite))
    .map((item) => ({ ...item, text: item.text.trim() }))
    .sort(order);
  const lines: PageTextItem[] = [];
  // Generic line joining skips numeric cells, which can move the separator
  // across a narrow number in a split range heading.
  for (const item of joinRangeHeadings(fragments)) {
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

const QUESTION_INTENT = /[?？]|(?:구하|고르|쓰|적으|답하|서술하|계산하|찾으|선택하|설명하|비교하|확인하|판단하|읽으|보|연결하)(?:시오|세요|라)|(?:첫|다음|둘째|새로운|왼쪽|오른쪽|번째)\s*문제|\b(?:find|solve|calculate|choose|select|determine|explain|what|which|how|why|fill|complete|write|read|answer)\b/i;
const EXPLICIT_MARKER = /^\s*(?:문제|문항|Question|Q)\s*(\d{1,4})(?:[.:．)]|\s|$)\s*(.*)$/i;
const CHOICE = /^\s*([①-⑤])(?:\s|[가-힣A-Za-z(]|$)/;
const BOX_ENTRY = /^\s*(?:[ㄱ-ㅎ][.)．]|[㉠-㉻][.)．])/;
const BOX_HEADING = /^\s*[<〈《\[【(]?\s*보\s*기\s*[>〉》\]】)]?\s*$/;

/** PDF textbooks often use a separate, large font for isolated number badges.
 * Confirm the style from multiple actual badges on a page, then reuse it on
 * other pages. Local coordinates and an adjacent stem remain mandatory. */
function badgeStyle(line: PageTextItem, lines: PageTextItem[]): string | undefined {
  if (!line.fontName || !/^\d{2,3}$/.test(line.text) || +line.text < 1 ||
      line.y < .045 || line.y > .92 || line.width > .075) return;
  const stem = lines.some((body) =>
    body !== line && body.x >= line.x - .012 && body.x < right(line) + .05 &&
    body.y >= line.y - .009 && body.y < line.y + .053 &&
    body.width > .09 && line.height >= body.height * 1.2 &&
    /[가-힣]{2,}|[a-z]{4,}/i.test(body.text) &&
    !CHOICE.test(body.text) && !BOX_ENTRY.test(body.text) && !marker(body),
  );
  if (stem) return line.fontName;
}

function trustedBadgeStyles(layouts: Layout[]): Set<string> {
  const styles = new Set<string>();
  for (const layout of layouts) {
    if (layout.kind === "answers") continue;
    const byFont = new Map<string, PageTextItem[]>();
    for (const line of layout.lines) {
      const style = badgeStyle(line, layout.lines);
      if (style) byFont.set(style, [...(byFont.get(style) ?? []), line]);
    }
    for (const [font, badges] of byFont) {
      if (badges.some((a) => badges.some((b) => a !== b &&
        Math.abs(a.x - b.x) < .027 && Math.abs(a.y - b.y) > .07 &&
        Math.abs(+a.text - +b.text) === 1))) styles.add(font);
    }
  }
  return styles;
}

function marker(line:PageTextItem): {number:number;tail:string;bare:boolean;explicit:boolean}|undefined {
  const explicit=EXPLICIT_MARKER.exec(line.text),normal=NUMBER.exec(line.text);
  const circle=/^\s*([①-⑳])\s*(.*)$/.exec(line.text);
  const separated=/^\s*(\d{1,4})(?:\s+(.+)|([^\d\s.]{1,5}))?\s*$/.exec(line.text);
  const m=explicit||normal||separated;
  if(circle)return{number:circle[1].charCodeAt(0)-'①'.charCodeAt(0)+1,tail:circle[2],bare:false,explicit:false};
  if(!m||+m[1]<1)return;
  return{number:+m[1],tail:m[2]||'',bare:!!separated&&!explicit&&!normal||NUMERIC_CELL.test(line.text),explicit:!!explicit};
}
function findAnchors(lines: PageTextItem[], badgeStyles: ReadonlySet<string> = new Set()): Anchor[] {
  const candidates: Anchor[] = [];
  const badges = lines.filter((line) => line.fontName && badgeStyles.has(line.fontName) && badgeStyle(line, lines));
  if (badges.length) {
    // Numbered choices and table cells can have the same left edge, but they
    // do not share the badge font. Explicit labels can coexist on this page.
    return [...badges, ...lines.filter((line) => EXPLICIT_MARKER.test(line.text))]
      .map((line) => ({ number: marker(line)!.number, line, bare: badges.includes(line), column: 0 }));
  }
  for (const line of lines) {
    if (RANGE.test(line.text) || BOX_ENTRY.test(line.text)) continue;
    const parsed=marker(line);if(!parsed)continue;
    if(parsed.bare&&(line.y<.035||line.y>.91))continue;
    const aligned=lines.filter(other=>other!==line&&other.x>=line.x-.025&&other.x<=line.x+.09&&other.y>line.y+line.height*.55&&other.y-line.y<Math.max(.055,line.height*3.2)).sort(order);
    const stop=aligned.findIndex(other=>!!marker(other));
    const below=(stop<0?aligned:aligned.slice(0,stop)).slice(0,4);
    const beside=lines.filter(other=>other!==line&&other.x>=right(line)-.001&&other.x-right(line)<.09&&Math.abs(other.y-line.y)<Math.max(.004,line.height*.7));
    const context=[parsed.tail,...beside.map(l=>l.text),...below.map(l=>l.text)].join(' ');
    const firstProse=below.find(l=>/[A-Za-z가-힣]/.test(l.text)&&l.text.length>=4);
    // A circled label inside a choice grid can borrow the next stem's
    // question wording. Require question wording on its own line.
    if (CHOICE.test(line.text) && !QUESTION_INTENT.test(parsed.tail)) continue;
    const prominent=parsed.bare&&parsed.number>=10&&firstProse&&line.height>=firstProse.height*1.18&&Math.abs(firstProse.x-line.x)<.035;
    if(!parsed.explicit&&!QUESTION_INTENT.test(context)&&!prominent)continue;
    // Numeric fragments need an actual nearby stem, never alignment alone.
    if(parsed.bare&&!beside.length&&!firstProse)continue;
    candidates.push({number:parsed.number,line,bare:parsed.bare,column:0});
  }
  // An observed marker may survive bad stem OCR when two nearby question
  // numbers corroborate its style/column. Never synthesize a missing number.
  const proven=[...candidates];
  for(const line of lines){const p=marker(line);if(!p?.bare||line.y<.035||line.y>.91||candidates.some(a=>a.line===line))continue;
    const neighbours=proven.filter(a=>a.number!==p.number&&Math.abs(a.number-p.number)<=2);
    if(new Set(neighbours.map(a=>a.number)).size>=2&&neighbours.some(a=>Math.abs(a.line.x-line.x)<.03&&line.height>=a.line.height*.75&&line.height<=a.line.height*1.6))candidates.push({number:p.number,line,bare:true,column:0});
  }
  const unique:Anchor[]=[];
  const overlaps=(a:Anchor,b:Anchor)=>Math.abs(a.line.x-b.line.x)<.025&&Math.abs(a.line.y-b.line.y)<Math.max(.009,Math.min(a.line.height,b.line.height)*.8);
  const support=(a:Anchor)=>new Set(candidates.filter(b=>!overlaps(a,b)&&b.number!==a.number&&Math.abs(b.number-a.number)<=5).map(b=>b.number)).size;
  for(const candidate of candidates.sort((a,b)=>support(b)-support(a)||(b.line.confidence??1)-(a.line.confidence??1)))if(!unique.some(a=>overlaps(a,candidate)))unique.push(candidate);
  return unique.filter(a=>!(a.number<=10&&unique.some(outer=>outer!==a&&outer.line.y<a.line.y-.006&&a.line.x-outer.line.x>.012&&a.line.x-outer.line.x<.18)));
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
  const inColumn = (line: PageTextItem) => line.x >= left && line.x < rightEdge;
  const lastChoice = layout.lines.findLast(
    (line) => inColumn(line) && line.y >= top && line.y < end && CHOICE.test(line.text),
  );
  const footer = layout.lines.find((line) =>
    line.y > .9 && line.y > top + .025 && line.y < end &&
    (!lastChoice || line.y - .008 > bottom(lastChoice)) &&
    !layout.anchors.some((anchor) => anchor.line === line) &&
    (BARE.test(line.text) || /^\d{1,4}\s+[^\d]/.test(line.text) || /\s\d{1,4}$/.test(line.text)),
  );
  if (footer) end = footer.y - .004;
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

function detectPage(layout: Layout, badgeStyles: Set<string>): ProblemCandidate[] {
  if (layout.kind === "answers") return [];
  layout.anchors = findAnchors(layout.lines, badgeStyles);
  layout.lines=layout.lines.filter(line=>{const parsed=marker(line);return !parsed||!layout.anchors.some(a=>a.number!==parsed.number&&Math.abs(a.line.x-line.x)<.025&&Math.abs(a.line.y-line.y)<Math.max(.009,Math.min(a.line.height,line.height)*.8));});
  columns(layout);
  const rangeStarts: { column: number; top: number }[] = [];
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
    rangeStarts.push({ column, top: line.y });
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
      ...rangeStarts
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

function continuationStart(lines: PageTextItem[], previous: ProblemCandidate | undefined) {
  const first = lines.find((line) => line.y >= .045);
  if (!first || !previous) return;
  const nextChoice = CHOICE.exec(first.text)?.[1];
  const priorLines = previous.text.split("\n");
  const priorChoices = priorLines.flatMap((line) => CHOICE.exec(line)?.[1] ?? []);
  const lastChoice = priorChoices.at(-1);
  if (nextChoice && lastChoice && nextChoice.charCodeAt(0) === lastChoice.charCodeAt(0) + 1) return first;
  if (BOX_ENTRY.test(first.text) && /[\[<〈]\s*보기\s*[\]>〉]|보기에서/.test(previous.text) &&
      (priorLines.some((line) => BOX_HEADING.test(line)) || !priorChoices.length)) return first;
}

/** Finds review candidates from observed markers; never fills missing numbers. */
export function detectProblems(pages: PreparedPage[], chapterStarts: number[] = []): ProblemCandidate[] {
  const questions: ProblemCandidate[] = [];
  const layouts: Layout[] = [];
  for (const page of [...pages].sort((a, b) => a.number - b.number)) {
    const lines = textLines([...page.items,...(page.numberMarkers??[])]);
    const previous = layouts.at(-1);
    layouts.push({
      page,
      lines,
      anchors: [],
      columns: [[0, 1]],
      shared: [],
      kind: pageKind(
        lines,
        page.kind,
        previous?.page.number === page.number - 1 && previous.kind === "answers",
      ),
    });
  }
  const styles = trustedBadgeStyles(layouts);
  const starts = new Set(chapterStarts);
  for (const [index, layout] of layouts.entries()) {
    const previous = layouts[index - 1];
    const page = layout.page, lines = layout.lines;
    const candidates = detectPage(layout, styles);
    if (layout.columns.length === 2) {
      const firstRight = layout.anchors.findIndex((anchor) => anchor.column === 1);
      if (firstRight > 0) {
        const lastLeft = candidates[firstRight - 1];
        const boundary = layout.anchors[firstRight].line.y;
        const topRight = lines.filter((line) => line.x >= layout.columns[1][0] && line.y < boundary - .005);
        const first = continuationStart(topRight, lastLeft);
        if (first) {
          const continuation = area(layout, 1, first.y, boundary);
          lastLeft.regions.push(continuation.region);
          lastLeft.text += `\n${continuation.text}`;
          lastLeft.confidence = Math.min(lastLeft.confidence, .6);
        }
      }
    }
    if (
      previous &&
      previous.page.number === page.number - 1 &&
      !starts.has(page.number) &&
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
      const firstContent = continuationStart(topLines, last);
      if (
        last &&
        topLines.length &&
        (NEXT.test(last.text) || CONTINUED.test(topLines[0].text) || firstContent)
      ) {
        const continuation = area(layout, 0, (firstContent ?? topLines[0]).y, boundary);
        last.regions.push(continuation.region);
        last.text += `\n${continuation.text}`;
        last.confidence = Math.min(last.confidence, 0.6);
      }
    }
    questions.push(...candidates);
  }
  return questions;
}
