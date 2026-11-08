import { expect, test } from "vitest";
import { validateOutput } from "../supabase/functions/_shared/ai/schemas";
import { originalReview } from "../src/domain/learning";

const review = (answer: string, explanation: string) => ({
  solution: { answer, explanation },
  concepts: [{ name: "생태계", summary: "생산자는 유기물을 합성한다." }],
  memorize: ["생산자와 소비자를 구별한다."],
  questions: [
    {
      prompt: "생산자의 역할은?",
      answer: "유기물 합성",
      explanation: "빛에너지를 이용한다.",
    },
  ],
});

test.each([
  ["②", "ㄱ은 옳고 ㄴ, ㄷ은 틀립니다. 따라서 정답은 ①번입니다."],
  ["③", "갑국 100원, 을국 200원입니다. 결과적으로 ②번이 정답입니다."],
  ["①", "ㄱ은 틀렸습니다. 아, 아닙니다. A가 생산자이기에 ㄱ은 옳습니다."],
  ["②", "ㄱ. 옳음.\nㄴ. 틀림.\n다시 분석: ㄱ. 틀림."],
])(
  "rejects a contradictory final answer before saving (%s)",
  (answer, explanation) => {
    expect(() =>
      validateOutput("wrong_review", review(answer, explanation), []),
    ).toThrow();
  },
);

test("accepts explanations of a misconception without treating every negation as self-correction", () => {
  const value = review(
    "②",
    "ㄱ. 소비자는 생산자가 아닙니다. ㄴ. 생산자는 유기물을 합성합니다. 따라서 정답은 ②번입니다.",
  );
  expect(validateOutput("wrong_review", value, [])).toEqual(value);
});

test("hides conflicting saved AI answers while preserving the saved record and history", () => {
  const bad = review("②", "따라서 정답은 ①번입니다.");
  const question = { id: "q", conceptIds: [], wrongReview: bad };
  const result = originalReview(question, {
    questions: [],
    bank: [],
    concepts: [],
    mistakes: [],
    materials: [],
    results: [],
  });
  expect(result).toMatchObject({
    requiresReanalysis: true,
    answer: "",
    hasSavedAnalysis: false,
    questions: [],
  });
  expect(question.wrongReview).toEqual(bad);
});
