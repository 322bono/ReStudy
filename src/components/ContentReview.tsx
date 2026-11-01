export default function ContentReview({ content }: { content: any }) {
  if (!content) return null;
  const names = new Map(
    (content.concepts || []).map((c: any) => [c.id, c.name]),
  );
  const linked = (ids: string[] = []) =>
    ids.map((id) => names.get(id) || id).join(" · ");
  const kinds: Record<string, string> = {
    mcq: "객관식",
    ox: "OX",
    short: "단답형",
    blank: "빈칸",
  };
  const purposes: Record<string, string> = {
    concept: "개념 퀴즈",
    practice: "연습문제",
    similar: "유사문제",
  };
  const levels: Record<string, string> = {
    easy: "하",
    medium: "중",
    hard: "상",
  };
  return (
    <details className="content-review">
      <summary>병합된 원본 연결·개념·문항·정답·해설 펼쳐 보기</summary>
      <p>
        원본 분석 {(content.problemAnalyses || []).length}개 · 개념{" "}
        {(content.concepts || []).length}개 · 은행 문항{" "}
        {(content.questions || []).length}개
      </p>
      {(content.chapters || []).map((c: any) => (
        <article className="concept-reading" key={c.id}>
          <h3>{c.title}</h3>
          <p>
            PDF {c.start_page}–{c.end_page}쪽
          </p>
        </article>
      ))}
      {(content.concepts || []).map((c: any) => (
        <article className="concept-reading" key={c.id}>
          <h3>{c.name}</h3>
          <p>{c.summary}</p>
          {["formulas", "memorize", "pitfalls"].map((key) => (
            <ul key={key}>
              {(c[key] || []).map((text: string, index: number) => (
                <li key={index}>{text}</li>
              ))}
            </ul>
          ))}
        </article>
      ))}
      {(content.problemAnalyses || []).map((a: any, index: number) => (
        <article
          className="concept-reading"
          key={`${a.chapter_id}-${a.pdf_page}-${a.q_number}-${index}`}
        >
          <small>원본 문제별 개념 연결</small>
          <h3>
            {a.q_number}번 · PDF {a.pdf_page}쪽
          </h3>
          <p>
            <strong>연결 개념</strong> {linked(a.concept_ids)}
          </p>
          <p>
            <strong>해결 핵심</strong> {a.key_point}
          </p>
          {!!a.memorize?.length && (
            <>
              <strong>필수 암기사항</strong>
              <ul>
                {a.memorize.map((text: string, i: number) => (
                  <li key={i}>{text}</li>
                ))}
              </ul>
            </>
          )}
          {!!a.mistakes?.length && (
            <>
              <strong>주의할 점 · 실제 오답 원인에 대한 판정은 아닙니다</strong>
              <ul>
                {a.mistakes.map((text: string, i: number) => (
                  <li key={i}>{text}</li>
                ))}
              </ul>
            </>
          )}
        </article>
      ))}
      {(content.questions || []).map((q: any, index: number) => (
        <article className="concept-reading" key={q.id}>
          <small>
            {index + 1} · {kinds[q.kind] || q.kind} ·{" "}
            {purposes[q.purpose] || q.purpose} · 난이도{" "}
            {levels[q.level] || q.level}
          </small>
          <h3>{q.prompt}</h3>
          <p>
            연결 개념: {linked(q.concept_ids)} · PDF{" "}
            {(q.source_pages || []).join(", ")}쪽
          </p>
          {q.source_problem && (
            <p>
              연결 원본: {q.source_problem.q_number}번 · PDF{" "}
              {q.source_problem.pdf_page}쪽
            </p>
          )}
          <ol type="A">
            {q.options.map((option: string, i: number) => (
              <li key={i}>{option}</li>
            ))}
          </ol>
          <p>
            <strong>정답</strong> {q.answer}
          </p>
          <p>{q.explanation}</p>
          {Object.entries(q.option_explanations).map(([key, value]) => (
            <p key={key}>
              <strong>{key}</strong> {String(value)}
            </p>
          ))}
        </article>
      ))}
      {(content.flashcards || []).map((q: any) => (
        <article className="concept-reading" key={q.id}>
          <h3>{q.front}</h3>
          <p>{q.back}</p>
        </article>
      ))}
    </details>
  );
}
