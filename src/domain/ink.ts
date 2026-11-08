import type { Point, Stroke } from "../../lib/types";

function distanceSquared(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length = dx * dx + dy * dy;
  const t = length
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length))
    : 0;
  return (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
}
function crosses(a: Point, b: Point, c: Point, d: Point) {
  const side = (a: Point, b: Point, c: Point) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return (
    Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <=
      Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) &&
    Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <=
      Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) &&
    side(a, b, c) * side(a, b, d) <= 0 &&
    side(c, d, a) * side(c, d, b) <= 0
  );
}
/** A stroke eraser: intersects the complete pointer segment, scoped to one crop. */
export function eraseInk(
  strokes: Stroke[],
  region: number,
  from: Point,
  to: Point,
  width: number,
  height: number,
  radius = 12,
): Stroke[] {
  if (!(width > 0 && height > 0)) return strokes;
  const pixel = (p: Point) => ({ x: p.x * width, y: p.y * height }),
    a = pixel(from),
    b = pixel(to);
  const result = strokes.filter((stroke) => {
    if (stroke.region !== region || !stroke.points.length) return true;
    const threshold =
      (radius + (stroke.width * Math.max(width, height)) / 2) ** 2;
    return !stroke.points.some((point, index) => {
      const c = pixel(point),
        d = pixel(stroke.points[Math.max(0, index - 1)]);
      return (
        crosses(a, b, c, d) ||
        Math.min(
          distanceSquared(a, c, d),
          distanceSquared(b, c, d),
          distanceSquared(c, a, b),
          distanceSquared(d, a, b),
        ) <= threshold
      );
    });
  });
  return result.length === strokes.length ? strokes : result;
}
