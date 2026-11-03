import { readFileSync, writeFileSync } from "node:fs";

/** The worker has independent prototypes, so it needs the same stream bridge. */
export function writePdfWorkerAsset(target) {
  const compatibility = readFileSync(new URL("../src/features/pdf/runtime-compat.mjs", import.meta.url), "utf8");
  const vendor = readFileSync(new URL("../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url), "utf8");
  writeFileSync(target, `${compatibility}\ninstallPdfStreamCompatibility();\n${vendor}`);
}
