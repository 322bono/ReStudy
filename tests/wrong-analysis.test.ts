import { afterEach, expect, test, vi } from "vitest";

const edgeCall = vi.hoisted(() => vi.fn());
vi.mock("../src/services/supabase", () => ({ edgeCall }));
import { createWrongAnalysisQueue, prepareWrongAnalysis } from "../src/services/wrong-analysis";

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

test("a failed original does not prevent later unique originals from being analyzed", async () => {
  vi.useFakeTimers();
  edgeCall
    .mockResolvedValueOnce({ id: "job-1", status: "running" })
    .mockResolvedValueOnce({ id: "job-1", status: "paused", last_error: "source_incomplete" })
    .mockResolvedValueOnce({ status: "completed", cached: true })
    .mockResolvedValueOnce({ id: "job-3", status: "completed" });
  const progress = vi.fn();
  const queue = createWrongAnalysisQueue(progress);
  queue.enqueue(["q1", "q2", "q1"]);
  queue.enqueue(["q2", "q3"]);
  expect(edgeCall.mock.calls).toEqual([["analyze-problem", { action: "wrong_review", problemId: "q1" }]]);

  await vi.runAllTimersAsync();

  expect(edgeCall.mock.calls.map(([, request]) => request)).toEqual([
    { action: "wrong_review", problemId: "q1" },
    { action: "status", jobId: "job-1" },
    { action: "wrong_review", problemId: "q2" },
    { action: "wrong_review", problemId: "q3" },
  ]);
  expect(progress.mock.lastCall?.[0]).toMatchObject({
    currentId: null,
    pendingIds: [],
    results: [
      { id: "q1", status: "failed", message: expect.stringContaining("필요한 조건") },
      { id: "q2", status: "completed" },
      { id: "q3", status: "completed" },
    ],
  });
});

test("stopping a batch finishes its current original and never submits the pending originals", async () => {
  vi.useFakeTimers();
  edgeCall
    .mockResolvedValueOnce({ id: "job-1", status: "running" })
    .mockResolvedValueOnce({ id: "job-1", status: "completed" });
  const progress = vi.fn();
  const queue = createWrongAnalysisQueue(progress);
  queue.enqueue(["q1", "q2", "q3"]);
  queue.stop();

  await vi.runAllTimersAsync();

  expect(edgeCall.mock.calls.map(([, request]) => request)).toEqual([
    { action: "wrong_review", problemId: "q1" },
    { action: "status", jobId: "job-1" },
  ]);
  expect(progress.mock.lastCall?.[0]).toMatchObject({
    currentId: null,
    pendingIds: [],
    results: [{ id: "q1", status: "completed" }],
    stopped: 2,
  });
});

test("archiving queued originals removes them without interrupting other originals", async () => {
  vi.useFakeTimers();
  edgeCall
    .mockResolvedValueOnce({ id: "job-1", status: "running" })
    .mockResolvedValueOnce({ id: "job-1", status: "completed" })
    .mockResolvedValueOnce({ id: "job-3", status: "completed" });
  const queue = createWrongAnalysisQueue(vi.fn());
  queue.enqueue(["q1", "q2", "q3"]);
  queue.remove(["q2"]);

  await vi.runAllTimersAsync();

  expect(edgeCall.mock.calls.map(([, request]) => request)).toEqual([
    { action: "wrong_review", problemId: "q1" },
    { action: "status", jobId: "job-1" },
    { action: "wrong_review", problemId: "q3" },
  ]);
});

test("stopping a batch prevents another analysis request for the current original after a retryable failure", async () => {
  vi.useFakeTimers();
  edgeCall
    .mockResolvedValueOnce({ id: "job-1", status: "running" })
    .mockImplementationOnce(async () => ({
      id: "job-1",
      status: "paused",
      last_error: "network_error",
      available_at: new Date(Date.now()).toISOString(),
    }))
    .mockResolvedValueOnce({ id: "job-1", status: "completed" });
  const progress = vi.fn();
  const queue = createWrongAnalysisQueue(progress);
  queue.enqueue(["q1", "q2"]);
  queue.stop();

  await vi.runAllTimersAsync();

  expect(edgeCall.mock.calls.map(([, request]) => request)).toEqual([
    { action: "wrong_review", problemId: "q1" },
    { action: "status", jobId: "job-1" },
  ]);
  expect(progress.mock.lastCall?.[0]).toMatchObject({
    results: [{ id: "q1", status: "failed", message: expect.stringContaining("연결이 끊겼습니다") }],
    stopped: 1,
  });
});
