/** All values are physical PDF pages (one-based), never inferred printed labels. */
export function selectPages(expression: string, total: number, excluded = "") {
  if (!Number.isInteger(total) || total < 1 || total > 500)
    throw new Error("PDF 페이지 수를 확인하세요.");
  const selected = new Set<number>(),
    removed = new Set<number>();
  const read = (value: string, excludeOnly = false) => {
    for (const token of value
      .trim()
      .split(/[\s,，]+/)
      .filter(Boolean)) {
      const match = token.match(/^(!?)(\d+)(?:\s*[-~]\s*(\d+))?$/);
      if (!match) throw new Error(`페이지 범위를 확인하세요: ${token}`);
      const a = Number(match[2]),
        b = Number(match[3] || match[2]);
      if (a < 1 || b < a || b > total)
        throw new Error(`페이지는 1~${total} 범위로 입력하세요.`);
      for (let n = a; n <= b; n++)
        (excludeOnly || match[1] ? removed : selected).add(n);
    }
  };
  if (!expression.trim()) for (let n = 1; n <= total; n++) selected.add(n);
  else read(expression);
  read(excluded, true);
  for (const n of removed) selected.delete(n);
  if (!selected.size) throw new Error("분석할 페이지를 하나 이상 선택하세요.");
  return [...selected].sort((a, b) => a - b);
}
export function tocPages(expression: string, total: number) {
  return expression.trim() ? selectPages(expression, total) : [];
}
export function newlySelected(previous: number[], next: number[]) {
  const old = new Set(previous);
  return [...new Set(next)].filter((n) => !old.has(n)).sort((a, b) => a - b);
}
