export default function ContentReview({ content }: { content: any }) {
  if (!content) return null;
  return (
    <details className="content-review">
      <summary>가져올 개념·문항·정답·해설 펼쳐 보기</summary>
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
      {(content.questions || []).map((q: any, index: number) => (
        <article className="concept-reading" key={q.id}>
          <small>
            {index + 1} · {q.kind} · {q.purpose} · {q.level}
          </small>
          <h3>{q.prompt}</h3>
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
