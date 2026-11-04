import { expect, it, vi } from "vitest";
import { materialProgress } from "../src/services/api";

const mocked = vi.hoisted(() => ({
  getSession: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), in: vi.fn(), abortSignal: vi.fn(),
}));
vi.mock("../src/services/supabase", () => ({
  edgeCall: vi.fn(),
  getSupabase: () => ({ auth: { getSession: mocked.getSession }, from: mocked.from }),
}));

it("polls only selected owner documents and omits large PDF metadata", async () => {
  const signal = new AbortController().signal;
  const rows = [{ id: "target", status: "processing", progress: 70 }];
  mocked.getSession.mockResolvedValue({ data: { session: { user: { id: "owner" } } } });
  mocked.from.mockReturnValue(mocked);
  mocked.select.mockReturnValue(mocked);
  mocked.eq.mockReturnValue(mocked);
  mocked.in.mockReturnValue(mocked);
  mocked.abortSignal.mockResolvedValue({ data: rows });
  await expect(materialProgress(["target"], signal)).resolves.toEqual(rows);
  expect(mocked.from).toHaveBeenCalledWith("documents");
  expect(mocked.select.mock.calls[0][0]).toMatch(/id,status,paused:data->paused,progress:data->progress/);
  expect(mocked.eq).toHaveBeenCalledWith("user_id", "owner");
  expect(mocked.in).toHaveBeenCalledWith("id", ["target"]);
  expect(mocked.abortSignal).toHaveBeenCalledWith(signal);
});
