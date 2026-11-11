import { Badge, Button } from "../../components/ui";

/** Reads saved analysis only. Both initial review and answer checking use this view. */
export default function OriginalAnalysis({
  review,
  loading = false,
  onBank,
}: {
  review?: any;
  loading?: boolean;
  onBank: (scope: any) => void;
}) {
  const concepts = review?.concepts || [],
    questions = (review?.questions || []).filter(
      (question: any) => question.active !== false,
    );
  const memorized = review?.memorize || [];
  return (
    <div className="original-analysis" aria-busy={loading}>
      {loading && (
        <p role="status" className="muted">
          저장된 분석을 불러오는 중…
        </p>
      )}
      <section className="analysis-group" aria-label="해설">
        <h2>1. 해설</h2>
        {review?.analysis && <Badge tone="indigo">{review.analysis.model || '저장된 AI 분석'}</Badge>}
        {review?.answer && (
          <p className="analysis-answer">
            <strong>{review.answerSource === "registered" ? "직접 등록한 정답" : "정답"}</strong>{" "}
            {review.answer}
          </p>
        )}
        {review?.explanationAnswer && (
          <p>저장된 해설의 답은 <strong>{review.explanationAnswer}</strong>입니다.</p>
        )}
        <p>
          {review?.explanation ||
            review?.analysis?.key_point ||
            "아직 저장된 해설이 없습니다."}
        </p>
        {review?.solutionSteps?.length > 0 && (
          <ol>
            {review.solutionSteps.map((step: string, i: number) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        )}
        {review?.analysis?.mistakes?.length > 0 && (
          <details>
            <summary>확인할 조건·예상 실수</summary>
            <ul>
              {review.analysis.mistakes.map((value: string, i: number) => (
                <li key={i}>{value}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
      <section className="analysis-group" aria-label="개념 정리">
        <h2>2. 개념 정리</h2>
        {!concepts.length && (
          <p className="muted">저장된 개념 정리가 없습니다.</p>
        )}
        {concepts.map((concept: any) => (
          <article className="analysis-concept" key={concept.id}>
            <h3>{concept.name}</h3>
            <p>{concept.definition || concept.summary}</p>
            {concept.evidence === "toc_only" && (
              <Badge tone="amber">목차 기준 · 본문 확인 필요</Badge>
            )}
            {(concept.formulas?.length
              ? concept.formulas
              : concept.properties || []
            ).length > 0 && (
              <ul>
                {(concept.formulas?.length
                  ? concept.formulas
                  : concept.properties || []
                ).map((value: string, i: number) => (
                  <li key={i}>{value}</li>
                ))}
              </ul>
            )}
            {concept.pitfalls?.length > 0 && (
              <details>
                <summary>주의할 점</summary>
                <ul>
                  {concept.pitfalls.map((value: string, i: number) => (
                    <li key={i}>{value}</li>
                  ))}
                </ul>
              </details>
            )}
          </article>
        ))}
      </section>
      <section className="analysis-group" aria-label="암기사항">
        <h2>3. 암기사항</h2>
        {memorized.length ? (
          <ul>
            {memorized.map((value: string, i: number) => (
              <li key={i}>{value}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">저장된 암기사항이 없습니다.</p>
        )}
      </section>
      <section className="analysis-group" aria-label="추가 확인 문제">
        <h2>4. 추가 확인 문제</h2>
        {!questions.length && (
          <p className="muted">저장된 추가 확인 문제가 없습니다.</p>
        )}
        {questions.map((question: any, i: number) => (
          <details className="analysis-question" key={question.id}>
            <summary>
              {i + 1}. {question.prompt}{" "}
            </summary>
            {question.choices?.length > 0 && (
              <ol type="A">
                {question.choices.map((choice: string, n: number) => (
                  <li key={n}>{choice}</li>
                ))}
              </ol>
            )}
            <details>
              <summary>정답·해설 보기</summary>
              <p>
                <strong>정답</strong> {question.answer}
              </p>
              <p>{question.explanation}</p>
            </details>
          </details>
        ))}
        <div className="analysis-actions">
          {questions.some((question: any) => question.active) && (
            <Button
              variant="secondary"
              onClick={() =>
                onBank({ ...review.bankScope, count: 5, mode: "check" })
              }
            >
              확인 문제 풀기
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
