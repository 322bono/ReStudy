import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileText,
  Plus,
  Save,
  Settings2,
  Upload,
  X,
} from "lucide-react";
import { api } from "@/lib/client";
import type {
  AppState,
  BankItem,
  BankType,
  Concept,
  ContentData,
  ContentPackage,
  Source,
  StudyMode,
  Validation,
} from "@/lib/types";
import { Badge, Button, Empty, IconButton } from "./ui";
import { DownloadLink } from "./secure-assets";
const newConcept = (): Concept => ({
  id: "",
  subject: "",
  major: "",
  minor: "",
  name: "",
  definition: "",
  properties: [],
  misconceptions: [],
  sources: [],
});
const newItem = (): BankItem => ({
  id: "",
  conceptId: "",
  type: "객관식",
  prompt: "",
  choices: [],
  answer: "",
  acceptedAnswers: [],
  explanation: "",
  choiceFeedback: {},
  correction: "",
  difficulty: "보통",
  sources: [],
  modes: ["quiz"],
  active: true,
});
function SourceEditor({
  sources,
  materials,
  onChange,
}: {
  sources: Source[];
  materials: AppState["materials"];
  onChange: (value: Source[]) => void;
}) {
  return (
    <fieldset className="editor-fieldset">
      <legend>원본 출처</legend>
      {sources.map((s, i) => (
        <div className="source-editor-row" key={i}>
          <label>
            <span className="sr-only">출처 자료 {i + 1}</span>
            <select
              required
              value={s.materialId}
              onChange={(e) =>
                onChange(
                  sources.map((v, n) =>
                    n === i ? { ...v, materialId: e.target.value } : v,
                  ),
                )
              }
            >
              <option value="">자료 선택</option>
              {materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.subject} · {m.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">출처 페이지 {i + 1}</span>
            <input
              type="number"
              min={1}
              max={
                materials.find((m) => m.id === s.materialId)?.pageCount ||
                undefined
              }
              aria-label={`출처 페이지 ${i + 1}`}
              value={s.page}
              onChange={(e) =>
                onChange(
                  sources.map((v, n) =>
                    n === i ? { ...v, page: Number(e.target.value) } : v,
                  ),
                )
              }
            />
          </label>
          <span>쪽</span>
          <IconButton
            label={`출처 ${i + 1} 제거`}
            type="button"
            onClick={() => onChange(sources.filter((_, n) => n !== i))}
          >
            <X size={14} />
          </IconButton>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        onClick={() =>
          onChange([
            ...sources,
            { materialId: materials[0]?.id || "", page: 1 },
          ])
        }
      >
        <Plus size={14} />
        출처 추가
      </Button>
    </fieldset>
  );
}
function ValidationResult({ value }: { value?: Validation }) {
  if (!value) return null;
  return (
    <div className="validation-result" aria-live="polite">
      <div className="row">
        <Badge tone={value.errors.length ? "amber" : "green"}>
          {value.errors.length ? `오류 ${value.errors.length}개` : "검사 통과"}
        </Badge>
        <Badge>안내 {value.warnings.length}개</Badge>
      </div>
      {value.counts && (
        <div className="content-counts">
          {Object.entries(value.counts).map(([key, count]) => (
            <span key={key}>
              {(
                {
                  concepts: "개념",
                  items: "은행 문항",
                  mappings: "문항 연결",
                  materials: "자료",
                } as Record<string, string>
              )[key] || key}{" "}
              <strong>{count}</strong>
            </span>
          ))}
        </div>
      )}
      {value.errors.length > 0 && (
        <ul className="error">
          {value.errors.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
      {value.warnings.length > 0 && (
        <ul className="muted">
          {value.warnings.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
export function ContentManager({
  state,
  onRefresh,
  onError,
  onOpen,
  onExit,
}: {
  state: AppState;
  onRefresh: () => Promise<void>;
  onError: (s: string) => void;
  onOpen: (id: string, page?: number) => void;
  onExit: () => void;
}) {
  const [data, setData] = useState<ContentData>(),
    [tab, setTab] = useState("import"),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [failure, setFailure] = useState(""),
    [concept, setConcept] = useState<Concept>(),
    [item, setItem] = useState<BankItem>(),
    [file, setFile] = useState<File>(),
    [json, setJson] = useState(""),
    [validation, setValidation] = useState<Validation>(),
    [validatedJson, setValidatedJson] = useState(""),
    [validatedFile, setValidatedFile] = useState<File>(),
    [check, setCheck] = useState<Validation>(),
    [search, setSearch] = useState("");
  const load = useCallback(async () => {
    setData(await api<ContentData>("content"));
  }, []);
  useEffect(() => {
    load().catch((e) => setFailure(e.message));
  }, [load]);
  const act = async (fn: () => Promise<void>, success = "저장했습니다.") => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      await load();
      await onRefresh();
      setMessage(success);
    } catch (e) {
      onError((e as Error).message);
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const chooseFile = async (next?: File) => {
    setFile(next);
    setValidation(undefined);
    setValidatedFile(undefined);
    setValidatedJson("");
    setJson("");
    if (next && next.name.toLowerCase().endsWith(".json")) {
      try {
        setJson(await next.text());
      } catch (e) {
        onError((e as Error).message);
      }
    }
  };
  const validate = async () => {
    setBusy(true);
    setMessage("");
    try {
      if (json.trim()) {
        const p = JSON.parse(json) as ContentPackage;
        const result = await api<Validation>("content/validate", "POST", {
          package: p,
        });
        setValidation(result);
        setValidatedJson(json);
        setValidatedFile(undefined);
      } else if (file) {
        const form = new FormData();
        form.set("file", file);
        setValidation(
          await api<Validation>("content/validate-file", "POST", form),
        );
        setValidatedFile(file);
        setValidatedJson("");
      }
    } catch (e) {
      setValidation({
        valid: false,
        errors: [(e as Error).message],
        warnings: [],
      });
    } finally {
      setBusy(false);
    }
  };
  const importReady =
    !!validation &&
    validation.valid !== false &&
    validation.errors.length === 0 &&
    ((!!json.trim() && validatedJson === json) ||
      (!json.trim() && !!file && validatedFile === file));
  const importData = () =>
    act(async () => {
      if (!importReady) throw new Error("현재 내용을 먼저 검사해 주세요.");
      let result: Validation;
      if (json.trim())
        result = await api("content/import", "POST", {
          package: JSON.parse(json),
        });
      else {
        const form = new FormData();
        form.set("file", file!);
        result = await api("content/import-file", "POST", form);
      }
      setValidation(result);
      if (result.errors?.length)
        throw new Error(
          "가져오기를 완료하지 못했습니다. 검사 결과를 확인하세요.",
        );
      setValidatedJson("");
      setValidatedFile(undefined);
    }, "콘텐츠를 가져왔습니다. 기존 학습 기록은 보관됩니다.");
  if (failure && !data)
    return (
      <Empty
        title="콘텐츠 관리를 열 수 없습니다"
        description={failure}
        action={
          <Button
            onClick={() => {
              setFailure("");
              load().catch((e) => setFailure(e.message));
            }}
          >
            다시 시도
          </Button>
        }
      />
    );
  if (!data) return <div className="loading">콘텐츠를 불러오는 중…</div>;
  const filteredConcepts = data.concepts.filter((c) =>
    `${c.subject} ${c.major} ${c.minor} ${c.name} ${c.id}`.includes(search),
  );
  const groups = [...new Set(filteredConcepts.map((c) => c.subject))];
  const saveConcept = (e: React.FormEvent) => {
    e.preventDefault();
    if (!concept) return;
    act(async () => {
      await api(`concepts/${encodeURIComponent(concept.id)}`, "PUT", {
        ...concept,
        properties: concept.properties.map((s) => s.trim()).filter(Boolean),
      });
    });
  };
  const saveItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!item) return;
    act(async () => {
      const choices = item.choices.map((s) => s.trim()).filter(Boolean);
      await api(`bank-items/${encodeURIComponent(item.id)}`, "PUT", {
        ...item,
        choices,
        acceptedAnswers: item.acceptedAnswers
          .map((s) => s.trim())
          .filter(Boolean),
        choiceFeedback: Object.fromEntries(
          Object.entries(item.choiceFeedback).filter(([choice]) =>
            choices.includes(choice),
          ),
        ),
      });
    });
  };
  return (
    <div className="content-manager">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <Settings2 size={14} /> 관리 모드
          </div>
          <h1>콘텐츠 관리</h1>
          <p>개념·문제 은행·원본 연결을 준비하고 검증하세요.</p>
        </div>
        <Button variant="secondary" onClick={onExit}>
          <ArrowLeft size={15} />
          학습 화면으로
        </Button>
      </div>
      <div className="management-notice">
        콘텐츠를 수정해도 이미 저장된 학습 세션과 풀이 기록은 보관됩니다.
      </div>
      <div
        className="tabs management-tabs"
        role="tablist"
        aria-label="콘텐츠 관리 메뉴"
      >
        {[
          ["import", "가져오기·내보내기"],
          ["concepts", "개념"],
          ["bank", "문제 은행"],
          ["mappings", "문항 연결·영역"],
          ["check", "콘텐츠 검사"],
        ].map(([id, title]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => {
              setTab(id);
              setSearch("");
            }}
          >
            {title}
          </button>
        ))}
      </div>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {tab === "import" && (
        <div className="admin-grid">
          <section className="panel editor-panel">
            <h2>콘텐츠 가져오기</h2>
            <p className="muted">
              개념·문항·원본 연결을 담은 JSON 파일을 선택하세요.
            </p>
            <label className="admin-file">
              <Upload size={18} />
              <span>{file?.name || "콘텐츠 파일 선택"}</span>
              <input
                type="file"
                accept=".json,.sqlite,.sqlite3,.db,application/json,application/vnd.sqlite3"
                onChange={(e) => chooseFile(e.target.files?.[0])}
              />
            </label>
            <label>
              JSON 편집·붙여넣기
              <textarea
                className="json-editor"
                value={json}
                rows={12}
                spellCheck={false}
                placeholder="빈 템플릿을 내려받아 콘텐츠를 작성하거나 JSON을 붙여넣으세요."
                onChange={(e) => {
                  setJson(e.target.value);
                  setValidation(undefined);
                }}
              />
            </label>
            <div className="row">
              <Button
                variant="secondary"
                busy={busy}
                disabled={!json.trim() && !file}
                onClick={validate}
              >
                <CheckCircle2 size={15} />
                검사·미리보기
              </Button>
              <Button busy={busy} disabled={!importReady} onClick={importData}>
                <Upload size={15} />
                검사한 콘텐츠 가져오기
              </Button>
            </div>
            <ValidationResult value={validation} />
          </section>
          <section className="panel editor-panel">
            <h2>내보내기·템플릿</h2>
            <p className="muted">
              개념, 은행 문항, 원본 연결과 자료 참조를 저장합니다. 원본 파일과
              학습 기록은 포함되지 않습니다.
            </p>
            <Button asChild variant="secondary">
              <DownloadLink path="content/template">
                <Download size={15} />빈 JSON 템플릿
              </DownloadLink>
            </Button>
            <Button asChild variant="secondary">
              <DownloadLink path="content/export?format=json">
                <Download size={15} />
                JSON 내보내기
              </DownloadLink>
            </Button>
            <div className="content-counts">
              <span>
                개념 <strong>{data.concepts.length}</strong>
              </span>
              <span>
                은행 문항 <strong>{data.items.length}</strong>
              </span>
              <span>
                원본 연결 <strong>{data.mappings.length}</strong>
              </span>
            </div>
            <p className="field-help">
              같은 콘텐츠 ID를 다시 가져오면 해당 항목을 갱신합니다. 오류가
              있으면 전체 가져오기를 취소합니다.
            </p>
          </section>
        </div>
      )}
      {tab === "concepts" && (
        <div className="admin-grid">
          <section className="panel editor-panel">
            <div className="row-between">
              <h2>개념 계층</h2>
              <Button
                variant="secondary"
                onClick={() => setConcept(newConcept())}
              >
                <Plus size={14} />
                개념 추가
              </Button>
            </div>
            <input
              aria-label="개념 검색"
              placeholder="과목, 대단원, 소단원, 개념 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {groups.length ? (
              groups.map((subject) => (
                <details className="concept-tree" key={subject} open>
                  <summary>{subject}</summary>
                  {[
                    ...new Set(
                      filteredConcepts
                        .filter((c) => c.subject === subject)
                        .map((c) => c.major),
                    ),
                  ].map((major) => (
                    <div key={major}>
                      <h3>{major || "대단원 미지정"}</h3>
                      {[
                        ...new Set(
                          filteredConcepts
                            .filter(
                              (c) => c.subject === subject && c.major === major,
                            )
                            .map((c) => c.minor),
                        ),
                      ].map((minor) => (
                        <div className="concept-branch" key={minor}>
                          <small>{minor || "소단원 미지정"}</small>
                          {filteredConcepts
                            .filter(
                              (c) =>
                                c.subject === subject &&
                                c.major === major &&
                                c.minor === minor,
                            )
                            .map((c) => (
                              <button
                                key={c.id}
                                className={concept?.id === c.id ? "active" : ""}
                                onClick={() => setConcept(structuredClone(c))}
                              >
                                {c.name}
                                <small>{c.id}</small>
                              </button>
                            ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </details>
              ))
            ) : (
              <Empty
                title="등록된 개념이 없습니다"
                description="개념을 추가하거나 콘텐츠 파일을 가져오세요."
              />
            )}
          </section>
          <section className="panel editor-panel">
            {concept ? (
              <form className="form-stack" onSubmit={saveConcept}>
                <h2>개념 편집</h2>
                <div className="form-grid">
                  <label>
                    콘텐츠 ID
                    <input
                      required
                      pattern="[A-Za-z0-9가-힣_-]{1,100}"
                      value={concept.id}
                      onChange={(e) =>
                        setConcept({ ...concept, id: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    과목
                    <input
                      required
                      value={concept.subject}
                      onChange={(e) =>
                        setConcept({ ...concept, subject: e.target.value })
                      }
                      list="concept-subjects"
                    />
                    <datalist id="concept-subjects">
                      {[...new Set(state.materials.map((m) => m.subject))].map(
                        (s) => (
                          <option key={s}>{s}</option>
                        ),
                      )}
                    </datalist>
                  </label>
                  <label>
                    대단원
                    <input
                      value={concept.major}
                      onChange={(e) =>
                        setConcept({ ...concept, major: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    소단원
                    <input
                      value={concept.minor}
                      onChange={(e) =>
                        setConcept({ ...concept, minor: e.target.value })
                      }
                    />
                  </label>
                </div>
                <label>
                  개념명
                  <input
                    required
                    value={concept.name}
                    onChange={(e) =>
                      setConcept({ ...concept, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  정의
                  <textarea
                    required
                    value={concept.definition}
                    onChange={(e) =>
                      setConcept({ ...concept, definition: e.target.value })
                    }
                  />
                </label>
                <label>
                  성질·핵심 내용 (한 줄에 하나)
                  <textarea
                    value={concept.properties.join("\n")}
                    onChange={(e) =>
                      setConcept({
                        ...concept,
                        properties: e.target.value.split("\n"),
                      })
                    }
                  />
                </label>
                <fieldset className="editor-fieldset">
                  <legend>대표 오개념과 교정</legend>
                  {concept.misconceptions.map((m, i) => (
                    <div className="misconception-editor" key={i}>
                      <label>
                        오개념 태그
                        <input
                          required
                          value={m.id}
                          onChange={(e) =>
                            setConcept({
                              ...concept,
                              misconceptions: concept.misconceptions.map(
                                (v, n) =>
                                  n === i ? { ...v, id: e.target.value } : v,
                              ),
                            })
                          }
                        />
                      </label>
                      <label>
                        오개념 내용
                        <input
                          required
                          value={m.label}
                          onChange={(e) =>
                            setConcept({
                              ...concept,
                              misconceptions: concept.misconceptions.map(
                                (v, n) =>
                                  n === i ? { ...v, label: e.target.value } : v,
                              ),
                            })
                          }
                        />
                      </label>
                      <label>
                        교정 설명
                        <textarea
                          required
                          value={m.correction}
                          onChange={(e) =>
                            setConcept({
                              ...concept,
                              misconceptions: concept.misconceptions.map(
                                (v, n) =>
                                  n === i
                                    ? { ...v, correction: e.target.value }
                                    : v,
                              ),
                            })
                          }
                        />
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          setConcept({
                            ...concept,
                            misconceptions: concept.misconceptions.filter(
                              (_, n) => n !== i,
                            ),
                          })
                        }
                      >
                        오개념 제거
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      setConcept({
                        ...concept,
                        misconceptions: [
                          ...concept.misconceptions,
                          { id: "", label: "", correction: "" },
                        ],
                      })
                    }
                  >
                    <Plus size={14} />
                    오개념 추가
                  </Button>
                </fieldset>
                <SourceEditor
                  sources={concept.sources}
                  materials={state.materials}
                  onChange={(sources) => setConcept({ ...concept, sources })}
                />
                <Button type="submit" busy={busy}>
                  <Save size={15} />
                  개념 저장
                </Button>
              </form>
            ) : (
              <Empty title="편집할 개념을 선택하세요" />
            )}
          </section>
        </div>
      )}
      {tab === "bank" && (
        <div className="admin-grid">
          <section className="panel editor-panel">
            <div className="row-between">
              <h2>등록 문항 {data.items.length}개</h2>
              <Button variant="secondary" onClick={() => setItem(newItem())}>
                <Plus size={14} />
                문항 추가
              </Button>
            </div>
            <input
              aria-label="은행 문항 검색"
              placeholder="문항·개념 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="bank-list">
              {data.items
                .filter((i) =>
                  `${i.prompt} ${i.id} ${data.concepts.find((c) => c.id === i.conceptId)?.name}`.includes(
                    search,
                  ),
                )
                .map((i) => (
                  <button
                    key={i.id}
                    className={item?.id === i.id ? "active" : ""}
                    onClick={() => setItem(structuredClone(i))}
                  >
                    <span>
                      <Badge>{i.type}</Badge>{" "}
                      {data.concepts.find((c) => c.id === i.conceptId)?.name ||
                        "개념 미등록"}
                    </span>
                    <strong>{i.prompt}</strong>
                    <small>
                      {i.id} · {i.active ? "사용 중" : "사용 안 함"}
                    </small>
                  </button>
                ))}
              {!data.items.length && (
                <Empty
                  title="등록된 은행 문항이 없습니다"
                  description="준비한 문제와 답·해설을 등록하세요."
                />
              )}
            </div>
          </section>
          <section className="panel editor-panel">
            {item ? (
              <form className="form-stack" onSubmit={saveItem}>
                <h2>은행 문항 편집</h2>
                <div className="form-grid">
                  <label>
                    콘텐츠 ID
                    <input
                      required
                      pattern="[A-Za-z0-9가-힣_-]{1,100}"
                      value={item.id}
                      onChange={(e) => setItem({ ...item, id: e.target.value })}
                    />
                  </label>
                  <label>
                    연결 개념
                    <select
                      required
                      value={item.conceptId}
                      onChange={(e) =>
                        setItem({ ...item, conceptId: e.target.value })
                      }
                    >
                      <option value="">개념 선택</option>
                      {data.concepts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.subject} · {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    문항 유형
                    <select
                      value={item.type}
                      onChange={(e) =>
                        setItem({
                          ...item,
                          type: e.target.value as BankType,
                          choices:
                            e.target.value === "OX" ? ["O", "X"] : item.choices,
                        })
                      }
                    >
                      {[
                        "객관식",
                        "OX",
                        "빈칸",
                        "단답형",
                        "서술형",
                        "플래시카드",
                        "문장 가리기",
                      ].map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    난이도
                    <select
                      value={item.difficulty}
                      onChange={(e) =>
                        setItem({
                          ...item,
                          difficulty: e.target.value as BankItem["difficulty"],
                        })
                      }
                    >
                      {["기본", "보통", "심화"].map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  문제·암기 앞면
                  <textarea
                    required
                    value={item.prompt}
                    onChange={(e) =>
                      setItem({ ...item, prompt: e.target.value })
                    }
                  />
                </label>
                {["객관식", "OX"].includes(item.type) && (
                  <label>
                    선택지 (한 줄에 하나)
                    <textarea
                      value={item.choices.join("\n")}
                      onChange={(e) =>
                        setItem({
                          ...item,
                          choices: e.target.value.split("\n"),
                        })
                      }
                    />
                  </label>
                )}
                <label>
                  정답·암기 뒷면
                  <textarea
                    required
                    value={item.answer}
                    onChange={(e) =>
                      setItem({ ...item, answer: e.target.value })
                    }
                  />
                </label>
                <label>
                  허용 답안 (한 줄에 하나)
                  <textarea
                    value={item.acceptedAnswers.join("\n")}
                    onChange={(e) =>
                      setItem({
                        ...item,
                        acceptedAnswers: e.target.value.split("\n"),
                      })
                    }
                  />
                </label>
                <label>
                  해설
                  <textarea
                    required
                    value={item.explanation}
                    onChange={(e) =>
                      setItem({ ...item, explanation: e.target.value })
                    }
                  />
                </label>
                <label>
                  오답 시 개념 교정
                  <textarea
                    value={item.correction}
                    onChange={(e) =>
                      setItem({ ...item, correction: e.target.value })
                    }
                  />
                </label>
                {["객관식", "OX"].includes(item.type) && (
                  <fieldset className="editor-fieldset">
                    <legend>선택지별 오개념·교정</legend>
                    {item.choices.filter(Boolean).map((choice, i) => (
                      <div className="misconception-editor" key={i}>
                        <strong>{choice}</strong>
                        <label>
                          선택지 피드백
                          <textarea
                            value={
                              item.choiceFeedback[choice]?.explanation || ""
                            }
                            onChange={(e) =>
                              setItem({
                                ...item,
                                choiceFeedback: {
                                  ...item.choiceFeedback,
                                  [choice]: {
                                    explanation: e.target.value,
                                    misconceptionTag:
                                      item.choiceFeedback[choice]
                                        ?.misconceptionTag || "",
                                  },
                                },
                              })
                            }
                          />
                        </label>
                        <label>
                          오개념 태그
                          <select
                            value={
                              item.choiceFeedback[choice]?.misconceptionTag ||
                              ""
                            }
                            onChange={(e) =>
                              setItem({
                                ...item,
                                choiceFeedback: {
                                  ...item.choiceFeedback,
                                  [choice]: {
                                    explanation:
                                      item.choiceFeedback[choice]
                                        ?.explanation || "",
                                    misconceptionTag: e.target.value,
                                  },
                                },
                              })
                            }
                          >
                            <option value="">연결 없음</option>
                            {data.concepts
                              .find((c) => c.id === item.conceptId)
                              ?.misconceptions.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.id} · {m.label}
                                </option>
                              ))}
                          </select>
                        </label>
                      </div>
                    ))}
                  </fieldset>
                )}
                <fieldset className="editor-fieldset">
                  <legend>학습 방식</legend>
                  <div className="row wrap">
                    {modesForEditor.map(([key, label]) => (
                      <label className="checkbox-label" key={key}>
                        <input
                          type="checkbox"
                          checked={item.modes.includes(key)}
                          onChange={(e) =>
                            setItem({
                              ...item,
                              modes: e.target.checked
                                ? [...item.modes, key]
                                : item.modes.filter((m) => m !== key),
                            })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={item.active}
                    onChange={(e) =>
                      setItem({ ...item, active: e.target.checked })
                    }
                  />
                  학습에 사용
                </label>
                <SourceEditor
                  sources={item.sources}
                  materials={state.materials}
                  onChange={(sources) => setItem({ ...item, sources })}
                />
                <Button type="submit" busy={busy}>
                  <Save size={15} />
                  문항 저장
                </Button>
              </form>
            ) : (
              <Empty title="편집할 문항을 선택하세요" />
            )}
          </section>
        </div>
      )}
      {tab === "mappings" && (
        <MappingEditor
          state={state}
          data={data}
          busy={busy}
          onOpen={onOpen}
          onSave={(fn) => act(fn)}
        />
      )}
      {tab === "check" && (
        <section className="panel editor-panel">
          <div className="row-between">
            <div>
              <h2>콘텐츠 무결성 검사</h2>
              <p className="muted">
                참조, 정답, 선택지, 출처 페이지, 개념 연결과 문항 영역을
                확인합니다.
              </p>
            </div>
            <Button
              busy={busy}
              onClick={() =>
                act(
                  async () => setCheck(await api("content/check")),
                  "콘텐츠 검사를 마쳤습니다.",
                )
              }
            >
              <CheckCircle2 size={15} />
              전체 검사
            </Button>
          </div>
          <ValidationResult value={check || data.issues} />
        </section>
      )}
    </div>
  );
}
const modesForEditor: [StudyMode, string][] = [
  ["quiz", "문제 풀기"],
  ["memory", "개념 암기"],
  ["check", "개념 확인"],
];
function MappingEditor({
  state,
  data,
  busy,
  onOpen,
  onSave,
}: {
  state: AppState;
  data: ContentData;
  busy: boolean;
  onOpen: (id: string, page?: number) => void;
  onSave: (fn: () => Promise<void>) => void;
}) {
  const [qid, setQid] = useState(""),
    [conceptIds, setConceptIds] = useState<string[]>([]),
    [answer, setAnswer] = useState(""),
    [explanation, setExplanation] = useState(""),
    [materialId, setMaterialId] = useState(state.materials[0]?.id || "");
  const q = state.questions.find((q) => q.id === qid);
  const choose = (id: string) => {
    const question = state.questions.find((q) => q.id === id);
    const mapping = data.mappings.find(
      (m) =>
        m.questionId === id ||
        (m.materialId === question?.materialId &&
          m.number === question?.number &&
          m.page === (question?.page || question?.regions[0]?.page)),
    );
    setQid(id);
    setConceptIds(mapping?.conceptIds || question?.conceptIds || []);
    setAnswer(mapping?.answer || "");
    setExplanation(mapping?.explanation || "");
  };
  return (
    <div className="admin-grid">
      <section className="panel editor-panel">
        <h2>원본 문항</h2>
        <label>
          자료
          <select
            value={materialId}
            onChange={(e) => {
              setMaterialId(e.target.value);
              setQid("");
            }}
          >
            {!state.materials.length && <option value="">자료 없음</option>}
            {state.materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.subject} · {m.title}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          disabled={!materialId}
          onClick={() => onOpen(materialId)}
        >
          <FileText size={15} />
          원본·영역 관리 열기
        </Button>
        <div className="bank-list">
          {state.questions
            .filter((q) => q.materialId === materialId)
            .map((question) => (
              <button
                key={question.id}
                className={qid === question.id ? "active" : ""}
                onClick={() => choose(question.id)}
              >
                <strong>
                  {question.number}번 ·{" "}
                  {question.page || question.regions[0]?.page}쪽
                </strong>
                <small>
                  {question.unit || "단원 미지정"} ·{" "}
                  {question.conceptIds.length
                    ? `${question.conceptIds.length}개 개념`
                    : "개념 미등록"}{" "}
                  · {question.confirmed ? "영역 확인됨" : "영역 확인 필요"}
                </small>
              </button>
            ))}
        </div>
      </section>
      <section className="panel editor-panel">
        {q ? (
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              onSave(async () => {
                await api(`questions/${q.id}/mapping`, "PATCH", {
                  conceptIds,
                  answer,
                  explanation,
                });
              });
            }}
          >
            <div className="row-between">
              <h2>
                {q.number}번 · {q.page || q.regions[0]?.page}쪽 연결
              </h2>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  onOpen(q.materialId, q.page || q.regions[0]?.page)
                }
              >
                영역 수정
              </Button>
            </div>
            <fieldset className="editor-fieldset">
              <legend>연결 개념</legend>
              {data.concepts
                .filter(
                  (c) =>
                    c.subject ===
                    state.materials.find((m) => m.id === q.materialId)?.subject,
                )
                .map((c) => (
                  <label className="checkbox-label" key={c.id}>
                    <input
                      type="checkbox"
                      checked={conceptIds.includes(c.id)}
                      onChange={(e) =>
                        setConceptIds(
                          e.target.checked
                            ? [...conceptIds, c.id]
                            : conceptIds.filter((id) => id !== c.id),
                        )
                      }
                    />
                    {c.major} / {c.minor} / {c.name}
                  </label>
                ))}
              {!data.concepts.length && (
                <p className="muted">개념을 먼저 등록해 주세요.</p>
              )}
            </fieldset>
            <label>
              원본 문제 정답 (선택)
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
            </label>
            <label>
              원본 문제 해설 (선택)
              <textarea
                value={explanation}
                onChange={(e) => setExplanation(e.target.value)}
              />
            </label>
            <p className="field-help">
              등록한 답·해설은 원본 다시 풀기에서 요청할 때만 표시합니다.
            </p>
            <Button busy={busy} type="submit">
              <Save size={15} />
              원본 연결 저장
            </Button>
          </form>
        ) : (
          <Empty
            title="연결할 원본 문항을 선택하세요"
            description="동일한 번호가 있으면 자료와 페이지를 확인해 선택하세요."
          />
        )}
      </section>
    </div>
  );
}
