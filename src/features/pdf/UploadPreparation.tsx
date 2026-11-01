import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { openPdf } from "./processor";
import { selectPages, tocPages } from "../../domain/pages";
import { Button } from "../../../components/ui";
export type FileOptions = {
  title: string;
  analysisRange: string;
  excludedPages: string;
  tocRange: string;
  analysisMethod: "auto" | "external" | "later";
  printedPageOffset?: number;
};
export const fileKey = (file: File) =>
  `${file.name}:${file.size}:${file.lastModified}`;
export const defaultOptions = (file: File): FileOptions => ({
  title: file.name.replace(/\.[^.]+$/, ""),
  analysisRange: "",
  excludedPages: "",
  tocRange: "",
  analysisMethod: "auto",
});
export function UploadPreparation({
  files,
  options,
  onChange,
}: {
  files: File[];
  options: Record<string, FileOptions>;
  onChange: (key: string, value: FileOptions) => void;
}) {
  const [selected, setSelected] = useState(0),
    [page, setPage] = useState(1),
    [count, setCount] = useState(0),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null),
    pdf = useRef<PDFDocumentProxy | null>(null),
    file = files[Math.min(selected, files.length - 1)],
    isPdf =
      !!file && (/\.pdf$/i.test(file.name) || file.type === "application/pdf");
  const key = file ? fileKey(file) : "",
    value = file ? options[key] || defaultOptions(file) : null;
  useEffect(() => {
    if (!file) return;
    let alive = true,
      opened: PDFDocumentProxy | undefined;
    setPage(1);
    setCount(0);
    setError("");
    setReady(false);
    pdf.current = null;
    if (!isPdf) {
      setCount(1);
      return;
    }
    openPdf(file)
      .then((p) => {
        opened = p;
        if (!alive) {
          void p.loadingTask.destroy();
          return;
        }
        pdf.current = p;
        setCount(p.numPages);
        setReady(true);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      pdf.current = null;
      if (opened) void opened.loadingTask.destroy().catch(() => {});
    };
  }, [file, isPdf]);
  useEffect(() => {
    if (!ready || !pdf.current) return;
    let alive = true,
      render: { cancel: () => void; promise: Promise<void> } | undefined;
    pdf.current
      .getPage(page)
      .then((p) => {
        if (!alive || !canvas.current) return;
        const viewport = p.getViewport({
          scale: Math.min(1.3, 700 / p.getViewport({ scale: 1 }).width),
        });
        canvas.current.width = Math.ceil(viewport.width);
        canvas.current.height = Math.ceil(viewport.height);
        render = p.render({
          canvas: canvas.current,
          viewport,
          annotationMode: 0,
        });
        return render.promise;
      })
      .catch((e) => {
        if (alive && e.name !== "RenderingCancelledException")
          setError("미리보기를 표시하지 못했습니다.");
      });
    return () => {
      alive = false;
      render?.cancel();
    };
  }, [ready, page]);
  if (!file || !value) return null;
  const change = (patch: Partial<FileOptions>) =>
    onChange(key, { ...value, ...patch });
  let selectionMessage = "";
  if (count)
    try {
      selectionMessage = `분석 ${selectPages(value.analysisRange, count, value.excludedPages).length}쪽 · 목차 ${tocPages(value.tocRange, count).length}쪽`;
    } catch (e) {
      selectionMessage = (e as Error).message;
    }
  return (
    <section className="upload-preparation">
      <div className="section-heading">
        <h3>범위와 분석 방식</h3>
        {files.length > 1 && (
          <select
            aria-label="미리 볼 파일"
            value={Math.min(selected, files.length - 1)}
            onChange={(e) => setSelected(+e.target.value)}
          >
            {files.map((f, i) => (
              <option key={fileKey(f)} value={i}>
                {f.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="upload-preparation-grid">
        <div className="local-pdf-preview">
          {isPdf ? (
            <>
              <div className="row">
                <Button
                  variant="ghost"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  이전
                </Button>
                <label>
                  PDF 페이지{" "}
                  <input
                    aria-label="미리보기 PDF 페이지"
                    type="number"
                    min={1}
                    max={count || 1}
                    value={page}
                    onChange={(e) =>
                      setPage(
                        Math.min(count || 1, Math.max(1, +e.target.value || 1)),
                      )
                    }
                  />
                </label>
                <span>/ {count || "…"}</span>
                <Button
                  variant="ghost"
                  disabled={!count || page >= count}
                  onClick={() => setPage(page + 1)}
                >
                  다음
                </Button>
              </div>
              <canvas
                ref={canvas}
                aria-label={`${file.name} 전체 PDF 미리보기 ${page}쪽`}
              />
            </>
          ) : (
            <p>이미지 자료는 PDF 1쪽으로 처리합니다.</p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="cloud-form">
          <label className="cloud-field">
            자료명
            <input
              value={value.title}
              maxLength={160}
              onChange={(e) => change({ title: e.target.value })}
            />
          </label>
          <label className="cloud-field">
            분석할 PDF 페이지
            <input
              placeholder="전체 · 예: 15-48, 62-90, 105"
              value={value.analysisRange}
              onChange={(e) => change({ analysisRange: e.target.value })}
            />
          </label>
          <label className="cloud-field">
            제외할 PDF 페이지
            <input
              placeholder="예: 20-22, 70"
              value={value.excludedPages}
              onChange={(e) => change({ excludedPages: e.target.value })}
            />
          </label>
          <label className="cloud-field">
            목차 PDF 페이지
            <input
              placeholder="예: 3-6"
              value={value.tocRange}
              onChange={(e) => change({ tocRange: e.target.value })}
            />
          </label>
          <small>{selectionMessage}</small>
          <label className="cloud-field">
            분석 방식
            <select
              value={value.analysisMethod}
              onChange={(e) =>
                change({
                  analysisMethod: e.target
                    .value as FileOptions["analysisMethod"],
                })
              }
            >
              <option value="auto">자체 OCR·문항 인식</option>
              <option value="external">외부 AI 결과 가져오기</option>
              <option value="later">나중에 분석</option>
            </select>
          </label>
          <details>
            <summary>책에 인쇄된 쪽수 표시</summary>
            <label className="cloud-field">
              현재 PDF {page}쪽에 인쇄된 책 쪽수
              <input
                type="number"
                placeholder="선택 사항"
                value={
                  value.printedPageOffset === undefined
                    ? ""
                    : page + value.printedPageOffset
                }
                onChange={(e) =>
                  change({
                    printedPageOffset:
                      e.target.value === ""
                        ? undefined
                        : Number(e.target.value) - page,
                  })
                }
              />
            </label>
          </details>
          <p className="field-help">
            입력 범위는 PDF의 실제 페이지입니다. 원본 전체를 비공개로 저장하고,
            선택한 범위만 처리합니다.
            OCR·목차·문항 인식에는 외부 AI API를 호출하지 않습니다.
          </p>
        </div>
      </div>
    </section>
  );
}
