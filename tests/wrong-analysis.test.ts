import { afterEach, expect, test, vi } from "vitest";

const edgeCall = vi.hoisted(() => vi.fn());
vi.mock("../src/services/supabase", () => ({ edgeCall }));
import { prepareWrongAnalysis } from "../src/services/wrong-analysis";

afterEach(() => {
  edgeCall.mockReset();
  vi.useRealTimers();
});

test("cached results finish without polling or creating a content job", async () => {
  edgeCall.mockResolvedValue({ status: "completed", cached: true });
  await expect(prepareWrongAnalysis("q", () => false)).resolves.toBe(true);
  expect(edgeCall.mock.calls).toEqual([["analyze-problem", { action: "wrong_review", problemId: "q" }]]);
});

test("one original is submitted and the leased job is polled until completion", async () => {
  vi.useFakeTimers();
  edgeCall.mockResolvedValueOnce({ id: "running", status: "running" }).mockResolvedValueOnce({ status: "completed" });
  const work = prepareWrongAnalysis("q", () => false);
  await vi.runAllTimersAsync();
  await expect(work).resolves.toBe(true);
  expect(edgeCall.mock.calls).toEqual([
    ["analyze-problem", { action: "wrong_review", problemId: "q" }],
    ["analyze-problem", { action: "status", jobId: "running" }],
  ]);
});

test("a stopped view leaves a running server job to finish without further polling", async () => {
  edgeCall.mockResolvedValue({ id: "running", status: "running" });
  await expect(prepareWrongAnalysis("q", () => true)).resolves.toBe(false);
  expect(edgeCall).toHaveBeenCalledTimes(1);
});

test("a paused API failure is reported without pretending an analysis was saved", async () => {
  edgeCall.mockResolvedValue({ status: "paused", last_error: "invalid_response", available_at: new Date(Date.now() + 60_000).toISOString() });
  await expect(prepareWrongAnalysis("q", () => false)).rejects.toThrow("JSON 구조와 맞지 않아");
});
