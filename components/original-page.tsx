/// <reference types="vite/client" />
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { assetUrl } from "../src/services/api";
import { SecureImage } from "./secure-assets";
/** The PDF and worker stay on this computer; saved page PNGs cover image files and render failures. */
export function OriginalPage({
  id,
  page,
  title,
  mime,
  zoom,
}: {
  id: string;
  page: number;
  title: string;
  mime: string;
  zoom: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const document = useRef<PDFDocumentProxy | null>(null);
  const [ready, setReady] = useState(false),
    [fallback, setFallback] = useState(mime !== "application/pdf"),
    [drawn, setDrawn] = useState("");
  useEffect(() => {
    setReady(false);
    setDrawn("");
    setFallback(mime !== "application/pdf");
    if (mime !== "application/pdf") return;
    let alive = true;
    let task: PDFDocumentLoadingTask | undefined;
    import("pdfjs-dist/legacy/build/pdf.mjs")
      .then(async (pdfjs) => {
        if (!alive) return;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        task = pdfjs.getDocument({
          url: await assetUrl(`materials/${id}/file`),
          cMapUrl: import.meta.env.BASE_URL + "pdfjs/cmaps/",
          standardFontDataUrl:
            import.meta.env.BASE_URL + "pdfjs/standard_fonts/",
          wasmUrl: import.meta.env.BASE_URL + "pdfjs/wasm/",
          iccUrl: import.meta.env.BASE_URL + "pdfjs/iccs/",
        });
        return task.promise;
      })
      .then((pdf) => {
        if (!alive || !pdf) return;
        document.current = pdf;
        setReady(true);
      })
      .catch(() => {
        if (alive) setFallback(true);
      });
    return () => {
      alive = false;
      document.current = null;
      void task?.destroy().catch(() => {});
    };
  }, [id, mime]);
  useEffect(() => {
    if (!ready || !document.current || !canvas.current || fallback) return;
    let alive = true;
    let render: { cancel: () => void; promise: Promise<void> } | undefined;
    const pdf = document.current;
    pdf
      .getPage(page)
      .then((p) => {
        if (!alive || !canvas.current) return;
        const viewport = p.getViewport({
          scale: Math.min(3, Math.max(1.5, zoom * window.devicePixelRatio)),
        });
        const el = canvas.current;
        el.width = Math.ceil(viewport.width);
        el.height = Math.ceil(viewport.height);
        render = p.render({ canvas: el, viewport });
        return render.promise;
      })
      .then(() => {
        if (alive) setDrawn(`${id}:${page}`);
      })
      .catch((e) => {
        if (alive && e?.name !== "RenderingCancelledException")
          setFallback(true);
      });
    return () => {
      alive = false;
      render?.cancel();
    };
  }, [id, page, zoom, ready, fallback]);
  return (
    <>
      <SecureImage
        className="original-page-image"
        hidden={!fallback && drawn === `${id}:${page}`}
        path={`materials/${id}/page/${page}`}
        alt={`${title} ${page}쪽 원본`}
        draggable={false}
      />
      <canvas
        className="original-page-canvas"
        ref={canvas}
        hidden={fallback || drawn !== `${id}:${page}`}
        role="img"
        aria-label={`${title} ${page}쪽 원본`}
      />
    </>
  );
}
