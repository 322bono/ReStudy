/// <reference types="vite/client" />
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { acquireAssetUrl, type AssetLease } from "../src/services/api";
import { SecureImage } from "./secure-assets";
/** Saved page images open directly; PDF rendering is only a recovery path. */
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
    [fallback, setFallback] = useState(false),
    [drawn, setDrawn] = useState("");
  useEffect(() => {
    setDrawn("");
    setFallback(false);
  }, [id, mime]);
  useEffect(() => {
    setReady(false);
    if (!fallback || mime !== "application/pdf") return;
    let alive = true;
    let lease: AssetLease | undefined;
    let loaded: PDFDocumentProxy | undefined;
    import("../src/features/pdf/processor")
      .then(async ({ openPdf }) => {
        if (!alive) return;
        lease = await acquireAssetUrl(`materials/${id}/file`);
        if (!alive) {
          lease.release();
          return;
        }
        return openPdf(lease.url);
      })
      .then((pdf) => {
        if (!pdf) return;
        if (!alive) {
          void pdf.loadingTask
            .destroy()
            .catch(() => {})
            .finally(() => lease?.release());
          return;
        }
        loaded = pdf;
        document.current = pdf;
        setReady(true);
      })
      .catch(() => {
        lease?.release();
      });
    return () => {
      alive = false;
      document.current = null;
      if (loaded)
        void loaded.loadingTask
          .destroy()
          .catch(() => {})
          .finally(() => lease?.release());
    };
  }, [id, mime, fallback]);
  useEffect(() => {
    if (!ready || !document.current || !canvas.current || !fallback) return;
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
        hidden={fallback && drawn === `${id}:${page}`}
        path={`materials/${id}/page/${page}`}
        alt={`${title} ${page}쪽 원본`}
        draggable={false}
        onFailure={() => {
          if (mime === "application/pdf") setFallback(true);
        }}
        onLoad={() => setFallback(false)}
      />
      <canvas
        className="original-page-canvas"
        ref={canvas}
        hidden={!fallback || drawn !== `${id}:${page}`}
        role="img"
        aria-label={`${title} ${page}쪽 원본`}
      />
    </>
  );
}
