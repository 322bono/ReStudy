import { expect, test, vi } from "vitest";
import { processJob } from "../supabase/functions/_shared/ai/jobs";

const review = (answer: string) => ({
  solution: { answer, explanation: `정답은 ${answer}입니다.` },
  concepts: [{ name: "생산자", summary: "유기물을 합성한다." }],
  memorize: ["생산자와 소비자를 구별한다."],
  questions: [
    { prompt: "생산자는?", answer: "식물", explanation: "광합성을 한다." },
  ],
});
const success = (answer: string, model: string) => ({
  status: "succeeded" as const,
  provider: "gemini" as const,
  model,
  output: review(answer),
  usage: {},
  duration_ms: 1,
});
const fixture = () => {
  let active: any = {
    id: "job",
    user_id: "owner",
    kind: "wrong_review",
    attempts: 0,
    status: "waiting",
    data: {
      input: {
        kind: "wrong_review",
        sourceIds: ["q"],
        prompt: "원본에서 풀기",
        images: [{ mimeType: "image/png", data: "AAAA" }],
      },
      settings: {},
    },
  };
  const store = {
    claim: async () => ({
      job: { ...active, status: "running", lease_token: "lease" },
      rotation_index: 0,
    }),
    finish: vi.fn(async (_id, _lease, status, data) => {
      active = { ...active, status, data };
      return { status, last_error: data.last_error };
    }),
    commit: vi.fn(async () => ({ status: "completed" })),
  };
  return { store, job: () => active };
};

test("one coherent generation stays private until a different model agrees from the original", async () => {
  const f = fixture(),
    run = vi.fn(async () => success("①", "model-a"));
  expect(
    await processJob(f.job(), f.store, {} as any, run as any),
  ).toMatchObject({ status: "waiting", last_error: "quality_check_pending" });
  expect(f.store.commit).not.toHaveBeenCalled();
  expect(f.job().data.qualityCandidates).toHaveLength(1);
  const check = vi.fn(async (_input, routing) => {
    expect(routing.excludedModels).toEqual(["model-a"]);
    return success("1번", "model-b");
  });
  expect(
    await processJob(f.job(), f.store, {} as any, check as any),
  ).toMatchObject({ status: "completed" });
  expect(f.store.commit.mock.calls[0][2].wrongReview).toMatchObject({
    solution: { answer: "1번" },
    quality: { version: 1, models: ["model-a", "model-b"] },
  });
});

test("disagreement triggers a third independent solve and three different answers are never committed", async () => {
  const f = fixture();
  for (const [answer, model] of [
    ["①", "a"],
    ["②", "b"],
    ["③", "c"],
  ]) {
    await processJob(
      f.job(),
      f.store,
      {} as any,
      (async () => success(answer, model)) as any,
    );
  }
  expect(f.store.commit).not.toHaveBeenCalled();
  expect(f.job()).toMatchObject({
    status: "paused",
    data: { last_provider_error: "answer_disagreement" },
  });
});

test("when a third independent model agrees, uses a coherent answer without changing any learning record", async () => {
  const f = fixture();
  for (const [answer, model] of [
    ["①", "a"],
    ["②", "b"],
    ["②", "c"],
  ]) {
    await processJob(
      f.job(),
      f.store,
      {} as any,
      (async () => success(answer, model)) as any,
    );
  }
  expect(f.store.commit).toHaveBeenCalledTimes(1);
  expect(f.store.commit.mock.calls[0][2].wrongReview.solution.answer).toBe("②");
});
