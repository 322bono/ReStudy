import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Home,
  FolderOpen,
  BookOpen,
  GraduationCap,
  ArrowRight,
  Plus,
  FileText,
  ChevronRight,
  Settings2,
  X,
  RotateCcw,
  CalendarDays,
  MoreHorizontal,
} from "lucide-react";
import { api, isDue } from "@/lib/client";
import type { AppState, StudySession } from "@/lib/types";
import { Button, Empty, IconButton } from "./ui";
import { Materials, MaterialStatus, UploadDialog } from "./materials";
import { Viewer } from "./viewer";
import { AddMistakes, Mistakes, type MistakeFilters } from "./mistakes";
import { Solve } from "./solve";
import { StudyPlayer, StudySetup } from "./learning";
import { ContentManager } from "./content-manager";
import { materialProgress } from "../src/services/api";
import { createWrongAnalysisQueue, type WrongAnalysisProgress } from "../src/services/wrong-analysis";
const MaterialWorkspace = lazy(() => import("../src/pages/MaterialWorkspace"));
const Bank = lazy(() => import("../src/pages/Bank"));
const WrongWorkspace = lazy(() => import("../src/pages/WrongWorkspace"));
const isPreparing = (material: { status: string; paused?: boolean }) =>
  ["processing", "uploaded"].includes(material.status) && !material.paused;
type View = { name: string; id?: string; page?: number; manage?: boolean };
const navigation = [
  { id: "home", title: "홈", icon: Home },
  { id: "materials", title: "내 자료", icon: FolderOpen },
  { id: "mistakes", title: "오답 노트", icon: BookOpen },
  { id: "study", title: "학습하기", icon: GraduationCap },
];
function Brand() {
  return (
    <span className="brand">
      <span>RE</span>
      <span className="brand-dot" />
    </span>
  );
}
const viewFromUrl = (): View => {
  const p = new URLSearchParams(location.hash.replace(/^#\??/, ""));
  const name = p.get("screen") || "home";
  return {
    name: [
      "home",
      "materials",
      "mistakes",
      "study",
      "viewer",
      "solve",
      "study-session",
      "manage",
      "material",
      "bank",
      "wrong",
    ].includes(name)
      ? name
      : "home",
    id: p.get("id") || undefined,
    page: Number(p.get("page")) || 1,
    manage: p.get("manage") === "1",
  };
};
export default function RestudyApp({
  userId,
  onSettings,
}: {
  userId: string;
  onSettings?: () => void;
}) {
  const [state, setState] = useState<AppState>(),
    [view, setView] = useState<View>(viewFromUrl),
    [toast, setToast] = useState(""),
    [upload, setUpload] = useState(false),
    [addMistakes, setAddMistakes] = useState(false),
    [busy, setBusy] = useState(""),
    [studyIds, setStudyIds] = useState<string[]>([]);
  const [bankScope, setBankScope] = useState<any>({});
  const [mistakeFilters, setMistakeFilters] = useState<MistakeFilters>({
    subject: "전체", material: "전체", unit: "전체", status: "다시 풀 문제", search: "",
  });
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const outside = (event: PointerEvent) => {
      if (!moreMenu.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMoreOpen(false);
        moreMenu.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [moreOpen]);
  const [wrongAnalysis, setWrongAnalysis] = useState<WrongAnalysisProgress>();
  const wrongQueue = useRef<ReturnType<typeof createWrongAnalysisQueue> | null>(null);
  const restoredWrongQueue = useRef(false);
  const wrongQueueKey = `restudy.wrong-analysis:${userId}`;
  useEffect(() => {
    const queue = createWrongAnalysisQueue((progress) => {
      setWrongAnalysis(progress);
      const ids = progress.currentId
        ? [progress.currentId, ...progress.pendingIds]
        : progress.pendingIds;
      try {
        if (ids.length) sessionStorage.setItem(wrongQueueKey, JSON.stringify(ids));
        else sessionStorage.removeItem(wrongQueueKey);
      } catch {
        // The current app session can still run the queue without browser storage.
      }
    });
    wrongQueue.current = queue;
    return () => {
      queue.dispose();
      wrongQueue.current = null;
    };
  }, [wrongQueueKey]);
  useEffect(() => {
    if (!state || restoredWrongQueue.current) return;
    restoredWrongQueue.current = true;
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(wrongQueueKey) || "[]");
      if (!Array.isArray(saved) || !saved.length) return;
      const active = new Set(state.mistakes.filter((mistake) => !mistake.resolved).map((mistake) => mistake.questionId));
      const ids = saved.filter((id): id is string => typeof id === "string" && active.has(id));
      if (ids.length) wrongQueue.current?.enqueue(ids);
      else sessionStorage.removeItem(wrongQueueKey);
    } catch {
      // Ignore unavailable storage or invalid saved data.
    }
  }, [state, wrongQueueKey]);
  const returnView = useRef<View>({ name: "materials" });
  const bankReturn = useRef<View>({ name: "study" });
  const notify = useCallback((message: string) => setToast(message), []);
  const refresh = useCallback(async () => {
    setState(await api<AppState>("overview"));
  }, []);
  useEffect(() => {
    refresh().catch((e) => notify(e.message));
    const pop = () => setView(viewFromUrl());
    window.addEventListener("popstate", pop);
    window.addEventListener("hashchange", pop);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("hashchange", pop);
    };
  }, [refresh, notify]);
  const preparingIds = state?.materials.filter(isPreparing).map((material) => material.id).sort().join(",");
  useEffect(() => {
    if (!preparingIds) return;
    const ids = preparingIds.split(",");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (controller.signal.aborted) return;
      try {
        const updates = await materialProgress(ids, controller.signal);
        if (controller.signal.aborted) return;
        if (updates.length !== ids.length || updates.some((material) => !isPreparing(material))) {
          await refresh();
        } else {
          const byId = new Map(updates.map((material) => [material.id, material]));
          setState((previous) => previous && {
            ...previous,
            materials: previous.materials.map((material) => {
              const update = byId.get(material.id);
              return update && isPreparing(material) ? { ...material, ...update } : material;
            }),
          });
        }
      } catch {
        // Keep the last saved progress when the connection is temporarily busy.
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    }
    timer = setTimeout(poll, 3000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [preparingIds, refresh]);
  const navigate = (next: View) => {
    setMoreOpen(false);
    if (next.name === "bank") bankReturn.current = view;
    setView(next);
    const p = new URLSearchParams();
    if (next.name !== "home") p.set("screen", next.name);
    if (next.id) p.set("id", next.id);
    if (next.page) p.set("page", String(next.page));
    if (next.manage) p.set("manage", "1");
    history.pushState(
      null,
      "",
      p.size ? "#" + p.toString() : location.pathname,
    );
    window.scrollTo({ top: 0 });
  };
  const open = (id: string, page = 1, manage = false) => {
    returnView.current = view;
    navigate({ name: "viewer", id, page, manage });
  };
  const registeredWrong = (ids: string[], autoAnalyzeIds: string[]) => {
    if (!ids.length) return;
    setAddMistakes(false);
    wrongQueue.current?.enqueue(autoAnalyzeIds);
    navigate({ name: "wrong", id: ids[0] });
  };
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
      await refresh();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const solve = (ids: string[]) =>
    run("풀이 준비", async () => {
      const s = await api("solve", "POST", { questionIds: ids });
      navigate({ name: "solve", id: s.id });
    });
  const concept = (questionId: string) =>
    run("개념 복습 준비", async () => {
      const s = await api<StudySession>("lessons", "POST", { questionId });
      navigate({ name: "study-session", id: s.id });
    });
  if (!state)
    return (
      <div className="app-loading">
        <Brand />
        <span>학습 공간을 여는 중…</span>
        {toast && (
          <>
            <p className="error" role="alert">
              {toast}
            </p>
            <Button onClick={() => refresh().catch((e) => notify(e.message))}>
              다시 시도
            </Button>
          </>
        )}
      </div>
    );
  const focus = ["viewer", "solve", "study-session"].includes(view.name);
  const activeNav =
    view.name === "viewer"
      ? view.manage
        ? "manage"
        : "materials"
      : view.name === "solve"
        ? "mistakes"
        : view.name === "study-session"
          ? "study"
          : view.name === "material"
            ? "materials"
            : view.name === "bank"
              ? "study"
              : view.name === "wrong"
                ? "mistakes"
                : view.name;
  const due = state.mistakes.filter((m) => !m.resolved && isDue(m.dueAt));
  const recent = [...state.materials]
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
    .slice(0, 3);
  const ongoing = state.sessions.find((s) => s.status === "active");
  const study = state.studies.find((s) => s.status === "active");
  const activeWrongId = wrongAnalysis?.currentId;
  const wrongResults = wrongAnalysis?.results ?? [];
  const wrongFailures = wrongResults.filter((result) => result.status === "failed");
  const pendingWrongCount = wrongAnalysis?.pendingIds.length ?? 0;
  const stoppedWrongCount = wrongAnalysis?.stopped ?? 0;
  const wrongTotal = wrongResults.length + pendingWrongCount + stoppedWrongCount + (activeWrongId ? 1 : 0);
  const questionLabel = (id: string) => {
    const question = state.questions.find((item) => item.id === id);
    return question ? `${question.number}번 · PDF ${question.page}쪽` : "원본 문항";
  };
  return (
    <div className={`app-shell ${focus ? "focus-mode" : ""}`}>
      <aside className="sidebar">
        <button
          className="brand-button"
          onClick={() => navigate({ name: "home" })}
          aria-label="RE 홈"
        >
          <Brand />
        </button>
        <div className="space-label">내 학습 공간</div>
        <nav aria-label="주 메뉴">
          {navigation.map((n) => (
            <button
              key={n.id}
              className={activeNav === n.id ? "active" : ""}
              aria-current={activeNav === n.id ? "page" : undefined}
              onClick={() => navigate({ name: n.id })}
            >
              <n.icon size={19} strokeWidth={1.7} />
              {n.title}
              {n.id === "mistakes" && due.length > 0 && (
                <span className="nav-count">{due.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="sidebar-caption">차곡차곡, 내 것으로.</span>
          <button
            className={`management-entry ${activeNav === "manage" ? "active" : ""}`}
            onClick={() => navigate({ name: "manage" })}
          >
            <Settings2 size={17} />
            <span>콘텐츠 관리</span>
          </button>
          <small className="local-caption">
            로그인한 계정에만 자료가 보여요
          </small>
          <button className="management-entry" onClick={onSettings}>
            <Settings2 size={17} />
            <span>설정</span>
          </button>
        </div>
      </aside>
      <div className="main-shell">
        {!focus && (
          <header className="topbar">
            <div>
              <span>내 학습 공간</span>
              <ChevronRight size={13} />
              <strong>
                {activeNav === "manage"
                  ? "콘텐츠 관리"
                  : navigation.find((n) => n.id === activeNav)?.title}
              </strong>
            </div>
            <span className="topbar-date">
              <CalendarDays size={14} />
              {new Date().toLocaleDateString("ko-KR", {
                month: "long",
                day: "numeric",
                weekday: "short",
              })}
            </span>
            <div className="topbar-more" ref={moreMenu}>
              <button
                type="button"
                aria-expanded={moreOpen}
                aria-controls="mobile-more-menu"
                onClick={() => setMoreOpen((open) => !open)}
              >
                <MoreHorizontal size={18} />
                <span>더보기</span>
              </button>
              {moreOpen && (
                <div
                  className="topbar-more-menu"
                  id="mobile-more-menu"
                  aria-label="추가 메뉴"
                >
                  <button
                    type="button"
                    onClick={() => {
                      navigate({ name: "manage" });
                    }}
                  >
                    콘텐츠 관리
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      onSettings?.();
                    }}
                  >
                    설정
                  </button>
                </div>
              )}
            </div>
          </header>
        )}
        <main id="main-content" className={focus ? "focus-main" : "page-main"}>
          {wrongTotal > 0 && (
            <section aria-label="오답 분석">
              <div className="selection-bar">
                <span role="status">
                  {activeWrongId
                    ? `오답 분석 ${wrongResults.length + 1}/${wrongTotal} · ${questionLabel(activeWrongId)}`
                    : `오답 분석 · 저장 ${wrongResults.length - wrongFailures.length}개`}
                  {wrongFailures.length > 0 && ` · 확인 필요 ${wrongFailures.length}개`}
                  {stoppedWrongCount > 0 && ` · 중지 ${stoppedWrongCount}개`}
                </span>
                {pendingWrongCount > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => wrongQueue.current?.stop()}>
                    다음 분석 멈추기
                  </Button>
                )}
                {!activeWrongId && (
                  <Button variant="ghost" size="sm" onClick={() => setWrongAnalysis(undefined)}>
                    분석 결과 닫기
                  </Button>
                )}
              </div>
              {wrongFailures.length > 0 && (
                <details>
                  <summary>분석이 필요한 문항 {wrongFailures.length}개</summary>
                  <ul>
                    {wrongFailures.map(({ id, message }) => (
                      <li key={id}>
                        <Button variant="ghost" size="sm" onClick={() => navigate({ name: "wrong", id })}>
                          {questionLabel(id)}
                        </Button>{" "}
                        {message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}
          <Suspense
            fallback={<div className="loading">학습 화면을 여는 중…</div>}
          >
            {view.name === "home" && (
              <>
                <div className="page-heading home-heading">
                  <div>
                    <div className="eyebrow">오늘의 학습</div>
                    <h1>오늘은 무엇을 공부할까요?</h1>
                    <p>지난 공부를 돌아보고, 오늘의 학습을 이어 가세요.</p>
                  </div>
                  <Button variant="secondary" onClick={() => setUpload(true)}>
                    <Plus size={16} />
                    파일 추가
                  </Button>
                </div>
                <section className="today-card">
                  <div className="today-icon">
                    <RotateCcw size={27} strokeWidth={1.6} />
                  </div>
                  <div className="today-copy">
                    <span>오늘의 복습</span>
                    <h2>
                      다시 볼 문제 <strong>{due.length}</strong>개
                    </h2>
                    <p>
                      {due.length
                        ? "한 번 더 풀고, 개념까지 확인해 보세요."
                        : "등록한 오답의 복습 일정이 여기에 모여요."}
                    </p>
                  </div>
                  <Button
                    onClick={() =>
                      due.length
                        ? solve(due.map((m) => m.questionId))
                        : setAddMistakes(true)
                    }
                  >
                    {due.length ? "복습 시작" : "오답 등록"}
                    <ArrowRight size={16} />
                  </Button>
                </section>
                <section className="home-section">
                  <div className="section-heading">
                    <h2>최근 자료</h2>
                    <button
                      className="text-button"
                      onClick={() => navigate({ name: "materials" })}
                    >
                      모두 보기
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  <div className="panel">
                    {recent.length ? (
                      recent.map((m) => (
                        <button
                          className="recent-row"
                          key={m.id}
                          onClick={() =>
                            navigate({ name: "material", id: m.id })
                          }
                        >
                          <span className="file-icon">
                            <FileText size={23} strokeWidth={1.5} />
                            <small>
                              {m.mime === "application/pdf" ? "PDF" : "IMG"}
                            </small>
                          </span>
                          <span className="material-info">
                            <strong>{m.title}</strong>
                            <span>
                              {m.subject}
                              <i />
                              {m.pageCount}쪽
                            </span>
                          </span>
                          <MaterialStatus material={m} />
                          <ChevronRight size={18} />
                        </button>
                      ))
                    ) : (
                      <Empty
                        title="공부할 자료를 추가해 보세요"
                        description="문제집, 교과서, 학습지를 한곳에서 관리하세요."
                        action={
                          <Button
                            variant="secondary"
                            onClick={() => setUpload(true)}
                          >
                            <Plus size={15} />
                            파일 추가
                          </Button>
                        }
                      />
                    )}
                  </div>
                </section>
                <div className="home-columns">
                  <section className="home-section">
                    <div className="section-heading">
                      <h2>이어서 학습하기</h2>
                    </div>
                    <div className="panel continue-panel">
                      {ongoing || study ? (
                        <button
                          className="continue-item"
                          onClick={() =>
                            navigate({
                              name: ongoing ? "solve" : "study-session",
                              id: ongoing?.id || study?.id,
                            })
                          }
                        >
                          <span className="continue-icon">
                            <BookOpen size={21} />
                          </span>
                          <span>
                            <strong>
                              {ongoing
                                ? "오답 다시 풀기"
                                : study?.label || "개념 학습"}
                            </strong>
                            <small>이전 학습 이어하기</small>
                          </span>
                          <ArrowRight size={17} />
                        </button>
                      ) : (
                        <div className="compact-empty">
                          <BookOpen size={21} />
                          <div>
                            <strong>이어서 할 학습이 없어요</strong>
                            <p>자료와 범위를 고르고 학습을 시작하세요.</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </section>
                  <section className="home-section">
                    <div className="section-heading">
                      <h2>나의 학습 기록</h2>
                    </div>
                    <div className="panel home-stats">
                      <div>
                        <strong>{state.materials.length}</strong>
                        <span>내 자료</span>
                      </div>
                      <div>
                        <strong>{state.mistakes.length}</strong>
                        <span>등록한 오답</span>
                      </div>
                      <div>
                        <strong>
                          {
                            state.studies.filter((s) => s.status === "complete")
                              .length
                          }
                        </strong>
                        <span>마친 학습</span>
                      </div>
                    </div>
                  </section>
                </div>
                <div className="home-tip">
                  <span className="tiny-line" />
                  복습 간격은 풀이 결과에 맞춰 조정돼요.
                </div>
              </>
            )}
            {view.name === "materials" && (
              <Materials
                state={state}
                onOpen={(id) => navigate({ name: "material", id })}
                onUpload={() => setUpload(true)}
                onStudy={(ids) => {
                  setStudyIds(ids);
                  navigate({ name: "study" });
                }}
                run={run}
              />
            )}
            {view.name === "viewer" && view.id && (
              <Viewer
                key={view.id + String(view.manage)}
                id={view.id}
                initialPage={view.page}
                manage={!!view.manage}
                concepts={state.concepts}
                questions={state.questions}
                onBack={() => navigate(returnView.current)}
                onChange={refresh}
                onError={notify}
                onRegistered={registeredWrong}
              />
            )}
            {view.name === "material" && view.id && (
              <MaterialWorkspace
                key={view.id}
                id={view.id}
                state={state}
                onBack={() => navigate({ name: "materials" })}
                onViewer={(page, manage) => open(view.id!, page, manage)}
                onBank={(scope) => {
                  setBankScope(scope);
                  navigate({ name: "bank" });
                }}
                onError={notify}
                onRefresh={refresh}
              />
            )}
            {view.name === "bank" && (
              <Bank
                initial={bankScope}
                onBack={() => navigate(bankReturn.current)}
                onStart={(id) => {
                  void refresh();
                  navigate({ name: "study-session", id });
                }}
                onGenerate={(id) => navigate({ name: "material", id })}
                onError={notify}
              />
            )}
            {view.name === "mistakes" && (
              <Mistakes
                state={state}
                filters={mistakeFilters}
                onFilters={setMistakeFilters}
                onAdd={() => setAddMistakes(true)}
                onSolve={solve}
                onConcept={(id) => navigate({ name: "wrong", id })}
                onOpen={open}
                onRemoved={(ids) => {
                  const archived = new Set(ids);
                  wrongQueue.current?.remove(state.mistakes.filter((m) => archived.has(m.id)).map((m) => m.questionId));
                  setState((current) => current && {
                    ...current,
                    mistakes: current.mistakes.filter((m) => !archived.has(m.id)),
                  });
                }}
                onError={notify}
              />
            )}
            {view.name === "solve" && view.id && (
              <Solve
                key={view.id}
                id={view.id}
                state={state}
                onBack={() => navigate({ name: "mistakes" })}
                onRefresh={refresh}
                onError={notify}
                onConcept={concept}
                onBank={(scope) => {
                  setBankScope(scope);
                  navigate({ name: "bank" });
                }}
                onSolve={solve}
                onDetails={(id) => navigate({ name: "wrong", id })}
              />
            )}
            {view.name === "wrong" && view.id && (
              <WrongWorkspace
                key={view.id}
                id={view.id}
                analysisPending={activeWrongId === view.id || !!wrongAnalysis?.pendingIds.includes(view.id)}
                analysisCompleted={wrongResults.some((result) => result.id === view.id && result.status === "completed")}
                onAnalyze={() => wrongQueue.current?.enqueue([view.id!])}
                state={state}
                onBack={() => navigate({ name: "mistakes" })}
                onBank={(scope) => {
                  setBankScope(scope);
                  navigate({ name: "bank" });
                }}
                onSolve={solve}
                onViewer={open}
                onError={notify}
                onRefresh={refresh}
              />
            )}
            {view.name === "study" && (
              <>
                <div className="section-heading">
                  <h2>저장된 문제 은행</h2>
                  <Button
                    onClick={() => {
                      setBankScope({ materialIds: studyIds });
                      navigate({ name: "bank" });
                    }}
                  >
                    문제 은행 열기
                    <ArrowRight size={16} />
                  </Button>
                </div>
                <StudySetup
                  state={state}
                  initialIds={studyIds}
                  onStart={(id) => {
                    refresh().catch((e) => notify(e.message));
                    navigate({ name: "study-session", id });
                  }}
                  onOpen={open}
                  onBank={(scope) => {
                    setBankScope(scope);
                    navigate({ name: "bank" });
                  }}
                  onMaterial={(id) => navigate({ name: "material", id })}
                  onError={notify}
                />
              </>
            )}
            {view.name === "study-session" && view.id && (
              <StudyPlayer
                key={view.id}
                id={view.id}
                state={state}
                onBack={() => navigate({ name: "study" })}
                onRefresh={refresh}
                onOpen={open}
                onError={notify}
                onSolve={solve}
              />
            )}
            {view.name === "manage" && (
              <ContentManager
                state={state}
                onRefresh={refresh}
                onError={notify}
                onOpen={(id, page) => open(id, page, true)}
                onExit={() => navigate({ name: "home" })}
              />
            )}
          </Suspense>
        </main>
      </div>
      {!focus && (
        <nav className="mobile-nav" aria-label="주 메뉴">
          {navigation.map((n) => (
            <button
              key={n.id}
              className={activeNav === n.id ? "active" : ""}
              aria-current={activeNav === n.id ? "page" : undefined}
              onClick={() => navigate({ name: n.id })}
            >
              <n.icon size={21} />
              <span>{n.title}</span>
            </button>
          ))}
        </nav>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <IconButton label="알림 닫기" onClick={() => setToast("")}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {busy && (
        <div className="busy-indicator" role="status">
          <span className="small-spinner" />
          {busy} 중…
        </div>
      )}
      {upload && (
        <UploadDialog
          subjects={[...new Set(state.materials.map((m) => m.subject))]}
          onClose={() => setUpload(false)}
          onDone={refresh}
        />
      )}
      {addMistakes && (
        <AddMistakes
          state={state}
          preferredMaterial={view.name === "material" ? view.id || "" : mistakeFilters.material}
          subject={mistakeFilters.subject}
          onClose={() => setAddMistakes(false)}
          onDone={refresh}
          onRegistered={registeredWrong}
        />
      )}
    </div>
  );
}
