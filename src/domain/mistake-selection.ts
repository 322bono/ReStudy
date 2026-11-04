export function resolveMistakeNumbers<T extends { id: string; number: number; page: number }>(
  expression: string,
  source: T[],
) {
  const numbers = new Set<number>();
  const matches: string[] = [];
  const ambiguous: T[][] = [];
  const missing: number[] = [];
  const result = { matches, ambiguous, missing, error: "" };
  const input = expression.normalize("NFKC").replace(/\s*[-~–—]\s*/g, "-");
  for (const token of input.split(/[\s,]+/).filter(Boolean)) {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(token);
    const first = Number(match?.[1]), last = Number(match?.[2] ?? match?.[1]);
    if (!match || first < 1 || last < first || last - first >= 200)
      return { ...result, error: "문제 번호와 범위를 확인해 주세요. 예: 3, 7, 12–15" };
    for (let number = first; number <= last; number++) numbers.add(number);
    if (numbers.size > 200) return { ...result, error: "한 번에 200개까지 등록할 수 있습니다." };
  }
  for (const number of numbers) {
    const found = source.filter((q) => q.number === number).sort((a, b) => a.page - b.page);
    if (found.length === 1) matches.push(found[0].id);
    else if (found.length > 1) ambiguous.push(found);
    else missing.push(number);
  }
  return result;
}
