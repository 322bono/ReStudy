/** Conservative consistency checks, not a subject-matter correctness proof. */
export function answerKey(answer: string): string {
  const value = answer.normalize("NFKC").trim();
  const choice =
    /^(?:정답\s*[:：]?\s*)?([1-5])\s*(?:번|번입니다[.!]?|[.)])?$/.exec(value);
  return choice
    ? `choice:${choice[1]}`
    : value.toLocaleLowerCase("ko").replace(/\s+/g, "");
}

export function answerIssues(
  solution: { answer?: unknown; explanation?: unknown } | undefined,
): string[] {
  if (
    typeof solution?.answer !== "string" ||
    typeof solution.explanation !== "string"
  )
    return [];
  const explanation = solution.explanation;
  const issues = new Set<string>();
  if (
    /아,\s|(?:^|[\n(（*])\s*(?:다시\s*(?:분석|계산|검토|확인)|수정|정정)\s*[:：*]|\?\s*아닙니다|오답\s*수정|풀이\s*과정\s*중.{0,35}오타/.test(
      explanation,
    )
  )
    issues.add("self_correction");
  const claimed = answerKey(solution.answer);
  if (claimed.startsWith("choice:")) {
    // Compare explicit final-answer claims only, never a rejected option or a
    // number inside a calculation. NFKC converts circled option numbers too.
    const text = explanation.normalize("NFKC");
    const conclusions = [
      ...text.matchAll(
        /(?:정답|선택지)\s*(?:은|는|:|：)?\s*\(?([1-5])\s*(?:번|[)）]|입니다|이다)/g,
      ),
      ...text.matchAll(/([1-5])\s*번\s*(?:이|가)\s*정답/g),
    ];
    if (conclusions.some((match) => `choice:${match[1]}` !== claimed))
      issues.add("answer_mismatch");
  }
  return [...issues];
}

export function wrongReviewIssues(review: any): string[] {
  return [
    ...new Set([
      ...answerIssues(review?.solution),
      ...(Array.isArray(review?.questions)
        ? review.questions.flatMap((q: any) => answerIssues(q))
        : []),
    ]),
  ];
}
