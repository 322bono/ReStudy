import { afterEach, expect, it, vi } from "vitest";
import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { openPdf } from "../src/features/pdf/processor";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("opens and reads a real native PDF without relying on the newest browser built-ins", async () => {
  // Node 24, like Safari 18, lacks modern Map/typed-array helpers required by
  // the generic PDF.js 6 build. Its supported legacy build supplies these.
  const directory = resolve("test-results/pdf-runtime/pdfjs");
  await mkdir(directory, { recursive: true });
  await copyFile(resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"), resolve(directory, "pdf.worker.legacy.min.mjs"));
  await copyFile(resolve("node_modules/pdfjs-dist/build/pdf.worker.min.mjs"), resolve(directory, "pdf.worker.min.mjs"));
  vi.stubGlobal("document", { baseURI: pathToFileURL(resolve("index.html")).href });
  vi.stubEnv("BASE_URL", "./test-results/pdf-runtime/");
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  source.addPage([600, 800]).drawText("Concept native body", { x: 40, y: 700, size: 18, font });
  const pdf = await openPdf(await source.save());
  try {
    const content = await (await pdf.getPage(1)).getTextContent();
    expect(content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" ")).toBe("Concept native body");
  } finally { await pdf.loadingTask.destroy(); }
});
