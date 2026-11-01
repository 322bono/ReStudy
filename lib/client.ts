import { cloudApi } from "../src/services/api";
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  return cloudApi<T>(path, method, body);
}
export function dateLabel(value: string) {
  return new Date(value).toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
  });
}
export function dueLabel(value: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  const days = Math.round((date.getTime() - today.getTime()) / 86400000);
  return days < 0
    ? "복습 필요"
    : days === 0
      ? "오늘"
      : days === 1
        ? "내일"
        : dateLabel(value);
}
export const isDue = (value: string) => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return new Date(value) <= d;
};
