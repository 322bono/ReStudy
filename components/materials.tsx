"use client";
import { useRef, useState } from "react";
import {
  Upload,
  Plus,
  Search,
  FileText,
  ChevronRight,
  Check,
  Trash2,
  LoaderCircle,
  FolderOpen,
} from "lucide-react";
import { api, dateLabel } from "@/lib/client";
import type { AppState, Material } from "@/lib/types";
import { Badge, Button, Dialog, Empty, IconButton } from "./ui";
import {
  UploadPreparation,
  fileKey,
  defaultOptions,
  type FileOptions,
} from "../src/features/pdf/UploadPreparation";

export function UploadDialog({
  subjects,
  onClose,
  onDone,
}: {
  subjects: string[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [subject, setSubject] = useState(""),
    [kind, setKind] = useState("문제집"),
    [files, setFiles] = useState<File[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [fileOptions, setFileOptions] = useState<Record<string, FileOptions>>(
    {},
  );
  const input = useRef<HTMLInputElement>(null);
  const submit = async () => {
    setError("");
    if (!subject.trim()) return setError("과목을 입력해 주세요.");
    if (!files.length) return setError("파일을 선택해 주세요.");
    setBusy(true);
    try {
      const form = new FormData();
      form.set("subject", subject);
      form.set("kind", kind);
      form.set(
        "fileOptions",
        JSON.stringify(
          files.map((f) => fileOptions[fileKey(f)] || defaultOptions(f)),
        ),
      );
      for (const file of files) form.append("files", file);
      await api("materials", "POST", form);
      await onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="파일 추가"
      wide={files.length > 0}
      onClose={() => !busy && onClose()}
    >
      <div className="form-grid">
        <label>
          과목
          <input
            autoFocus
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="예: 공통수학2"
            list="subjects"
            maxLength={40}
          />
          <datalist id="subjects">
            {subjects.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </datalist>
        </label>
        <label>
          자료 종류
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {["문제집", "교과서", "학습지", "필기", "기타"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
      </div>
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(e) => setFiles(Array.from(e.target.files || []))}
      />
      <button
        className="upload-zone"
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          setFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <Upload size={24} />
        <strong>파일을 놓거나 선택해 주세요</strong>
        <span>PDF, JPG, PNG, WebP · 비공개 저장 후 브라우저에서 처리해요.</span>
      </button>
      {files.length > 0 && (
        <div className="file-selection">
          {files.map((f, i) => (
            <div key={i}>
              <FileText size={16} />
              <span>{f.name}</span>
              <small>{(f.size / 1024 / 1024).toFixed(1)}MB</small>
              <IconButton
                label="선택 취소"
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <UploadPreparation
          kind={kind}
          files={files}
          options={fileOptions}
          onChange={(key, value) =>
            setFileOptions((current) => ({ ...current, [key]: value }))
          }
        />
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-footer">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          취소
        </Button>
        <Button onClick={submit} busy={busy}>
          파일 추가
        </Button>
      </div>
    </Dialog>
  );
}
export function MaterialStatus({ material: m }: { material: Material }) {
  return m.paused ? (
    <Badge tone="amber">
      {m.progress ? "일시 중지" : "원본 저장됨 · 분석 전"}
    </Badge>
  ) : m.status === "processing" || m.status === "uploaded" ? (
    <Badge tone="indigo">
      <LoaderCircle size={11} className="spin" />
      {m.status === "uploaded" ? "분석 대기" : `분석 중 ${m.progress}%`}
    </Badge>
  ) : m.status === "error" ? (
    <Badge tone="amber">분석 실패</Badge>
  ) : m.status === "needs_review" ? (
    <Badge tone="amber">확인 필요</Badge>
  ) : (
    <Badge>
      <Check size={11} />
      준비됨
    </Badge>
  );
}
export function Materials({
  state,
  onOpen,
  onUpload,
  onStudy,
  run,
}: {
  state: AppState;
  onOpen: (id: string) => void;
  onUpload: () => void;
  onStudy: (ids: string[]) => void;
  run: (name: string, fn: () => Promise<void>) => void;
}) {
  const [subject, setSubject] = useState("전체"),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [deleteId, setDeleteId] = useState<string>();
  const subjects = [...new Set(state.materials.map((m) => m.subject))];
  const materials = state.materials.filter(
    (m) =>
      (subject === "전체" || m.subject === subject) &&
      m.title.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">나의 학습 자료</div>
          <h1>내 자료</h1>
          <p>공부할 자료를 한곳에 모아 두세요.</p>
        </div>
        <Button onClick={onUpload}>
          <Plus size={17} />
          파일 추가
        </Button>
      </div>
      <div className="toolbar">
        <div className="tabs">
          <button
            className={subject === "전체" ? "active" : ""}
            onClick={() => setSubject("전체")}
          >
            전체 <small>{state.materials.length}</small>
          </button>
          {subjects.map((s) => (
            <button
              key={s}
              onClick={() => setSubject(s)}
              className={subject === s ? "active" : ""}
            >
              {s}
            </button>
          ))}
        </div>
        <label className="search">
          <Search size={16} />
          <input
            aria-label="자료 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="자료 검색"
          />
        </label>
      </div>
      {selected.length > 0 && (
        <div className="selection-bar">
          <span>{selected.length}개 선택</span>
          <Button variant="ghost" onClick={() => setSelected([])}>
            선택 해제
          </Button>
          <Button onClick={() => onStudy(selected)}>선택한 자료로 학습</Button>
        </div>
      )}
      <div className="panel material-list">
        {materials.length ? (
          materials.map((m) => (
            <div key={m.id} className="material-row">
              <input
                type="checkbox"
                aria-label={`${m.title} 선택`}
                checked={selected.includes(m.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [
                          ...selected.filter(
                            (id) =>
                              state.materials.find((v) => v.id === id)
                                ?.subject === m.subject,
                          ),
                          m.id,
                        ]
                      : selected.filter((id) => id !== m.id),
                  )
                }
              />
              <button className="material-open" onClick={() => onOpen(m.id)}>
                <span className="file-icon">
                  <FileText size={22} strokeWidth={1.5} />
                  <small>{m.mime === "application/pdf" ? "PDF" : "IMG"}</small>
                </span>
                <span className="material-info">
                  <strong>{m.title}</strong>
                  <span>
                    {m.subject}
                    <i /> {m.kind} <i />{" "}
                    {m.pageCount ? `${m.pageCount}쪽` : "분석 대기"}
                  </span>
                </span>
              </button>
              <div className="material-status">
                <MaterialStatus material={m} />
                <small>{dateLabel(m.createdAt)}</small>
              </div>
              <IconButton
                label={`${m.title} 삭제`}
                onClick={() => setDeleteId(m.id)}
              >
                <Trash2 size={15} />
              </IconButton>
              <IconButton
                label={`${m.title} 열기`}
                onClick={() => onOpen(m.id)}
              >
                <ChevronRight size={18} />
              </IconButton>
            </div>
          ))
        ) : (
          <Empty
            title={search ? "검색 결과가 없습니다" : "첫 자료를 추가해 보세요"}
            description={
              search
                ? "다른 이름이나 과목으로 찾아보세요."
                : "문제집과 학습지를 올리면 여기에서 이어서 공부할 수 있어요."
            }
            icon={<FolderOpen size={27} />}
            action={
              !search && (
                <Button variant="secondary" onClick={onUpload}>
                  <Plus size={16} />
                  파일 추가
                </Button>
              )
            }
          />
        )}
      </div>
      {deleteId && (
        <Dialog
          title="자료를 삭제할까요?"
          onClose={() => setDeleteId(undefined)}
        >
          <p className="muted">
            자료를 목록에서 보관 처리합니다. 기존 문제 풀이와 학습 기록은
            보관됩니다.
          </p>
          <div className="dialog-footer">
            <Button variant="secondary" onClick={() => setDeleteId(undefined)}>
              취소
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                run("자료 삭제", async () => {
                  await api(`materials/${deleteId}`, "DELETE");
                  setDeleteId(undefined);
                  setSelected(selected.filter((id) => id !== deleteId));
                })
              }
            >
              삭제
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
