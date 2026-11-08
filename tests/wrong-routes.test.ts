import { beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ state: {} as any, writes: [] as any[] }));
vi.mock("../supabase/functions/_shared/app/repository.ts", () => ({
  state: async () => fixture.state,
  rows: async () => [],
  row: async (_ctx: any, table: string, id: string, columns?: string) => {
    if (table === "solve_sessions")
      return {
        id,
        data: fixture.state.sessions.find((session: any) => session.id === id),
        ...(columns?.includes('questionSnapshots:') ? {questionSnapshots:fixture.state.sessions.find((session: any) => session.id === id)?.questionSnapshots}:{}),
      };
    return fixture.state.tables.wrong_answers.find((row: any) => row.id === id);
  },
  put: async (
    _ctx: any,
    table: string,
    id: string,
    data: any,
    columns: any,
  ) => {
    fixture.writes.push({ table, id, data, columns });
    return { id, data };
  },
  value: (row: any) => ({ ...row.data, id: row.id }),
  publicQuestion: ({ answer, explanation, ...safe }: any) => safe,
  material: (row: any) => row,
  signed: async () => "unused",
}));
import { handle } from "../supabase/functions/_shared/app/routes";
import { createSolve } from "../src/domain/learning";

beforeEach(() => {
  fixture.writes = [];
  fixture.state = {
    questions: [
      {
        id: "q",
        materialId: "doc",
        number: 47,
        page: 1,
        conceptIds: [],
        regions: [{ page: 1, x: 0, y: 0, w: 1, h: 1 }],
        imagePaths: ["owner/doc/q.png"],
        confirmed: true,
        hasContent: false,
      },
    ],
    concepts: [],
    bank: [],
    mistakes: [],
    sessions: [],
    tables: { wrong_answers: [] },
    pages: [{ materialId: "doc", number: 1, kind: "content" }],
  };
});

test('preloads answer keys only for the selected session snapshots without grading or writing', async () => {
  fixture.state.questions[0].answer = '저장된 정답';
  fixture.state.questions[0].explanation = '저장된 해설';
  const session = createSolve(fixture.state.questions);
  fixture.state.sessions = [session];
  fixture.state.questions.push({ ...fixture.state.questions[0], id: 'unselected', answer: '다른 문제 정답' });
  const result = await handle({ user: { id: 'owner' } } as any, { path: `solve/${session.id}/answer-keys`, method: 'GET' });
  expect(Object.keys(result.answerKeys)).toEqual(['q']);
  expect(result.answerKeys.q).toMatchObject({ available: true, answer: '저장된 정답', explanation: '저장된 해설', review: { hasSavedAnalysis: true } });
  expect(fixture.writes).toEqual([]);
  expect(session.answers).toEqual({});
});

test('preloading an original without a saved answer reports unavailable and invents no result', async () => {
  const session = createSolve(fixture.state.questions);
  fixture.state.sessions = [session];
  const result = await handle({ user: { id: 'owner' } } as any, { path: `solve/${session.id}/answer-keys`, method: 'GET' });
  expect(result.answerKeys.q).toMatchObject({ available: false, answer: '', explanation: '' });
  expect(fixture.writes).toEqual([]);
});

test("registration returns the saved original for immediate analysis and creates no graded or study record", async () => {
  const result = await handle({ user: { id: "owner" } } as any, {
    path: "mistakes",
    method: "POST",
    body: { questionIds: ["q"] },
  });
  expect(result).toMatchObject({
    added: 1,
    questionIds: ["q"],
    autoAnalyzeQuestionIds: ["q"],
    ambiguous: [],
    missing: [],
  });
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]).toMatchObject({
    table: "wrong_answers",
    columns: { problem_id: "q" },
    data: { resolved: false, reviewCount: 0, correctCount: 0 },
  });
  expect(result.reviewSessionId).toBeUndefined();
});

test("re-registering a solved original retains its ID and history and reuses saved analysis", async () => {
  fixture.state.questions[0].analysis = { key_point: "저장된 분석" };
  fixture.state.tables.wrong_answers = [
    {
      id: "existing",
      problem_id: "q",
      created_at: "2026-10-01",
      data: {
        resolved: true,
        archived: false,
        reviewCount: 4,
        correctCount: 2,
      },
    },
  ];
  const result = await handle({ user: { id: "owner" } } as any, {
    path: "mistakes",
    method: "POST",
    body: { questionIds: ["q"] },
  });
  expect(result.autoAnalyzeQuestionIds).toEqual([]);
  expect(fixture.writes[0]).toMatchObject({
    id: "existing",
    data: { resolved: false, reviewCount: 4, correctCount: 2 },
  });
});
test('a legacy correct record is also reopened without losing its original ID', async () => {
  fixture.state.tables.wrong_answers = [{ id: 'legacy', problem_id: 'q', data: { lastResult: 'correct', reviewCount: 2 } }];
  await handle({ user: { id: 'owner' } } as any, { path: 'mistakes', method: 'POST', body: { questionIds: ['q'] } });
  expect(fixture.writes[0]).toMatchObject({ id: 'legacy', data: { resolved: false, reviewCount: 2 } });
});

test("answer checking reads the saved session analysis without changing or grading the session", async () => {
  fixture.state.questions[0].analysis = {
    answer: "저장된 답",
    explanation: "저장된 해설",
    memorize: [],
    key_point: "핵심",
  };
  const session = createSolve(fixture.state.questions);
  fixture.state.sessions = [session];
  fixture.state.questions[0].analysis.answer = "변경된 답";
  const result = await handle({ user: { id: "owner" } } as any, {
    path: `solve/${session.id}/answer-key/q`,
  });
  expect(result).toMatchObject({
    available: true,
    answer: "저장된 답",
    explanation: "저장된 해설",
  });
  expect(fixture.writes).toEqual([]);
  expect(session.answers).toEqual({});
});
