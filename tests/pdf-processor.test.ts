import { afterEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  getDocument: vi.fn(),
  workerOptions: { workerSrc: "" },
}));
vi.mock("tesseract.js", () => ({ createWorker: mocks.createWorker }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: mocks.workerOptions,
  AnnotationMode: { DISABLE: 0 },
  getDocument: mocks.getDocument,
}));
import {
  closeOcr,
  openPdf,
  preparePage,
  renderRegions,
} from "../src/features/pdf/processor";

function fixture(nativeText: string, imageCoordinates: number[] = []) {
  const render = vi.fn((_options: unknown) => ({
    promise: Promise.resolve(),
    cancel: vi.fn(),
  }));
  const textItem = (str: string, y: number) => ({
    str,
    transform: [1, 0, 0, 12, 30, y],
    width: 300,
    height: 12,
    fontName: "font",
    dir: "ltr",
    hasEOL: true,
  });
  const pdfPage = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
      scale,
      transform: [scale, 0, 0, -scale, 0, 800 * scale],
    }),
    getTextContent: vi.fn(async () => ({
      items: nativeText ? [textItem(nativeText, 700)] : [],
      styles: { font: { ascent: 0.8 } },
    })),
    imageCoordinates,
    render,
  };
  const pdf = {
    numPages: 1,
    getPage: vi.fn(async () => pdfPage),
  } as unknown as PDFDocumentProxy;
  const canvas = () => ({
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: vi.fn() }),
    toBlob: (callback: (blob: Blob) => void) =>
      callback(new Blob(["PNG"], { type: "image/png" })),
  });
  vi.stubGlobal("document", {
    baseURI: "https://restudy.example/Restudy/",
    createElement: vi.fn(canvas),
  });
  return { pdf, pdfPage, render };
}

afterEach(async () => {
  await closeOcr();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("browser PDF preprocessing", () => {
  it("uses usable native text without OCR and renders the original without annotations", async () => {
    const { pdf, render } = fixture(
      "17. Find the solution to the following equation.",
    );
    const page = await preparePage(pdf, 1);
    expect(page.source).toBe("text");
    expect(page.items[0].x).toBeCloseTo(0.05);
    expect(page.items[0].y).toBeCloseTo((800 - 700 - 9.6) / 800);
    expect(page.items[0].width).toBeCloseTo(0.5);
    expect(page.image.type).toBe("image/png");
    expect(mocks.createWorker).not.toHaveBeenCalled();
    expect(render.mock.calls[0][0]).toMatchObject({
      annotationMode: 0,
      background: "white",
    });
  });

  it("OCRs a full scan even when it has a tiny native overlay, then reuses the local worker", async () => {
    const { pdf } = fixture("scanned", [0, 0, 0, 1, 1, 0]);
    const recognize = vi.fn(
      async (_image: unknown, _options: unknown, _output: unknown) => ({
        data: {
          text: "27. 원본 문제",
          confidence: 85,
          blocks: [
            {
              paragraphs: [
                {
                  lines: [
                    {
                      text: "27. 원본 문제",
                      confidence: 85,
                      bbox: { x0: 90, y0: 300, x1: 900, y1: 360 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
    mocks.createWorker.mockResolvedValue({
      recognize,
      setParameters: vi.fn(),
      terminate: vi.fn(),
    });
    const first = await preparePage(pdf, 1);
    const second = await preparePage(pdf, 1);
    expect(first.source).toBe("ocr");
    expect(first.text).toContain("27.");
    expect(first.items[0].confidence).toBe(0.85);
    expect(second.source).toBe("ocr");
    expect(mocks.createWorker).toHaveBeenCalledTimes(1);
    expect(mocks.createWorker.mock.calls[0][2]).toMatchObject({
      workerBlobURL: false,
      gzip: true,
    });
    for (const key of ["workerPath", "corePath", "langPath"])
      expect(mocks.createWorker.mock.calls[0][2][key]).toMatch(
        /^https:\/\/restudy\.example\//,
      );
    expect(recognize.mock.calls[0][2]).toMatchObject({ blocks: true });
  });

  it("recognizes tiled scans without counting overlapping small logos as a scan", async () => {
    const { pdf, pdfPage } = fixture(
      "Copyright small overlay",
      [0, 0, 0, 1, 0.5, 0, 0.5, 0, 0.5, 1, 1, 0],
    );
    mocks.createWorker.mockResolvedValue({
      setParameters: vi.fn(),
      terminate: vi.fn(),
      recognize: vi.fn(async () => ({
        data: { text: "27. Scan", blocks: [] },
      })),
    });
    expect((await preparePage(pdf, 1)).source).toBe("ocr");
    pdfPage.imageCoordinates = Array.from({ length: 10 }, () => [
      0, 0, 0, 0.1, 0.1, 0,
    ]).flat();
    expect((await preparePage(pdf, 1)).source).toBe("text");
  });

  it("does not start rendering after cancellation while native text is still loading", async () => {
    const { pdf, pdfPage, render } = fixture(
      "17. Enough original text to keep the native layer.",
    );
    let finish!: () => void;
    const loading = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const content = await pdfPage.getTextContent();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    pdfPage.getTextContent.mockImplementation(async () => {
      entered();
      await loading;
      return content;
    });
    const pending = preparePage(pdf, 1);
    const cancelled = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await started;
    await closeOcr();
    finish();
    await cancelled;
    expect(render).not.toHaveBeenCalled();
  });

  it("settles language initialization errors even when the library creation promise does not reject", async () => {
    const { pdf } = fixture("");
    mocks.createWorker.mockImplementation(
      (
        _langs: unknown,
        _engine: unknown,
        options: { errorHandler: (error: Error) => void },
      ) => {
        queueMicrotask(() =>
          options.errorHandler(new Error("language unavailable")),
        );
        return new Promise(() => {});
      },
    );
    await expect(preparePage(pdf, 1)).rejects.toThrow(/OCR/);
  });

  it("rejects OCR failure so persistence can retry the failed page", async () => {
    const { pdf } = fixture("");
    mocks.createWorker.mockRejectedValue(
      new Error("local OCR assets unavailable"),
    );
    await expect(preparePage(pdf, 1)).rejects.toThrow(/OCR/);
  });

  it("closeOcr cancels active work promptly and allows a fresh worker", async () => {
    const { pdf } = fixture("");
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const terminate = vi.fn(async () => undefined);
    mocks.createWorker.mockResolvedValue({
      setParameters: vi.fn(),
      terminate,
      recognize: vi.fn(() => {
        started();
        return new Promise(() => {});
      }),
    });
    const pending = preparePage(pdf, 1);
    const cancelled = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await ready;
    await closeOcr();
    await cancelled;
    expect(terminate).toHaveBeenCalledTimes(1);
    mocks.createWorker.mockResolvedValue({
      setParameters: vi.fn(),
      terminate: vi.fn(),
      recognize: vi.fn(async () => ({
        data: { text: "", confidence: 0, blocks: [] },
      })),
    });
    expect((await preparePage(pdf, 1)).kind).toBe("uncertain");
    expect(mocks.createWorker).toHaveBeenCalledTimes(2);
  });

  it("validates every region before starting any PDF work", async () => {
    const { pdf } = fixture("1. Problem");
    const first = { page: 1, x: 0.1, y: 0.1, w: 0.4, h: 0.4 };
    await expect(
      renderRegions(pdf, [first, { ...first, x: 0.9 }]),
    ).rejects.toThrow();
    expect(pdf.getPage).not.toHaveBeenCalled();
    await expect(renderRegions(pdf, [{ ...first, page: 2 }])).rejects.toThrow();
    await expect(
      renderRegions(pdf, [{ ...first, h: Number.NaN }]),
    ).rejects.toThrow();
  });

  it("renders each normalized crop directly from the PDF at high resolution", async () => {
    const { pdf, render } = fixture("1. Problem");
    const blobs = await renderRegions(pdf, [
      { page: 1, x: 0.1, y: 0.2, w: 0.4, h: 0.3 },
    ]);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe("image/png");
    expect(render.mock.calls[0][0]).toMatchObject({
      annotationMode: 0,
      transform: [1, 0, 0, 1, -180, -480],
    });
  });

  it("copies caller bytes to keep the original data from being transferred away", async () => {
    fixture("");
    const bytes = new Uint8Array([37, 80, 68, 70]);
    mocks.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1 }),
    });
    await openPdf(bytes);
    expect(mocks.getDocument.mock.calls[0][0].data).toEqual(bytes);
    expect(mocks.getDocument.mock.calls[0][0].data).not.toBe(bytes);
    expect(mocks.getDocument.mock.calls[0][0]).toMatchObject({
      enableXfa: false,
    });
  });
});
