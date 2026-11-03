import { afterEach, expect, it, vi } from "vitest";
import { mkdir, cp } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { openPdf, preparePage, renderRegions } from "../src/features/pdf/processor";
import { writePdfWorkerAsset } from "../scripts/pdf-worker-asset.mjs";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("reads, prepares and crops a real PDF when native stream async iteration is unavailable", async () => {
  // Node 24, like Safari 18, lacks modern Map/typed-array helpers required by
  // the generic PDF.js 6 build. Its supported legacy build supplies these.
  // Safari 18 has ReadableStream/getReader, but no async iterator. PDF.js 6's
  // getTextContent uses for-await directly, which its legacy build does not shim.
  class SafariReadableStream<R> extends ReadableStream<R> {}
  Object.defineProperties(SafariReadableStream.prototype, {
    [Symbol.asyncIterator]: { value: undefined, configurable: true },
    values: { value: undefined, configurable: true },
  });
  vi.stubGlobal("ReadableStream", SafariReadableStream);
  const directory = resolve("test-results/pdf-runtime/pdfjs");
  await mkdir(directory, { recursive: true });
  writePdfWorkerAsset(resolve(directory, "pdf.worker.legacy.min.mjs"));
  await cp(resolve("node_modules/pdfjs-dist/standard_fonts"), resolve(directory, "standard_fonts"), { recursive: true });
  vi.stubGlobal("document", {
    baseURI: pathToFileURL(resolve("index.html")).href,
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`Unexpected test element: ${tag}`);
      return createCanvas(1, 1);
    },
  });
  vi.stubEnv("BASE_URL", "./test-results/pdf-runtime/");
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  const sourcePage = source.addPage([600, 800]);
  sourcePage.drawText("Concept native body", { x: 40, y: 700, size: 18, font });
  sourcePage.drawRectangle({ x: 100, y: 600, width: 80, height: 60, color: rgb(1, 0, 0) });
  const pdf = await openPdf(await source.save());
  try {
    const content = await (await pdf.getPage(1)).getTextContent();
    expect(content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" ")).toBe("Concept native body");
    const prepared = await preparePage(pdf, 1, undefined, { purpose: "textbook" });
    expect(prepared.source).toBe("text");
    expect(prepared.text).toBe("Concept native body");
    expect(prepared.image.type).toBe("image/png");
    const [crop] = await renderRegions(pdf, [{ page: 1, x: 0.1, y: 0.1, w: 0.4, h: 0.3 }]);
    const image = await loadImage(Buffer.from(await crop.arrayBuffer()));
    expect([image.width, image.height]).toEqual([720, 720]);
    const inspection = createCanvas(image.width, image.height), context = inspection.getContext("2d");
    context.drawImage(image, 0, 0);
    expect(Array.from(context.getImageData(180, 300, 1, 1).data)).toEqual([255, 0, 0, 255]);
  } finally { await pdf.loadingTask.destroy(); }
});
