import { beforeEach, expect, test, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  reviews: [] as any[],
  calls: [] as any[],
  existing: [] as any[],
  run: vi.fn(),
}));
vi.mock("../lib/client", () => ({ api: async () => fixture.reviews.shift() }));
vi.mock("../src/services/supabase", () => ({
  edgeCall: async (name: string, body: any) => {
    fixture.calls.push({ name, ...body });
    if (body.action === "list") return { jobs: fixture.existing };
    if (body.action === "get") return fixture.existing[0];
    return { ...body, id: "created", totalParts: 1, parts: [] };
  },
}));
vi.mock("../src/services/content-runner", () => ({
  runPreparedJob: fixture.run,
}));
import { prepareWrongAnalysis } from "../src/services/wrong-analysis";
const question: any = {
  id: "q",
  materialId: "doc",
  number: 47,
  regions: [{ page: 2 }],
  imagePaths: ["owner/doc/saved-q.png"],
};
const material: any = { id: "doc", tocPages: [1] };
const options = () => ({ onUpdate: vi.fn(), shouldStop: () => false });
beforeEach(() => {
  fixture.reviews = [];
  fixture.calls = [];
  fixture.existing = [];
  fixture.run.mockReset().mockImplementation(async (job) => job);
});

test("opening a saved analysis reuses it without any generation job or upstream request", async () => {
  fixture.reviews = [
    { hasSavedAnalysis: true, analysis: { explanation: "저장된 해설" } },
  ];
  expect(
    await prepareWrongAnalysis(question, material, options()),
  ).toMatchObject({ reused: true });
  expect(fixture.calls).toEqual([]);
  expect(fixture.run).not.toHaveBeenCalled();
});
test("first registration creates one single-original job using stored crop pages and saves four-group content", async () => {
  fixture.reviews = [
    { hasSavedAnalysis: false },
    { hasSavedAnalysis: true, concepts: [], memorize: [], questions: [] },
  ];
  await prepareWrongAnalysis(question, material, options());
  expect(fixture.calls.find((call) => call.action === "create")).toMatchObject({
    taskType: "problem",
    questionIds: ["q"],
    selectedPages: [2],
    questionCount: 5,
  });
  expect(fixture.run).toHaveBeenCalledTimes(1);
});
test("a previously started original job resumes without creating duplicate content jobs", async () => {
  fixture.reviews = [{ hasSavedAnalysis: false }, { hasSavedAnalysis: true }];
  fixture.existing = [
    {
      id: "existing",
      method: "api",
      taskType: "problem",
      totalParts: 1,
      targetQuestions: [{ id: "q" }],
    },
  ];
  await prepareWrongAnalysis(question, material, options());
  expect(fixture.calls.some((call) => call.action === "create")).toBe(false);
  expect(fixture.run.mock.calls[0][0].id).toBe("existing");
});
test("a paused API failure is reported instead of presenting an empty analysis as success", async () => {
  fixture.reviews = [{ hasSavedAnalysis: false }, { hasSavedAnalysis: false }];
  await expect(
    prepareWrongAnalysis(question, material, options()),
  ).rejects.toThrow("분석을 완료하지 못했습니다");
});
