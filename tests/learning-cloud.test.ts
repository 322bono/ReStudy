import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answerSolve,
  answerStudy,
  createReview,
  createSolve,
  originalReview,
  preparedBankLinks,
  relatedOriginalIds,
  createStudy,
  createBankStudy,
  publicStudy,
  revealStudy,
  repeatWeak,
  type LearningState,
} from "../src/domain/learning";

// Pure in-memory authoring fixtures; no network and no user database writes.
function fixture(count = 1): LearningState {
  const concepts = Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    name: `개념 ${index}`,
    subject: "수학",
    definition: `정의 ${index}`,
    properties: ["정의역과 공역을 확인한다."],
    misconceptions: [
      {
        id: "missing-range",
        label: "공역과 치역을 혼동함",
        correction: "치역과 공역을 비교하세요.",
      },
    ],
    sources: [{ materialId: "doc", page: 1 }],
  }));
  const bank = concepts.flatMap((concept) =>
    [0, 1].map((n) => ({
      id: `${concept.id}-b${n}`,
      conceptId: concept.id,
      type: "객관식",
      prompt: `확인 ${n}`,
      choices: ["옳은 답", "다른 답"],
      answer: "옳은 답",
      acceptedAnswers: [],
      explanation: "저장된 해설",
      choiceFeedback: {
        "다른 답": {
          explanation: "공역과 치역의 일치도 필요합니다.",
          misconceptionTag: "missing-range",
        },
      },
      correction: "정의역과 공역의 조건을 확인하세요.",
      difficulty: "보통",
      sources: [{ materialId: "doc", page: 1 }],
      modes: ["quiz", "check"],
      active: true,
      review_status: "approved",
    })),
  );
  return {
    concepts,
    bank,
    results: [],
    mistakes: [
      {
        id: "mistake",
        questionId: "q",
        conceptState: "reviewing",
        streak: 0,
        reviewCount: 0,
        correctCount: 0,
      },
    ],
    questions: [
      {
        id: "q",
        materialId: "doc",
        number: 47,
        page: 1,
        text: "저장된 원본",
        confirmed: true,
        conceptIds: concepts.map((c) => c.id),
        regions: [{ page: 1, x: 0, y: 0, w: 1, h: 1 }],
        imagePaths: ["owner/doc/crops/q.png"],
        answer: "원본 정답",
        explanation: "원본 해설",
      },
    ],
    materials: [
      { id: "doc", title: "수학 자료", subject: "수학", pageCount: 2 },
    ],
    pages: [
      { materialId: "doc", number: 1, kind: "content" },
      { materialId: "doc", number: 2, kind: "answers" },
    ],
  };
}
const studyBody = (extra: any = {}) => ({
  materials: [{ id: "doc", pages: "1" }],
  mode: "quiz",
  type: "객관식",
  count: 5,
  difficulty: "보통",
  ...extra,
});
afterEach(() => vi.useRealTimers());

describe("shared question bank", () => {
  it("uses one saved multi-concept item once and updates original understanding separately", () => {
    const state = fixture(2);
    state.bank = [
      {
        ...state.bank[0],
        conceptIds: ["c0", "c1"],
        kind: "mcq",
        purpose: "concept",
        chapterId: "ch1",
      },
    ];
    const session = createReview(["q"], state);
    expect(session.items).toHaveLength(1);
    expect(session.conceptIds).toEqual(["c0", "c1"]);
    const result = answerStudy(
      session,
      { itemId: session.items[0].id, response: "옳은 답" },
      state,
    );
    expect(result.session.understoodConceptIds).toEqual(["c0", "c1"]);
    expect(result.mistakes[0].conceptState).toBe("understood");
    expect(result.mistakes[0].reviewCount).toBe(0);
  });
  it("builds a bank set from stored kind/purpose/concepts without generating missing items", () => {
    const state = fixture(2);
    state.bank[0] = {
      ...state.bank[0],
      kind: "mcq",
      purpose: "concept",
      chapterId: "ch1",
      conceptIds: ["c0", "c1"],
    };
    const session = createBankStudy(
      {
        conceptIds: ["c1"],
        purposes: ["concept"],
        kinds: ["mcq"],
        count: 20,
        order: "unattempted",
        mode: "check",
      },
      state,
    );
    expect(session.items).toHaveLength(1);
    expect(session.notice).toContain("1");
    expect(session.items[0].bankItemId).toBe(state.bank[0].id);
    expect(publicStudy(session).items[0].answer).toBeUndefined();
  });
  it("offers human review for a different short-answer phrasing before recording a wrong answer", () => {
    const state = fixture();
    state.bank[0] = {
      ...state.bank[0],
      type: "단답형",
      choices: [],
      answer: "치역과 공역이 같다",
      acceptedAnswers: ["치역=공역"],
    };
    const session = createBankStudy(
      { count: 1, order: "sequential", mode: "quiz" },
      { ...state, bank: [state.bank[0]] },
    );
    const pending = answerStudy(
      session,
      { itemId: session.items[0].id, response: "공역이 치역과 일치한다" },
      state,
    );
    expect(pending.attempt).toBeUndefined();
    expect(pending.session.items[0].waitingSelfGrade).toBe(true);
    expect(publicStudy(pending.session).items[0].answer).toBe(
      "치역과 공역이 같다",
    );
    const graded = answerStudy(
      pending.session,
      { itemId: session.items[0].id, selfGrade: "correct" },
      state,
    );
    expect(graded.attempt.result).toBe("correct");
  });
});

describe("prepared concept review", () => {
  it("rejects unmapped and unregistered concepts instead of inferring content", () => {
    const state = fixture();
    state.questions[0].conceptIds = [];
    expect(() => createReview(["q"], state)).toThrow("개념 미등록");
    state.questions[0].conceptIds = ["missing"];
    expect(() => createReview(["q"], state)).toThrow("개념");
    expect(() => createReview(["not-owned"], state)).toThrow("문제");
  });
  it("uses only active approved bank content and fails clearly when review is missing", () => {
    const state = fixture();
    state.bank[0].review_status = "needs_review";
    state.bank[1].active = false;
    expect(() => createReview(["q"], state)).toThrow("복습 문항 미등록");
  });
  it("starts with at most five items and covers every concept in later batches", () => {
    const state = fixture(8);
    let session = createReview(["q", "q"], state);
    expect(session.items).toHaveLength(5);
    expect(session.originQuestionIds).toEqual(["q"]);
    expect(session.remainingConceptIds).toHaveLength(3);
    for (let n = 0; n < 30 && session.status !== "complete"; n++) {
      const item = session.items.find((entry: any) => !entry.result);
      const update = answerStudy(
        session,
        { itemId: item.id, response: item.answer },
        state,
      );
      session = update.session;
      if (update.attempt) state.results.push(update.attempt);
    }
    expect(session.status).toBe("complete");
    expect(session.mastered).toBe(true);
    expect(new Set(session.items.map((i: any) => i.conceptId)).size).toBe(8);
    expect(session.understoodConceptIds).toHaveLength(8);
  });
  it("uses stored choice feedback and a human misconception label, then checks a different item", () => {
    const state = fixture();
    const session = createReview(["q"], state);
    const first = session.items[0];
    const before = structuredClone(state);
    const update = answerStudy(
      session,
      { itemId: first.id, response: "다른 답" },
      state,
    );
    expect(update.session.items[0]).toMatchObject({
      result: "wrong",
      feedback: "공역과 치역의 일치도 필요합니다.",
      misconceptionTag: "missing-range",
      misconceptionLabel: "공역과 치역을 혼동함",
    });
    expect(
      update.session.items.some(
        (i: any) => !i.result && i.bankItemId !== first.bankItemId,
      ),
    ).toBe(true);
    expect(update.attempt).toMatchObject({
      sessionId: session.id,
      itemId: first.id,
      bankItemId: first.bankItemId,
      result: "wrong",
    });
    expect(state).toEqual(before);
    expect(session.items[0].result).toBeUndefined();
  });
  it("limits additional rechecks to three and leaves failed understanding unverified", () => {
    const state = fixture();
    let session = createReview(["q"], state);
    let changed: any[] = [];
    for (let n = 0; n < 15 && session.status !== "complete"; n++) {
      const item = session.items.find((i: any) => !i.result);
      const update = answerStudy(
        session,
        { itemId: item.id, response: "다른 답" },
        state,
      );
      session = update.session;
      changed = update.mistakes;
    }
    expect(session.status).toBe("complete");
    expect(session.items).toHaveLength(5);
    expect(session.rechecks.c0).toBe(3);
    expect(session.mastered).toBe(false);
    expect(session.understoodConceptIds).toEqual([]);
    expect(session.notice).toContain("이해가 확인되지 않은");
    expect(changed[0].conceptState).toBe("reviewing");
    for (let n = 2; n < session.items.length; n++)
      expect(session.items[n].bankItemId).not.toBe(
        session.items[n - 1].bankItemId,
      );
  });
  it("does not repeat the identical bank item when a different recheck is unavailable", () => {
    const state = fixture();
    state.bank = state.bank.slice(0, 1);
    const session = createReview(["q"], state);
    const update = answerStudy(
      session,
      { itemId: session.items[0].id, response: "다른 답" },
      state,
    );
    expect(update.session.items).toHaveLength(1);
    expect(update.session.mastered).toBe(false);
  });
  it("freezes bank answers, source references and original snapshots during active sessions", () => {
    const state = fixture();
    const session = createReview(["q"], state);
    state.bank[0].answer = "수정된 답";
    state.bank[0].sources[0].page = 2;
    state.concepts[0].definition = "수정된 정의";
    state.questions[0].imagePaths[0] = "owner/replaced.png";
    expect(session.items[0].answer).toBe("옳은 답");
    expect(session.items[0].sources[0].page).toBe(1);
    expect(session.items[0].conceptDefinition).toBe("정의 0");
    expect(session.questionSnapshots[0].imagePaths).toEqual([
      "owner/doc/crops/q.png",
    ]);
  });
});

describe("material selection and honest grading", () => {
  it("starts with only unattempted questions and stops when the scope is exhausted", () => {
    const state = fixture();
    state.results = [
      {
        bankItemId: "c0-b0",
        conceptId: "c0",
        result: "correct",
        createdAt: "2026-10-30T00:00:00Z",
      },
    ];
    expect(
      createStudy(studyBody({ count: 5 }), state).items.map((item: any) => item.bankItemId),
    ).toEqual(["c0-b1"]);
    expect(createBankStudy({ count: 5, order: "unattempted" }, state).items.map((item: any) => item.bankItemId)).toEqual(["c0-b1"]);
    state.results.push({
      bankItemId: "c0-b1",
      conceptId: "c0",
      result: "wrong",
      createdAt: "2026-10-29T00:00:00Z",
    });
    expect(() => createStudy(studyBody({ count: 1 }), state)).toThrow("모두 풀었습니다");
    expect(() => createBankStudy({ count: 5, order: "unattempted" }, state)).toThrow("모두 풀었습니다");
    expect(createBankStudy({ count: 1, order: "sequential" }, state).items).toHaveLength(1);
  });
  it("prioritizes weak concepts and includes saved items with a selected source even when other origins exist", () => {
    const state = fixture(2);
    state.results = [
      {
        bankItemId: "c1-b0",
        conceptId: "c1",
        result: "wrong",
        createdAt: "2026-10-30T00:00:00Z",
      },
    ];
    expect(createStudy(studyBody({ count: 1 }), state).items[0].conceptId).toBe(
      "c1",
    );
    for (const item of state.bank)
      item.sources.push({ materialId: "other-doc", page: 1 });
    expect(createStudy(studyBody(), state).items).toHaveLength(3);
    for (const item of state.bank)
      item.sources = [{ materialId: "other-doc", page: 1 }];
    expect(() => createStudy(studyBody(), state)).toThrow("사전 문항");
  });
  it("supports all types and levels and valid PDF sources before page processing while excluding known answer pages", () => {
    const state = fixture();
    state.pages = [];
    state.bank[0].type = "OX";
    state.bank[0].difficulty = "기본";
    expect(
      createStudy(studyBody({ type: "전체", difficulty: "전체" }), state).items,
    ).toHaveLength(2);
    state.pages = [{ materialId: "doc", number: 1, kind: "answers" }];
    expect(() =>
      createStudy(
        studyBody({
          type: "전체",
          difficulty: "전체",
          materials: [{ id: "doc" }],
        }),
        state,
      ),
    ).toThrow("사전 문항");
    expect(() =>
      createStudy(studyBody({ materials: [{ id: "doc", pages: "3" }] }), {
        ...state,
        pages: [],
      }),
    ).toThrow("페이지");
  });
  it("rejects answer pages, archived or mixed-subject documents and invalid ranges", () => {
    const state = fixture();
    expect(() =>
      createStudy(studyBody({ materials: [{ id: "doc", pages: "2" }] }), state),
    ).toThrow("페이지");
    expect(() =>
      createStudy(
        studyBody({ materials: [{ id: "doc", pages: "4-2" }] }),
        state,
      ),
    ).toThrow("번호");
    state.materials![0].archived = true;
    expect(() => createStudy(studyBody(), state)).toThrow("보관");
    state.materials![0].archived = false;
    state.materials!.push({ id: "science", subject: "과학" });
    expect(() =>
      createStudy(
        studyBody({ materials: [{ id: "doc" }, { id: "science" }] }),
        state,
      ),
    ).toThrow("한 과목");
    expect(() => createStudy(studyBody({ count: 21 }), state)).toThrow("1~20");
  });
  it("matches NFKC and whitespace while preserving case and mathematical signs", () => {
    const state = fixture();
    state.bank[0] = {
      ...state.bank[0],
      type: "단답형",
      choices: [],
      answer: "A+2",
      acceptedAnswers: ["2+A"],
    };
    state.bank = state.bank.slice(0, 1);
    let session = createReview(["q"], state);
    expect(
      answerStudy(
        session,
        { itemId: session.items[0].id, response: "Ａ + ２" },
        state,
      ).session.items[0].result,
    ).toBe("correct");
    session = createReview(["q"], state);
    expect(
      answerStudy(
        session,
        { itemId: session.items[0].id, response: "a+2" },
        state,
      ).session.items[0].waitingSelfGrade,
    ).toBe(true);
    session = createReview(["q"], state);
    expect(
      answerStudy(
        session,
        { itemId: session.items[0].id, response: "A-2" },
        state,
      ).session.items[0].waitingSelfGrade,
    ).toBe(true);
  });
  it("requires free-response submission before revealing and self-grading, and ignores duplicate final answers", () => {
    const state = fixture();
    state.bank = [{ ...state.bank[0], type: "서술형", choices: [] }];
    let session = createReview(["q"], state);
    const id = session.items[0].id;
    expect(() => revealStudy(session, id)).toThrow("제출");
    expect(() =>
      answerStudy(session, { itemId: id, selfGrade: "correct" }, state),
    ).toThrow("제출");
    session = answerStudy(
      session,
      { itemId: id, response: "내 설명" },
      state,
    ).session;
    expect(session.items[0]).toMatchObject({
      responseSubmitted: true,
      waitingSelfGrade: true,
    });
    expect(session.items[0].result).toBeUndefined();
    expect(revealStudy(session, id).answer).toBe("옳은 답");
    expect(publicStudy(session).items[0].answer).toBe("옳은 답");
    const update = answerStudy(
      session,
      { itemId: id, selfGrade: "correct" },
      state,
    );
    const duplicate = answerStudy(
      update.session,
      { itemId: id, response: "다른 설명", selfGrade: "wrong" },
      state,
    );
    expect(duplicate.session.items[0]).toMatchObject({
      result: "correct",
      response: "내 설명",
    });
    expect(duplicate.attempt).toBeUndefined();
    expect(duplicate.mistakes).toEqual([]);
  });
  it("hides solutions before answering and prevents choice items from using reveal", () => {
    const state = fixture();
    const session = createReview(["q"], state);
    const item = publicStudy(session).items[0];
    for (const field of [
      "answer",
      "acceptedAnswers",
      "explanation",
      "choiceFeedback",
      "correction",
    ])
      expect(item).not.toHaveProperty(field);
    expect(publicStudy(session)).not.toHaveProperty("questionSnapshots");
    expect(() => revealStudy(session, session.items[0].id)).toThrow("암기");
    expect(() =>
      answerStudy(
        session,
        { itemId: session.items[0].id, response: "임의 선택" },
        state,
      ),
    ).toThrow("선택지");
  });
  it("records memory honestly without declaring objective understanding", () => {
    const state = fixture();
    state.bank = [{ ...state.bank[0], type: "플래시카드", modes: ["memory"] }];
    const session = createStudy(studyBody({ mode: "memory", count: 1 }), state);
    expect(revealStudy(session, session.items[0].id).answer).toBe("옳은 답");
    const update = answerStudy(
      session,
      { itemId: session.items[0].id, memory: "known" },
      state,
    );
    expect(update.attempt).toMatchObject({ result: "known", memory: "known" });
    expect(update.session.understoodConceptIds).toEqual([]);
    expect(update.session.mastered).not.toBe(true);
    expect(update.session.status).toBe("complete");
  });
  it("loads every memory card answer and explanation from the saved session before flipping", () => {
    const state = fixture();
    state.bank = state.bank.map((item, index) => ({
      ...item,
      type: index ? "문장 가리기" : "플래시카드",
      modes: ["memory"],
      answer: `저장된 답 ${index}`,
      explanation: `저장된 해설 ${index}`,
    }));
    const session = createStudy(studyBody({ mode: "memory", count: 2 }), state);
    state.bank[0].answer = "나중에 수정한 답";
    state.bank[1].explanation = "나중에 수정한 해설";

    const loaded = publicStudy(session);
    expect(loaded.items).toMatchObject([
      { id: session.items[0].id, bankItemId: "c0-b0", answer: "저장된 답 0", explanation: "저장된 해설 0" },
      { id: session.items[1].id, bankItemId: "c0-b1", answer: "저장된 답 1", explanation: "저장된 해설 1" },
    ]);
    expect(loaded.items.every((item: any) => !item.revealedAt && !item.memory)).toBe(true);
    expect(session.items.every((item: any) => !item.revealedAt && !item.memory)).toBe(true);
    expect(loaded).not.toHaveProperty("reviewPool");
    expect(loaded).not.toHaveProperty("questionSnapshots");
  });
  it.each(["quiz", "check"])("keeps unsubmitted %s answers private and grades the saved snapshot", (mode) => {
    const state = fixture();
    const session = createStudy(studyBody({ mode, count: 1 }), state);
    state.bank[0].answer = "다른 답";
    const loaded = publicStudy(session);
    expect(loaded.items[0]).not.toHaveProperty("answer");
    expect(loaded.items[0]).not.toHaveProperty("explanation");
    const update = answerStudy(session, { itemId: session.items[0].id, response: "옳은 답" }, state);
    expect(update.session.items[0].result).toBe("correct");
    expect(update.attempt.itemId).toBe(session.items[0].id);
  });
  it("repeats only the latest weak result per currently approved bank item", () => {
    const state = fixture();
    state.results = [
      {
        bankItemId: "c0-b0",
        conceptId: "c0",
        result: "wrong",
        createdAt: "2026-10-28T00:00:00Z",
      },
      {
        bankItemId: "c0-b0",
        conceptId: "c0",
        result: "correct",
        createdAt: "2026-10-30T00:00:00Z",
      },
      {
        bankItemId: "c0-b1",
        conceptId: "c0",
        result: "wrong",
        createdAt: "2026-10-29T00:00:00Z",
      },
    ];
    const session = repeatWeak(state);
    expect(session.items.map((item: any) => item.bankItemId)).toEqual([
      "c0-b1",
    ]);
    expect(session.mode).toBe("check");
    state.bank[1].review_status = "needs_review";
    expect(() => repeatWeak(state)).toThrow("다시 볼");
  });
  it("repeats uncertain memory cards without converting them into objective quiz results", () => {
    const state = fixture();
    state.bank = [{ ...state.bank[0], modes: ["memory"], type: "플래시카드" }];
    state.results = [
      {
        bankItemId: "c0-b0",
        conceptId: "c0",
        result: "unsure",
        memory: "unsure",
        createdAt: "2026-10-30T00:00:00Z",
      },
    ];
    const session = repeatWeak(state);
    expect(session.mode).toBe("memory");
    expect(session.items[0].bankItemId).toBe("c0-b0");
    expect(session.understoodConceptIds).toEqual([]);
  });
});

describe("saved clean original solving", () => {
  it("keeps wrong originals pending, archives correct originals without deleting analysis, and reopens on a later wrong attempt", () => {
    const state = fixture();
    state.questions[0].analysis = {
      answer: "저장된 정답",
      explanation: "저장된 단계별 해설",
      key_point: "핵심",
      solution_steps: ["조건 확인", "계산"],
      memorize: ["필수 공식"],
      mistakes: [],
    };
    const before = structuredClone(state);
    const correct = answerSolve(
      createSolve(state.questions),
      { questionId: "q", result: "correct" },
      state,
    );
    expect(correct.mistakes[0]).toMatchObject({
      id: "mistake",
      resolved: true,
      archived: false,
      lastResult: "correct",
      reviewCount: 1,
      correctCount: 1,
    });
    expect(correct.mistakes[0].resolvedAt).toBeTruthy();
    expect(correct.session.questionSnapshots[0].analysis).toEqual(
      before.questions[0].analysis,
    );
    state.mistakes = correct.mistakes;
    const wrong = answerSolve(
      createSolve(state.questions),
      { questionId: "q", result: "wrong" },
      state,
    );
    expect(wrong.mistakes[0]).toMatchObject({
      resolved: false,
      resolvedAt: null,
      reviewCount: 2,
      correctCount: 1,
    });
    expect(state.questions[0].analysis).toEqual(before.questions[0].analysis);
    expect(correct.session.answers.q.result).toBe("correct");
    expect(wrong.session.answers.q.result).toBe("wrong");
  });
  it("reuses saved original explanation with four-group data and keeps unreviewed check questions out of learning", () => {
    const state = fixture();
    delete state.questions[0].answer;
    delete state.questions[0].explanation;
    state.questions[0].analysis = {
      answer: "분석 정답",
      explanation: "분석 해설",
      solution_steps: ["저장된 단계"],
      memorize: ["암기"],
      key_point: "핵심",
    };
    state.bank = state.bank.map((item) => ({
      ...item,
      review_status: "needs_review",
      active: false,
    }));
    const session = createSolve(state.questions);
    state.questions[0].analysis.explanation = "나중에 수정됨";
    const review = originalReview(session.questionSnapshots[0], state);
    expect(review).toMatchObject({
      answer: "분석 정답",
      explanation: "분석 해설",
      solutionSteps: ["저장된 단계"],
      hasSavedAnalysis: true,
      memorize: ["암기"],
      bankCounts: { concept: 0, pending: 2 },
    });
    expect(review.concepts).toHaveLength(1);
    expect(review.questions).toHaveLength(2);
    expect(
      review.questions.every(
        (item: any) =>
          item.active === false && item.reviewStatus === "needs_review",
      ),
    ).toBe(true);
    expect(() => createBankStudy({ originalId: "q", count: 5 }, state)).toThrow(
      "저장 문항",
    );
    expect(session.answers).toEqual({});
  });
  it("links every part of a single-original preparation without modifying stored concept mappings", () => {
    const state = fixture(),
      q = state.questions[0];
    const links = preparedBankLinks(
      [
        {
          id: "j",
          task_type: "problem",
          document_id: "doc",
          first_target: "q",
          second_target: null,
        },
        {
          id: "multi",
          task_type: "problem",
          document_id: "doc",
          first_target: "q",
          second_target: "q2",
        },
        {
          id: "foreign",
          task_type: "problem",
          document_id: "another-doc",
          first_target: "q",
        },
      ],
      [
        { job_id: "j", kind: "question", actual_id: "prepared" },
        { job_id: "multi", kind: "question", actual_id: "ambiguous" },
        { job_id: "foreign", kind: "question", actual_id: "not-owned-source" },
      ],
      state.questions,
    );
    expect([...links]).toEqual([["prepared", ["q"]]]);
    state.concepts.push({
      ...structuredClone(state.concepts[0]),
      id: "new-concept",
      name: "후속 분할 개념",
    });
    state.bank.push({
      ...structuredClone(state.bank[0]),
      id: "prepared",
      conceptId: "new-concept",
      purpose: "practice",
      preparedQuestionIds: links.get("prepared"),
    });
    expect(relatedOriginalIds(state.bank.at(-1), state.questions)).toEqual([
      "q",
    ]);
    const review = originalReview(q, state);
    expect(review.bankCounts.practice).toBe(1);
    expect(review.concepts.map((c) => c.id)).toContain("new-concept");
    const session = createBankStudy(
      { ...review.bankScope, purposes: ["practice"], count: 1 },
      state,
    );
    expect(session.items[0].bankItemId).toBe("prepared");
    expect(session.linkedQuestionIds).toEqual(["q"]);
    expect(q.conceptIds).toEqual(["c0"]);
    expect(() =>
      createBankStudy({ originalId: "missing", count: 1 }, state),
    ).toThrow("원본");
  });
  it("opens saved private crops including unconfirmed OCR candidates and freezes clean source/answer data", () => {
    const state = fixture();
    const session = createSolve(state.questions);
    state.questions[0].answer = "수정";
    state.questions[0].imagePaths[0] = "owner/new.png";
    expect(session.questionSnapshots[0]).toMatchObject({
      answer: "원본 정답",
      explanation: "원본 해설",
      imagePaths: ["owner/doc/crops/q.png"],
    });
    expect(session).toMatchObject({
      answers: {},
      drawings: {},
      status: "active",
      version: 0,
    });
    expect(
      createSolve([{ ...state.questions[0], confirmed: false }])
        .questionSnapshots[0].confirmed,
    ).toBe(false);
    expect(() =>
      createSolve([{ ...state.questions[0], imagePaths: [] }]),
    ).toThrow("저장");
    expect(() =>
      createSolve([
        {
          ...state.questions[0],
          imagePaths: ["https://example.com/private.png"],
        },
      ]),
    ).toThrow("경로");
  });
  it("reveals prepared concepts and distinguishes stored similarity from shared-concept overlap", () => {
    const state = fixture();
    state.concepts[0].memorize = ["공역 확인"];
    state.questions.push({
      ...structuredClone(state.questions[0]),
      id: "other",
      number: 48,
      page: 2,
      chapterId: "chapter",
    });
    state.mistakes.push({ id: "m2", questionId: "other" });
    const review = originalReview(state.questions[0], state);
    expect(review.memorize).toEqual(["공역 확인"]);
    expect(review.bankCounts.concept).toBe(2);
    expect(review.similar[0]).toMatchObject({
      id: "other",
      basis: "shared_concepts",
      score: 1,
    });
    state.bank.push({
      ...structuredClone(state.bank[0]),
      id: "pending",
      active: false,
      review_status: "needs_review",
    });
    expect(originalReview(state.questions[0], state).bankCounts).toMatchObject({
      concept: 2,
      pending: 1,
    });
    const saved = originalReview(state.questions[0], state, [
      {
        document_id: "doc",
        a: { q_number: "47", pdf_page: 1 },
        b: { q_number: "48", pdf_page: 2 },
        score: 0.8,
        reason: "조건 비교",
      },
    ]);
    expect(saved.similar[0]).toMatchObject({
      basis: "prepared_similarity",
      score: 0.8,
      reason: "조건 비교",
    });
    expect(
      originalReview({ ...state.questions[0], conceptIds: [] }, state).concepts,
    ).toEqual([]);
  });
  it("keeps final drawings and answers when duplicate answers or late drawings arrive", () => {
    const state = fixture();
    const session = createSolve(state.questions);
    session.version = 7;
    const strokes = [
      {
        color: "#3730a3",
        width: 0.0025,
        region: 0,
        points: [{ x: 0.1, y: 0.2 }],
      },
    ];
    const result = answerSolve(
      session,
      { questionId: "q", result: "correct", strokes, answerText: "내 답" },
      state,
    );
    expect(result.session.version).toBe(7);
    expect(result.session.status).toBe("complete");
    expect(
      answerSolve(
        result.session,
        { questionId: "q", drawingOnly: true, strokes: [] },
        state,
      ).session.drawings.q,
    ).toEqual(strokes);
    const duplicate = answerSolve(
      result.session,
      { questionId: "q", result: "wrong", strokes: [] },
      state,
    );
    expect(duplicate.session.answers.q).toMatchObject({
      result: "correct",
      answerText: "내 답",
    });
    expect(duplicate.mistakes).toEqual([]);
    expect(session.answers).toEqual({});
  });
  it("updates only matching mistakes using 1/3/7/14 days and resets a wrong streak", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const state = fixture();
    state.mistakes.push({ id: "other", questionId: "unrelated", streak: 9 });
    for (const [streak, days] of [
      [0, 1],
      [1, 3],
      [2, 7],
      [3, 14],
      [9, 14],
    ]) {
      state.mistakes[0].streak = streak;
      const update = answerSolve(
        createSolve(state.questions),
        { questionId: "q", result: "correct" },
        state,
      );
      expect(update.mistakes).toHaveLength(1);
      expect(update.mistakes[0].streak).toBe(streak + 1);
      expect(update.mistakes[0].dueAt).toBe(
        new Date(Date.now() + days * 86400000).toISOString(),
      );
    }
    const wrong = answerSolve(
      createSolve(state.questions),
      { questionId: "q", result: "wrong" },
      state,
    ).mistakes[0];
    expect(wrong.streak).toBe(0);
    expect(wrong.dueAt).toBe("2026-11-02T00:00:00.000Z");
    expect(
      answerSolve(
        createSolve(state.questions),
        { questionId: "q", result: "skip" },
        state,
      ).mistakes,
    ).toEqual([]);
  });
  it("does not schedule drawings and rejects unrelated questions or oversized ink", () => {
    const state = fixture();
    const session = createSolve(state.questions);
    expect(
      answerSolve(
        session,
        { questionId: "q", drawingOnly: true, strokes: [] },
        state,
      ),
    ).toMatchObject({
      mistakes: [],
      session: { status: "active", answers: {} },
    });
    expect(() =>
      answerSolve(session, { questionId: "other", result: "correct" }, state),
    ).toThrow("이 풀이");
    expect(() =>
      answerSolve(
        session,
        {
          questionId: "q",
          drawingOnly: true,
          strokes: Array.from({ length: 1001 }, () => ({})),
        },
        state,
      ),
    ).toThrow("필기");
  });
});
