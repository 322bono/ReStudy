import { expect, test, vi } from "vitest";
import { createDrawingSaver } from "../src/services/solve-drawings";

test("moving without changes makes no save request, and saved ink is not sent twice", async () => {
  const save = vi.fn(async () => {}),
    saver = createDrawingSaver(save);
  await saver.flush();
  expect(save).not.toHaveBeenCalled();
  saver.change("q", []);
  await saver.flush();
  await saver.flush();
  expect(save).toHaveBeenCalledTimes(1);
});

test("serializes drawings and retains an edit made during an in-flight save", async () => {
  let resolve!: () => void;
  const save = vi.fn(async () => {
    if (save.mock.calls.length === 1)
      await new Promise<void>((r) => {
        resolve = r;
      });
  });
  const saver = createDrawingSaver(save);
  saver.change("a", [{ color: "old" }] as any);
  const first = saver.flush();
  saver.change("a", [{ color: "new" }] as any);
  saver.change("b", []);
  const second = saver.flush();
  expect(save).toHaveBeenCalledTimes(1);
  resolve();
  await Promise.all([first, second]);
  expect(save.mock.calls).toEqual([
    ["a", [{ color: "old" }]],
    ["a", [{ color: "new" }]],
    ["b", []],
  ]);
  expect(saver.dirty()).toBe(false);
});

test("a failed save remains dirty and retries without losing the latest ink", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined);
  const saver = createDrawingSaver(save);
  saver.change("q", []);
  await expect(saver.flush()).rejects.toThrow("offline");
  expect(saver.dirty()).toBe(true);
  await saver.flush();
  expect(saver.dirty()).toBe(false);
});
