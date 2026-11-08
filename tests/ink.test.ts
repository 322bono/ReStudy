import { expect, test } from "vitest";
import { eraseInk } from "../src/domain/ink";
import type { Stroke } from "../lib/types";

const stroke = (region = 0): Stroke => ({
  region,
  color: "#111827",
  width: 0.0025,
  points: [
    { x: 0.1, y: 0.5 },
    { x: 0.9, y: 0.5 },
  ],
});
test("erases a crossed stroke even when neither endpoint is near the eraser", () => {
  const ink = [stroke(), stroke(1)];
  const next = eraseInk(
    ink,
    0,
    { x: 0.5, y: 0.1 },
    { x: 0.5, y: 0.9 },
    100,
    200,
    4,
  );
  expect(next).toEqual([ink[1]]);
  expect(ink).toHaveLength(2);
});
test("ignores ink outside the eraser radius and preserves the original array reference", () => {
  const ink = [stroke()];
  expect(
    eraseInk(ink, 0, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.2 }, 100, 200, 4),
  ).toBe(ink);
});
test("a tap erases a dot and uses displayed pixel dimensions for tall crops", () => {
  const dot = { ...stroke(), points: [{ x: 0.5, y: 0.5 }] };
  expect(
    eraseInk([dot], 0, { x: 0.52, y: 0.51 }, { x: 0.52, y: 0.51 }, 100, 200, 4),
  ).toEqual([]);
  expect(
    eraseInk([dot], 0, { x: 0.5, y: 0.55 }, { x: 0.5, y: 0.55 }, 100, 200, 4),
  ).toEqual([dot]);
});
