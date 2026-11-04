export class LearningError extends Error {
  readonly kind = "learning";
}
/** Deterministic learning over saved, reviewed content. No I/O and no inference. */
export type LearningState = {
  questions: any[];
  concepts: any[];
  bank: any[];
  results: any[];
  mistakes: any[];
  materials?: any[];
  pages?: any[];
};
type StudyAnswer = {
  itemId: string;
  response?: string;
  selfGrade?: "correct" | "wrong";
  memory?: "known" | "unsure" | "unknown";
};
type SolveAnswer = {
  questionId: string;
  result?: "correct" | "wrong" | "skip";
  strokes?: any[];
  answerText?: string;
  drawingOnly?: boolean;
};
const clone = <T>(value: T): T => structuredClone(value);
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const itemConcepts = (item: any): string[] =>
  unique(
    [
      item.conceptId,
      ...(Array.isArray(item.conceptIds) ? item.conceptIds : []),
    ].filter((id): id is string => typeof id === "string" && !!id),
  );
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const list = (value: any): any[] => (Array.isArray(value) ? value : []);
const normalize = (value: string): string =>
  value.normalize("NFKC").trim().replace(/\s+/gu, "");
const approved = (item: any): boolean =>
  item.active === true &&
  [undefined, "approved", "reviewed", "accepted"].includes(
    item.review_status ?? item.reviewStatus,
  );
function find<T extends { id: string }>(
  rows: T[],
  id: string,
  message: string,
): T {
  const row = rows.find((entry) => entry.id === id);
  if (!row) throw new LearningError(message);
  return row;
}
function sources(item: any, state: LearningState): any[] {
  return list(item.sources).length
    ? item.sources
    : list(state.concepts.find((c) => c.id === item.conceptId)?.sources);
}
function validIds(ids: unknown): string[] {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 200 ||
    ids.some((id) => typeof id !== "string" || !id)
  )
    throw new LearningError("1~200개의 문제를 선택해 주세요.");
  return unique(ids);
}
function select(
  pool: any[],
  cids: string[],
  count: number,
  state: Pick<LearningState, "results">,
  excluded: string[] = [],
): any[] {
  const excludedSet = new Set(excluded);
  const histories = new Map<
    string,
    { attempts: number; lastCorrect: string }
  >();
  const statistics = new Map<string, { total: number; wrong: number }>();
  for (const result of state.results) {
    const history = histories.get(result.bankItemId) || {
      attempts: 0,
      lastCorrect: "",
    };
    history.attempts++;
    if (
      result.result === "correct" &&
      String(result.createdAt || "") > history.lastCorrect
    )
      history.lastCorrect = result.createdAt;
    histories.set(result.bankItemId, history);
    for (const cid of itemConcepts(result)) {
      const stat = statistics.get(cid) || { total: 0, wrong: 0 };
      stat.total++;
      if (
        ["wrong", "unsure", "unknown"].includes(result.result) ||
        ["unsure", "unknown"].includes(result.memory)
      )
        stat.wrong++;
      statistics.set(cid, stat);
    }
  }
  const conceptOrder = (a: string, b: string) => {
    const x = statistics.get(a) || { total: 0, wrong: 0 },
      y = statistics.get(b) || { total: 0, wrong: 0 };
    return (
      y.wrong / Math.max(1, y.total) - x.wrong / Math.max(1, x.total) ||
      x.total - y.total ||
      compare(a, b)
    );
  };
  const itemOrder = (a: any, b: any) => {
    const x = histories.get(a.bankItemId || a.id) || {
        attempts: 0,
        lastCorrect: "",
      },
      y = histories.get(b.bankItemId || b.id) || {
        attempts: 0,
        lastCorrect: "",
      };
    return (
      Number(x.attempts > 0) - Number(y.attempts > 0) ||
      x.attempts - y.attempts ||
      compare(x.lastCorrect, y.lastCorrect) ||
      compare(a.bankItemId || a.id, b.bankItemId || b.id)
    );
  };
  const available = pool.filter(
    (item) => !excludedSet.has(item.bankItemId || item.id),
  );
  const ordered = [...available].sort(itemOrder),
    selected: any[] = [];
  for (const cid of [...cids].sort(conceptOrder)) {
    const item = ordered.find(
      (entry) =>
        itemConcepts(entry).includes(cid) &&
        !selected.some(
          (s) => (s.bankItemId || s.id) === (entry.bankItemId || entry.id),
        ),
    );
    if (item) selected.push(item);
    if (selected.length >= count) return selected;
  }
  const chosen = new Set(selected.map((item) => item.bankItemId || item.id));
  for (const item of [...ordered].sort(
    (a, b) => conceptOrder(a.conceptId, b.conceptId) || itemOrder(a, b),
  )) {
    const id = item.bankItemId || item.id;
    if (!chosen.has(id)) {
      selected.push(item);
      chosen.add(id);
    }
    if (selected.length >= count) break;
  }
  return selected;
}
function snapshot(item: any, state: LearningState): any {
  const concept = find(
    state.concepts,
    item.conceptId,
    "등록된 개념을 찾을 수 없습니다. 콘텐츠 관리에서 확인해 주세요.",
  );
  if (
    typeof item.answer !== "string" ||
    !item.answer.trim() ||
    typeof item.explanation !== "string"
  )
    throw new LearningError("등록된 문항의 정답과 해설을 확인해 주세요.");
  return clone({
    id: uuid(),
    bankItemId: item.id,
    conceptId: item.conceptId,
    conceptIds: itemConcepts(item),
    kind: item.kind,
    purpose: item.purpose,
    chapterId: item.chapterId,
    type: item.type,
    prompt: item.prompt,
    choices: list(item.choices),
    answer: item.answer,
    acceptedAnswers: list(item.acceptedAnswers),
    explanation: item.explanation,
    choiceFeedback: item.choiceFeedback || {},
    correction: item.correction || "",
    difficulty: item.difficulty,
    sources: sources(item, state),
    modes: list(item.modes),
    active: true,
    concept: concept.name,
    conceptDefinition: concept.definition,
    conceptProperties: list(concept.properties),
    misconceptionLabels: Object.fromEntries(
      list(concept.misconceptions).map((entry) => [entry.id, entry.label]),
    ),
  });
}
function fromSnapshot(item: any): any {
  return { ...clone(item), id: uuid() };
}
function studySession(
  mode: string,
  label: string,
  items: any[],
  materialIds: string[],
  conceptIds: string[],
): any {
  return {
    id: uuid(),
    version: 0,
    mode,
    label,
    items,
    materialIds: unique(materialIds),
    originQuestionIds: [],
    conceptIds: unique(conceptIds),
    understoodConceptIds: [],
    remainingConceptIds: [],
    rechecks: {},
    createdAt: now(),
    status: "active",
    notice: "",
  };
}

export function relatedOriginalIds(item: any, questions: any[]): string[] {
  return questions
    .filter((q) => {
      if (list(item.preparedQuestionIds).includes(q.id)) return true;
      const refs = [
        ...(item.origins || []).map((o: any) => ({
          ref: o.data?.source_problem || o.data?.sourceProblem,
          documentId: o.document_id,
        })),
        { ref: item.sourceProblem, documentId: null },
      ];
      return refs.some(
        ({ ref, documentId }) =>
          ref &&
          String(Number(ref.q_number)) === String(q.number) &&
          ref.pdf_page === q.page &&
          (documentId === q.materialId ||
            (!documentId &&
              (item.sources || []).some(
                (s: any) => s.materialId === q.materialId,
              ))),
      );
    })
    .map((q) => q.id);
}
/** Explicit single-original preparation is provenance, not a concept guess.
 * Content refs also retain the link when a bank item was deduplicated. */
export function preparedBankLinks(
  jobs: any[],
  refs: any[],
  questions: any[],
): Map<string, string[]> {
  const targets = new Map(
    jobs
      .filter(
        (j) =>
          j.task_type === "problem" &&
          j.first_target &&
          !j.second_target &&
          questions.some(
            (q) => q.id === j.first_target && q.materialId === j.document_id,
          ),
      )
      .map((j) => [j.id, j.first_target]),
  );
  const links = new Map<string, string[]>();
  for (const ref of refs) {
    const target = targets.get(ref.job_id);
    if (target && ["question", "flashcard"].includes(ref.kind))
      links.set(
        ref.actual_id,
        unique([...(links.get(ref.actual_id) ?? []), target]),
      );
  }
  return links;
}
export function createBankStudy(options: any, state: LearningState): any {
  const count = Number(options.count ?? 20),
    mode = options.mode || "quiz";
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1000 ||
    !["quiz", "check", "memory"].includes(mode)
  )
    throw new LearningError("문제 수와 학습 방식을 확인하세요.");
  const cids = list(options.conceptIds),
    chapters = list(options.chapterIds),
    materials = list(options.materialIds),
    kinds = list(options.kinds),
    purposes = list(options.purposes),
    levels = list(options.levels),
    subjects = list(options.subjects);
  let pool = state.bank.filter(
    (i) =>
      approved(i) &&
      list(i.modes).includes(mode) &&
      (!cids.length || itemConcepts(i).some((id) => cids.includes(id))) &&
      (!chapters.length ||
        [i.chapterId, ...list(i.chapterIds)].some((id) =>
          chapters.includes(id),
        )) &&
      (!materials.length ||
        sources(i, state).some((s) => materials.includes(s.materialId))) &&
      (!kinds.length ||
        kinds.includes(
          i.kind ||
            (
              { 객관식: "mcq", OX: "ox", 단답형: "short", 빈칸: "blank" } as any
            )[i.type],
        )) &&
      (!purposes.length ||
        [i.purpose, ...list(i.purposes)].some((p) => purposes.includes(p))) &&
      (!levels.length ||
        levels.includes(
          i.level ||
            ({ 기본: "easy", 보통: "medium", 심화: "hard" } as any)[
              i.difficulty
            ],
        )) &&
      (!subjects.length ||
        itemConcepts(i).some((id) =>
          subjects.includes(state.concepts.find((c) => c.id === id)?.subject),
        )),
  );
  if (Array.isArray(options.bankItemIds) && options.bankItemIds.length)
    pool = pool.filter((i) => options.bankItemIds.includes(i.id));
  if (options.originalId) {
    const original = find(
      state.questions,
      options.originalId,
      "원본 문항을 찾을 수 없습니다.",
    );
    pool = pool.filter(
      (i) =>
        relatedOriginalIds(i, [original]).length > 0 ||
        itemConcepts(i).some((id) => list(original.conceptIds).includes(id)),
    );
  }
  if (list(options.questionIds).length)
    pool = pool.filter((i) =>
      relatedOriginalIds(i, state.questions).some((id) =>
        options.questionIds.includes(id),
      ),
    );
  if (!pool.length)
    throw new LearningError(
      "조건에 맞는 저장 문항이 없습니다. 범위를 바꾸거나 콘텐츠를 추가하세요.",
    );
  const order = options.order || "unattempted",
    history = new Map<string, any>();
  for (const r of [...state.results].sort((a, b) =>
    compare(a.createdAt || "", b.createdAt || ""),
  ))
    history.set(r.bankItemId, r);
  if (order === "weak")
    pool = select(pool, unique(pool.flatMap(itemConcepts)), pool.length, state);
  else if (order === "random") {
    pool = [...pool];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  } else if (order === "mixed") {
    const groups = ["기본", "보통", "심화"].map((level) =>
      pool.filter((i) => i.difficulty === level),
    );
    const mixed: any[] = [];
    for (let n = 0; groups.some((g) => n < g.length); n++)
      for (const group of groups) if (group[n]) mixed.push(group[n]);
    pool = mixed;
  } else if (["sequential", "unattempted", "wrong"].includes(order))
    pool = [...pool].sort((a, b) =>
      order === "unattempted"
        ? Number(history.has(a.id)) - Number(history.has(b.id)) ||
          String(a.externalId || a.id).localeCompare(
            String(b.externalId || b.id),
            "ko",
            { numeric: true },
          )
        : order === "wrong"
          ? Number(history.get(b.id)?.result === "wrong") -
              Number(history.get(a.id)?.result === "wrong") ||
            String(a.id).localeCompare(String(b.id))
          : String(a.externalId || a.id).localeCompare(
              String(b.externalId || b.id),
              "ko",
              { numeric: true },
            ),
    );
  else throw new LearningError("출제 순서를 확인하세요.");
  const chosen = pool.slice(0, count),
    session = studySession(
      mode,
      "문제 은행",
      chosen.map((i) => snapshot(i, state)),
      unique(chosen.flatMap((i) => sources(i, state).map((s) => s.materialId))),
      unique(chosen.flatMap(itemConcepts)),
    );
  session.bankStudy = true;
  session.linkedQuestionIds = unique([
    ...list(options.questionIds),
    ...(options.originalId ? [options.originalId] : []),
  ]);
  if (chosen.length < count)
    session.notice = `조건에 맞는 ${chosen.length}문제로 시작합니다. 추가 생성은 별도로 선택할 수 있습니다.`;
  return session;
}
export function createReview(questionIds: string[], state: LearningState): any {
  const ids = validIds(questionIds);
  const questions = ids.map((id) =>
    find(state.questions, id, "문제를 찾을 수 없습니다."),
  );
  const cids = unique(
    questions.flatMap((question) => {
      if (!list(question.conceptIds).length)
        throw new LearningError(
          `${question.number}번: 개념 미등록입니다. 콘텐츠 관리에서 매핑을 등록해 주세요.`,
        );
      return question.conceptIds as string[];
    }),
  );
  for (const cid of cids)
    find(
      state.concepts,
      cid,
      "등록된 개념을 찾을 수 없습니다. 콘텐츠 관리에서 확인해 주세요.",
    );
  const pool = state.bank.filter(
    (item) =>
      approved(item) &&
      itemConcepts(item).some((cid) => cids.includes(cid)) &&
      list(item.modes).some((mode) => ["quiz", "check"].includes(mode)),
  );
  const missing = cids.filter(
    (cid) => !pool.some((item) => itemConcepts(item).includes(cid)),
  );
  if (missing.length)
    throw new LearningError(
      `복습 문항 미등록: ${missing.map((cid) => state.concepts.find((c) => c.id === cid).name).join(", ")}`,
    );
  const chosen = select(pool, cids, 5, state);
  const session = studySession(
    "check",
    "개념 복습",
    chosen.map((item) => snapshot(item, state)),
    questions.map((q) => q.materialId),
    cids,
  );
  session.originQuestionIds = ids;
  session.questionSnapshots = clone(questions);
  session.reviewPool = pool.map((item) => snapshot(item, state));
  session.remainingConceptIds = cids.filter(
    (cid) => !chosen.some((item) => itemConcepts(item).includes(cid)),
  );
  return session;
}
function parsePages(value: unknown): number[] {
  if (typeof value !== "string" || value.length > 4000)
    throw new LearningError("페이지 번호 입력을 확인해 주세요.");
  const pages: number[] = [];
  for (const token of value.trim().split(/[\s,，、]+/u)) {
    const match = /^(\d{1,5})(?:[-~–](\d{1,5}))?$/u.exec(token);
    if (!match)
      throw new LearningError(`페이지 번호를 확인해 주세요: ${token}`);
    const start = Number(match[1]),
      end = Number(match[2] || start);
    if (
      start < 1 ||
      end < start ||
      end - start >= 500 ||
      pages.length + end - start + 1 > 500
    )
      throw new LearningError(
        "페이지 번호는 한 번에 500개 이하로 입력해 주세요.",
      );
    for (let page = start; page <= end; page++) pages.push(page);
  }
  return unique(pages);
}
export function createStudy(body: any, state: LearningState): any {
  if (!["quiz", "memory", "check"].includes(body?.mode))
    throw new LearningError("학습 방식을 확인해 주세요.");
  if (!Number.isInteger(body.count) || body.count < 1 || body.count > 20)
    throw new LearningError("문제 수는 1~20개로 선택해 주세요.");
  if (!Array.isArray(body.materials) || !body.materials.length)
    throw new LearningError("한 과목의 자료를 선택해 주세요.");
  if (!["전체", "기본", "보통", "심화"].includes(body.difficulty || "보통"))
    throw new LearningError("난이도를 확인해 주세요.");
  const scopes = new Map<string, Set<number> | null>(),
    subjects = new Set<string>();
  for (const choice of body.materials) {
    if (!choice || typeof choice.id !== "string")
      throw new LearningError("선택한 자료를 확인해 주세요.");
    const material = state.materials
      ? find(state.materials, choice.id, "자료를 찾을 수 없습니다.")
      : undefined;
    if (material?.archived)
      throw new LearningError("보관된 자료는 새 학습에서 선택할 수 없습니다.");
    if (material?.subject) subjects.add(material.subject);
    else
      for (const concept of state.concepts)
        if (
          list(concept.sources).some(
            (source) => source.materialId === choice.id,
          ) &&
          concept.subject
        )
          subjects.add(concept.subject);
    const input = choice.pages ?? "";
    if (typeof input !== "string")
      throw new LearningError("페이지 번호 입력을 확인해 주세요.");
    const requested = input.trim() ? parsePages(input) : null;
    if (state.pages) {
      const pages = state.pages.filter((page) => page.materialId === choice.id);
      if (
        requested?.some(
          (page) =>
            (Number.isInteger(material?.pageCount) &&
              page > material.pageCount) ||
            pages.some(
              (known) => known.number === page && known.kind === "answers",
            ),
        )
      )
        throw new LearningError(
          `${material?.title || "선택 자료"}: 출처 페이지 범위를 확인해 주세요.`,
        );
      scopes.set(choice.id, requested ? new Set(requested) : null);
    } else scopes.set(choice.id, requested ? new Set(requested) : null);
  }
  if (subjects.size > 1)
    throw new LearningError("한 과목의 자료를 선택해 주세요.");
  const pool = state.bank.filter((item) => {
    const concept = state.concepts.find((c) => c.id === item.conceptId);
    if (
      !concept ||
      !approved(item) ||
      !list(item.modes).includes(body.mode) ||
      (subjects.size && !subjects.has(concept.subject))
    )
      return false;
    if (
      (body.mode === "quiz" &&
        body.type !== "전체" &&
        item.type !== body.type) ||
      (body.difficulty !== "전체" &&
        item.difficulty !== (body.difficulty || "보통"))
    )
      return false;
    const refs = sources(item, state);
    return (
      refs.length > 0 &&
      refs.some(
        (source) =>
          scopes.has(source.materialId) &&
          Number.isInteger(source.page) &&
          source.page > 0 &&
          !state.pages?.some(
            (page) =>
              page.materialId === source.materialId &&
              page.number === source.page &&
              page.kind === "answers",
          ) &&
          (!state.materials?.find(
            (material) => material.id === source.materialId,
          )?.pageCount ||
            source.page <=
              state.materials.find(
                (material) => material.id === source.materialId,
              ).pageCount) &&
          (scopes.get(source.materialId) === null ||
            scopes.get(source.materialId)!.has(source.page)),
      )
    );
  });
  if (!pool.length)
    throw new LearningError(
      "선택한 자료·페이지·유형에 연결된 사전 문항이 없습니다. 콘텐츠 관리에서 등록해 주세요.",
    );
  const cids = unique(pool.map((item) => item.conceptId)),
    chosen = select(pool, cids, body.count, state);
  const labels: Record<string, string> = {
    quiz: "문제 풀기",
    memory: "암기하기",
    check: "개념 확인",
  };
  const session = studySession(
    body.mode,
    labels[body.mode],
    chosen.map((item) => snapshot(item, state)),
    [...scopes.keys()],
    cids,
  );
  if (chosen.length < body.count)
    session.notice = `등록된 문항 ${chosen.length}개로 시작합니다.`;
  return session;
}
export function repeatWeak(state: LearningState): any {
  const latest = new Map<string, any>();
  for (const result of state.results) {
    const previous = latest.get(result.bankItemId);
    if (
      !previous ||
      String(result.createdAt || "") >= String(previous.createdAt || "")
    )
      latest.set(result.bankItemId, result);
  }
  let pool = state.bank.filter((item) => {
    const result = latest.get(item.id);
    return (
      approved(item) &&
      result &&
      (["wrong", "unsure", "unknown"].includes(result.result) ||
        ["unsure", "unknown"].includes(result.memory))
    );
  });
  const mode =
    pool.length && pool.every((item) => list(item.modes).includes("memory"))
      ? "memory"
      : "check";
  pool = pool.filter((item) =>
    list(item.modes).some((value) =>
      mode === "memory"
        ? value === "memory"
        : ["check", "quiz"].includes(value),
    ),
  );
  if (!pool.length) throw new LearningError("다시 볼 개념이 없습니다.");
  const cids = unique(pool.map((item) => item.conceptId)),
    chosen = select(pool, cids, 30, state);
  return studySession(
    mode,
    "다시 볼 개념",
    chosen.map((item) => snapshot(item, state)),
    chosen.flatMap((item) =>
      sources(item, state).map((source) => source.materialId),
    ),
    unique(chosen.map((item) => item.conceptId)),
  );
}
function updateReview(session: any, item: any, state: Pick<LearningState, "results">) {
  const understood = new Set<string>(session.understoodConceptIds || []);
  for (const cid of itemConcepts(item)) {
    if (item.result === "correct") understood.add(cid);
    else {
      understood.delete(cid);
      const pending = session.items.some(
        (entry: any) =>
          itemConcepts(entry).includes(cid) &&
          !entry.result &&
          entry.bankItemId !== item.bankItemId,
      );
      const rechecks = session.rechecks[cid] || 0;
      if (!pending && rechecks < 3) {
        const pool = session.reviewPool.filter(
          (entry: any) =>
            itemConcepts(entry).includes(cid) &&
            entry.bankItemId !== item.bankItemId,
        );
        const used = session.items.map((entry: any) => entry.bankItemId);
        const candidate =
          select(pool, [cid], 1, state, used)[0] ||
          select(pool, [cid], 1, state)[0];
        if (candidate) {
          session.items.push(fromSnapshot(candidate));
          for (const related of itemConcepts(candidate))
            session.rechecks[related] = (session.rechecks[related] || 0) + 1;
        }
      }
    }
  }
  session.understoodConceptIds = [...understood].sort(compare);
  if (
    session.items.every((entry: any) => entry.result) &&
    session.remainingConceptIds.length
  ) {
    const remaining = session.remainingConceptIds;
    const chosen = select(
      session.reviewPool.filter((entry: any) =>
        itemConcepts(entry).some((cid) => remaining.includes(cid)),
      ),
      remaining,
      5,
      state,
    );
    session.items.push(...chosen.map(fromSnapshot));
    session.remainingConceptIds = remaining.filter(
      (id: string) => !chosen.some((entry) => itemConcepts(entry).includes(id)),
    );
    if (!chosen.length) {
      session.notice =
        "남은 개념에 사용할 문항이 없습니다. 콘텐츠를 확인해 주세요.";
      session.remainingConceptIds = [];
    }
  }
}
export function answerStudy(
  input: any,
  body: StudyAnswer,
  state: Pick<LearningState, "questions" | "results" | "mistakes">,
): { session: any; attempt?: any; mistakes: any[] } {
  const session = clone(input),
    item = find<any>(
      session.items,
      body?.itemId,
      "학습 항목을 찾을 수 없습니다.",
    );
  if (item.result || item.memory) return { session, mistakes: [] };
  const at = now();
  let result: string;
  if (session.mode === "memory") {
    if (!["known", "unsure", "unknown"].includes(body.memory || ""))
      throw new LearningError("암기 상태를 선택해 주세요.");
    item.memory = body.memory;
    item.answeredAt = at;
    result = body.memory!;
  } else {
    const response = body.response ?? "";
    if (typeof response !== "string" || response.length > 20000)
      throw new LearningError("답변을 확인해 주세요.");
    if (item.type === "서술형" || item.waitingSelfGrade) {
      if (body.selfGrade !== undefined) {
        if (!item.responseSubmitted)
          throw new LearningError("답변을 먼저 제출한 뒤 자기 채점해 주세요.");
        if (!["correct", "wrong"].includes(body.selfGrade))
          throw new LearningError("자기 채점 결과를 선택해 주세요.");
        result = body.selfGrade;
      } else {
        if (!response.trim()) throw new LearningError("답변을 입력해 주세요.");
        if (!item.responseSubmitted) item.response = response;
        item.responseSubmitted = true;
        item.requiresSelfGrade = true;
        item.waitingSelfGrade = true;
        return { session, mistakes: [] };
      }
    } else if (["객관식", "OX"].includes(item.type)) {
      if (!list(item.choices).includes(response))
        throw new LearningError("선택지에서 답을 선택해 주세요.");
      result = response === item.answer ? "correct" : "wrong";
      item.response = response;
    } else {
      if (!response.trim()) throw new LearningError("답변을 입력해 주세요.");
      result = [item.answer, ...list(item.acceptedAnswers)].some(
        (answer) =>
          typeof answer === "string" &&
          normalize(answer) === normalize(response),
      )
        ? "correct"
        : "wrong";
      item.response = response;
      if (result === "wrong") {
        item.responseSubmitted = true;
        item.requiresSelfGrade = true;
        item.waitingSelfGrade = true;
        return { session, mistakes: [] };
      }
    }
    item.result = result;
    item.answeredAt = at;
    item.waitingSelfGrade = false;
    const selected =
      result === "wrong" ? item.choiceFeedback?.[item.response] || {} : {};
    item.feedback =
      selected.explanation ||
      (result === "wrong" ? item.correction : "") ||
      item.explanation;
    item.misconceptionTag = selected.misconceptionTag || "";
    item.misconceptionLabel =
      item.misconceptionLabels?.[item.misconceptionTag] || "";
    if (list(session.originQuestionIds).length)
      updateReview(session, item, state);
    else {
      const understood = new Set<string>(session.understoodConceptIds || []);
      for (const cid of itemConcepts(item))
        if (result === "correct") understood.add(cid);
        else understood.delete(cid);
      session.understoodConceptIds = [...understood].sort(compare);
    }
  }
  const attempt = {
    id: uuid(),
    sessionId: session.id,
    itemId: item.id,
    bankItemId: item.bankItemId,
    conceptId: item.conceptId,
    conceptIds: itemConcepts(item),
    manualGrade: body.selfGrade !== undefined,
    result,
    createdAt: at,
    ...(item.memory ? { memory: item.memory } : {}),
    misconceptionTag: item.misconceptionTag || "",
  };
  session.status =
    session.items.every((entry: any) =>
      session.mode === "memory" ? entry.memory : entry.result,
    ) && !list(session.remainingConceptIds).length
      ? "complete"
      : "active";
  const mistakes: any[] = [];
  if (session.status === "complete" && list(session.originQuestionIds).length) {
    session.mastered = session.conceptIds.every((cid: string) =>
      session.understoodConceptIds.includes(cid),
    );
    if (!session.mastered)
      session.notice =
        "복습은 마쳤지만 이해가 확인되지 않은 개념이 있습니다. 오답 노트에서 다시 복습할 수 있습니다.";
    for (const mistake of state.mistakes)
      if (session.originQuestionIds.includes(mistake.questionId)) {
        const question = list(session.questionSnapshots).find(
          (q) => q.id === mistake.questionId,
        );
        const ids = list(question?.conceptIds);
        mistakes.push({
          ...clone(mistake),
          conceptState:
            ids.length &&
            ids.every((cid) => session.understoodConceptIds.includes(cid))
              ? "understood"
              : "reviewing",
        });
      }
  }
  if (session.mode !== "memory" && !list(session.originQuestionIds).length) {
    const latest = new Map<string, any>();
    for (const previous of [...state.results]
      .filter((r) => ["correct", "wrong"].includes(r.result))
      .sort((a, b) => compare(a.createdAt || "", b.createdAt || "")))
      for (const cid of itemConcepts(previous)) latest.set(cid, previous);
    for (const cid of itemConcepts(attempt)) latest.set(cid, attempt);
    for (const mistake of state.mistakes) {
      const question = state.questions.find((q) => q.id === mistake.questionId),
        cids = list(question?.conceptIds);
      if (!cids.some((cid) => itemConcepts(item).includes(cid))) continue;
      const history = [...state.results, attempt].filter(
        (r) =>
          ["correct", "wrong"].includes(r.result) &&
          itemConcepts(r).some((cid) => cids.includes(cid)),
      );
      mistakes.push({
        ...clone(mistake),
        conceptState: cids.every((cid) => latest.get(cid)?.result === "correct")
          ? "understood"
          : "reviewing",
        conceptAccuracy: Math.round(
          (100 * history.filter((r) => r.result === "correct").length) /
            Math.max(1, history.length),
        ),
        lastConceptReviewAt: at,
        ...(result === "wrong"
          ? {
              dueAt: new Date(
                Math.min(
                  Date.parse(mistake.dueAt) || Infinity,
                  Date.parse(at) + 86400000,
                ),
              ).toISOString(),
            }
          : {}),
      });
    }
  }
  return { session, attempt, mistakes };
}
export function publicStudy(input: any): any {
  const session = clone(input);
  delete session.questionSnapshots;
  delete session.reviewPool;
  for (const item of session.items) {
    const reveal =
      session.mode === "memory" ||
      item.result ||
      item.memory ||
      (item.responseSubmitted && item.waitingSelfGrade);
    if (!reveal)
      for (const key of [
        "answer",
        "explanation",
        "acceptedAnswers",
        "choiceFeedback",
        "correction",
      ])
        delete item[key];
    delete item.active;
  }
  return session;
}
export function revealStudy(
  input: any,
  itemId: string,
): { session: any; answer: string; explanation: string } {
  const session = clone(input),
    item = find<any>(session.items, itemId, "학습 항목을 찾을 수 없습니다.");
  if (
    session.mode !== "memory" &&
    item.type !== "서술형" &&
    !item.waitingSelfGrade
  )
    throw new LearningError(
      "암기 또는 자기 채점 문항에서만 답을 펼칠 수 있습니다.",
    );
  if (session.mode !== "memory" && !item.responseSubmitted)
    throw new LearningError("답변을 먼저 제출해 주세요.");
  item.revealedAt ||= now();
  return { session, answer: item.answer, explanation: item.explanation };
}
function privatePath(path: unknown): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !/^[a-z][a-z0-9+.-]*:/iu.test(path) &&
    !/[\\?#]/u.test(path) &&
    !path.startsWith("/") &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
export function createSolve(questions: any[]): any {
  const ids = validIds(
    Array.isArray(questions) ? questions.map((q) => q?.id) : [],
  );
  const snapshots = ids.map((id) => {
    const question = find(questions, id, "문제를 찾을 수 없습니다.");
    const regions = list(question.regions),
      paths = list(question.imagePaths);
    if (question.autoRetired || question.mergedInto)
      throw new LearningError("현재 사용하는 원본 문항을 선택해 주세요.");
    if (!regions.length || paths.length !== regions.length)
      throw new LearningError(
        "미리 저장된 원본 크롭이 없습니다. 사전 처리를 확인해 주세요.",
      );
    if (!paths.every(privatePath))
      throw new LearningError("저장된 원본 이미지 경로를 확인해 주세요.");
    return clone(question);
  });
  return {
    id: uuid(),
    version: 0,
    questionIds: ids,
    questionSnapshots: snapshots,
    answers: {},
    drawings: {},
    createdAt: now(),
    status: "active",
  };
}

/** Revealed only after the learner explicitly asks to check the original. */
export function originalReview(
  question: any,
  state: LearningState,
  relations: any[] = [],
): any {
  const ids = list(question.conceptIds);
  const relatedBank = state.bank.filter(
    (i) =>
      itemConcepts(i).some((id) => ids.includes(id)) ||
      relatedOriginalIds(i, [question]).length > 0,
  );
  const concepts = state.concepts
    .filter((c) =>
      unique([...ids, ...relatedBank.flatMap(itemConcepts)]).includes(c.id),
    )
    .map(clone);
  const bank = relatedBank.filter(approved);
  const bankCounts = {
    concept: 0,
    practice: 0,
    similar: 0,
    memory: 0,
    pending: relatedBank.filter(
      (i) =>
        (i.reviewStatus ?? i.review_status) === "needs_review" && !i.archived,
    ).length,
  };
  for (const item of bank) {
    const purposes = unique(
      [item.purpose, ...list(item.purposes)].filter(Boolean),
    );
    const quiz = list(item.modes).some((mode) =>
      ["quiz", "check"].includes(mode),
    );
    if (quiz && (purposes.includes("concept") || !purposes.length))
      bankCounts.concept++;
    if (quiz && purposes.includes("practice")) bankCounts.practice++;
    if (
      quiz &&
      purposes.includes("similar") &&
      relatedOriginalIds(item, [question]).length
    )
      bankCounts.similar++;
    if (list(item.modes).includes("memory")) bankCounts.memory++;
  }
  const match = (ref: any, q: any) =>
    ref &&
    String(Number(ref.q_number)) === String(q.number) &&
    ref.pdf_page === q.page &&
    (!ref.chapter_id || ref.chapter_id === q.chapterId);
  const wrong = new Set(state.mistakes.map((m) => m.questionId));
  const similar = state.questions
    .filter((q) => q.id !== question.id && !q.mergedInto && !q.autoRetired)
    .flatMap((q) => {
      const saved = relations.find(
        (r) =>
          r.document_id === question.materialId &&
          q.materialId === question.materialId &&
          ((match(r.a, question) && match(r.b, q)) ||
            (match(r.b, question) && match(r.a, q))),
      );
      const shared = ids.filter((id) => list(q.conceptIds).includes(id));
      if (!saved && (!wrong.has(q.id) || !shared.length)) return [];
      return [
        {
          id: q.id,
          number: q.number,
          page: q.page,
          materialId: q.materialId,
          score: saved
            ? Number(saved.score)
            : shared.length /
              Math.max(1, new Set([...ids, ...list(q.conceptIds)]).size),
          basis: saved ? "prepared_similarity" : "shared_concepts",
          reason: saved ? saved.reason : `공통 개념 ${shared.length}개`,
          canSolve:
            list(q.regions).length > 0 &&
            list(q.imagePaths).length === list(q.regions).length,
        },
      ];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const quick = question.wrongReview;
  const analysis = clone(question.analysis ?? (quick ? { provider: quick.provider, model: quick.model } : null));
  return {
    concepts: [...list(quick?.concepts).map((concept, index) => ({ ...concept, id: `review-concept-${index}` })), ...concepts],
    bankScope: { originalId: question.id },
    analysis,
    answer: quick?.solution?.answer || question.answer || analysis?.answer || "",
    explanation: quick?.solution?.explanation || question.explanation || analysis?.explanation || "",
    solutionSteps: list(analysis?.solution_steps),
    hasSavedAnalysis: !!(analysis || question.answer || question.explanation),
    memorize: unique([
      ...list(question.memorize),
      ...list(quick?.memorize),
      ...list(analysis?.memorize),
      ...concepts.flatMap((c) => list(c.memorize)),
    ]),
    bankCounts,
    questions: [...list(quick?.questions).map((item, index) => ({ ...clone(item), id: `review-question-${index}` })), ...relatedBank
      .filter((i) => !i.archived)
      .map((i) =>
        clone({
          id: i.id,
          prompt: i.prompt,
          type: i.type,
          choices: list(i.choices),
          answer: i.answer,
          explanation: i.explanation,
          reviewStatus: i.reviewStatus ?? i.review_status ?? "approved",
          active: approved(i),
        }),
      )],
    similar,
  };
}
export function answerSolve(
  input: any,
  body: SolveAnswer,
  state: Pick<LearningState, "mistakes">,
): { session: any; mistakes: any[] } {
  const session = clone(input),
    qid = body?.questionId;
  if (!list(session.questionIds).includes(qid))
    throw new LearningError("이 풀이의 문제가 아닙니다.");
  if (Object.hasOwn(session.answers, qid)) return { session, mistakes: [] };
  const strokes = body.strokes ?? session.drawings[qid] ?? [];
  if (
    !Array.isArray(strokes) ||
    strokes.length > 1000 ||
    JSON.stringify(strokes).length > 2000000
  )
    throw new LearningError("필기 데이터가 너무 큽니다.");
  if (body.drawingOnly) {
    session.drawings[qid] = clone(strokes);
    return { session, mistakes: [] };
  }
  if (!["correct", "wrong", "skip"].includes(body.result || ""))
    throw new LearningError("채점 결과를 확인해 주세요.");
  if (
    body.answerText !== undefined &&
    (typeof body.answerText !== "string" || body.answerText.length > 10000)
  )
    throw new LearningError("답변은 10000자 이하로 입력해 주세요.");
  const at = now(),
    result = body.result!;
  session.drawings[qid] = clone(strokes);
  session.answers[qid] = { result, at, answerText: body.answerText || "" };
  session.status = session.questionIds.every((id: string) =>
    Object.hasOwn(session.answers, id),
  )
    ? "complete"
    : "active";
  const mistakes =
    result === "skip"
      ? []
      : state.mistakes
          .filter((mistake) => mistake.questionId === qid)
          .map((mistake) => {
            const streak =
              Number.isInteger(mistake.streak) && mistake.streak >= 0
                ? mistake.streak
                : 0;
            const days =
              result === "wrong" ? 1 : [1, 3, 7, 14][Math.min(streak, 3)];
            return {
              ...clone(mistake),
              streak: result === "wrong" ? 0 : streak + 1,
              dueAt: new Date(Date.parse(at) + days * 86400000).toISOString(),
              lastResult: result,
              resolved: result === "correct",
              resolvedAt: result === "correct" ? at : null,
              archived: false,
              reviewCount: (mistake.reviewCount || 0) + 1,
              correctCount:
                (mistake.correctCount || 0) + Number(result === "correct"),
            };
          });
  return { session, mistakes };
}
