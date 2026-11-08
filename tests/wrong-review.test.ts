import { expect, it, vi } from "vitest";
import { resolveMistakeNumbers } from "../src/domain/mistake-selection";
import { originalReview } from "../src/domain/learning";
import { validateOutput } from "../supabase/functions/_shared/ai/schemas";
import { generate } from "../supabase/functions/_shared/ai/providers";
import { publicQuestion } from "../supabase/functions/_shared/app/repository";

const result = {
  solution: { answer: "낮아진다", explanation: "빛의 세기가 약해지면 광합성량이 줄어든다." },
  concepts: [{ name: "광합성", summary: "빛에너지를 이용해 유기물을 만드는 과정" }],
  memorize: ["다른 조건이 같을 때 빛의 세기를 비교한다."],
  questions: [{ prompt: "광합성에 필요한 에너지는?", answer: "빛에너지", explanation: "빛에너지를 화학 에너지로 바꾼다." }],
};

it("requests only the four review sections and sends all saved image regions", async () => {
  const transport = vi.fn(async (_url: unknown, request?: RequestInit) => {
    const body = JSON.parse(String(request?.body));
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe('HIGH');
    const parts = body.contents[0].parts;
    expect(parts).toHaveLength(3);
    expect(parts[1].inlineData.data).toBe("AAAA");
    expect(parts[2].inlineData.data).toBe("AAAB");
    expect(parts[0].text).not.toMatch(/concept_ids|concept_keys|source_citations|restudy\.v1/);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(result) }] } }] });
  });
  const reply = await generate("gemini", "gemma-4-26b-a4b-it", "test-key", {
    kind: "wrong_review", prompt: "문제를 푸세요.",
    images: [{ mimeType: "image/png", data: "AAAA" }, { mimeType: "image/png", data: "AAAB" }],
  }, transport as typeof fetch, 0);
  expect(validateOutput("wrong_review", reply.raw, [])).toEqual(result);
  expect(() => validateOutput("wrong_review", { ...result, questions: [] }, [])).toThrow();
  expect(() => validateOutput("wrong_review", { ...result, solution: { ...result.solution, answer: "null" } }, [])).toThrow();
});

it("reveals saved review and additional questions without concept-bank IDs", () => {
  const question = { id: "original", conceptIds: [], wrongReview: result };
  const state = { questions: [], bank: [], concepts: [], mistakes: [], materials: [], results: [] };
  expect(publicQuestion(question)).not.toHaveProperty("wrongReview");
  expect(originalReview(question, state)).toMatchObject({
    hasSavedAnalysis: true, ...result.solution,
    concepts: result.concepts, memorize: result.memorize, questions: result.questions,
  });
});

it("resolves mixed ranges and requires a page choice for repeated numbers", () => {
  const first = { id: "first", page: 110, number: 7 };
  const second = { id: "second", page: 187, number: 7 };
  const source = [second, first, { id: "third", page: 187, number: 8 }];
  expect(resolveMistakeNumbers("７–８, 7, 9", source)).toEqual({
    matches: ["third"], ambiguous: [[first, second]], missing: [9], error: "",
  });
  expect(resolveMistakeNumbers("7~8", source.filter((q) => q.page === 187)).matches).toEqual(["second", "third"]);
  expect(resolveMistakeNumbers("1-201", source).error).not.toBe("");
});
