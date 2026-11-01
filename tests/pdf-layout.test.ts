import { describe, expect, it } from "vitest";
import {
  detectProblems,
  type PageTextItem,
  type PreparedPage,
} from "../src/features/pdf/processor";

const line = (
  text: string,
  x: number,
  y: number,
  width = 0.36,
  height = 0.018,
): PageTextItem => ({ text, x, y, width, height });
const page = (
  number: number,
  items: PageTextItem[],
  kind: PreparedPage["kind"] = "content",
): PreparedPage => ({
  number,
  width: 600,
  height: 800,
  text: items.map((i) => i.text).join("\n"),
  items,
  kind,
  source: "text",
  image: new Blob(),
  warnings: [],
});

describe("evidence-based question crops", () => {
  it('resolves conflicting OCR numbers at the same printed marker using observed neighbours',()=>{
   const body=page(56,[line('272',.51,.1,.05,.015),line('무슨 회의인지 쓰시오.',.51,.125,.35,.01),line('273',.51,.3,.05,.015),line('배경을 서술하시오.',.51,.325,.35,.01),line('274',.51,.5,.05,.015),line('회의의 명칭을 쓰시오.',.51,.525,.35,.01),line('275',.51,.7,.05,.015),line('회의 배경을 서술하시오.',.51,.725,.35,.01)]);
   body.numberMarkers=[{...line('2974',.5105,.5,.05,.015),confidence:.92},{...line('2975',.5105,.7,.05,.015),confidence:.9}];
   expect(detectProblems([body]).map(q=>q.number)).toEqual([272,273,274,275]);
  });
  it("uses large standalone workbook markers above stems and ignores numbered source passages",()=>{
    const result=detectProblems([page(56,[
      line('270',.089,.105,.051,.015),line('(가)에 들어갈 내용으로 가장 적절한 것은?',.089,.129,.3,.010),
      line('271',.089,.503,.05,.015),line('다음 자료에 대한 설명으로 옳은 것은?',.089,.528,.3,.010),
      line('1. 한국의 독립을 위하여 임시 민주 정부를 수립한다.',.525,.190,.36,.011),
      line('2. 임시 정부 수립을 위하여 위원회를 설치한다.',.525,.206,.36,.011),
      line('3. 협정을 작성하기 위하여 공동 심의를 받아야 한다.',.525,.238,.36,.011),
      line('272',.512,.321,.05,.015),line('위 자료의 회의 명칭을 쓰시오.',.512,.346,.3,.010),
      line('56 Ⅱ. 대한민국의 발전',.089,.924,.3,.010),
    ])]);
    expect(result.map(q=>q.number)).toEqual([270,271,272]);
    expect(result[2].regions[0].x).toBeGreaterThan(.4);
  });
  it("rejects chapter enumerations and page numbers beside footer text",()=>{
    expect(detectProblems([page(11,[line('1. 정부의 수립',.09,.1,.3,.018),line('1948년 정부가 수립되었다.',.09,.14),line('2. 경제의 성장',.09,.4,.3,.018),line('74',.1,.925,.03,.01),line('대한민국의 발전',.14,.925,.3,.01)])])).toEqual([]);
  });
  it("handles OCR badges and leading-zero or circled questions without promoting circled choices",()=>{
    const result=detectProblems([page(1,[line('263%',.08,.10,.08,.019),line('밑줄 친 위원회에 대한 설명으로 옳은 것은?',.08,.13,.35,.01),line('① 서로 다른 입력이다.',.1,.2,.35,.01),line('② 치역과 공역이 같다.',.1,.23,.35,.01),line('01',.55,.1,.05,.02),line('다음 방정식의 해를 구하시오.',.55,.13,.35,.01),line('② 다음 중 옳은 것은?',.55,.5,.35,.02)])]);
    expect(result.map(q=>q.number)).toEqual([263,1,2]);
  });
  it("reads columns top-to-bottom and preserves the entire figure band", () => {
    const result = detectProblems([
      page(1, [
        line("11. 왼쪽 문제", 0.07, 0.1),
        line("① 2  ② 3  ③ 5", 0.09, 0.2),
        line("12. 왼쪽 다음 문제", 0.07, 0.55),
        line("13. 오른쪽 문제", 0.56, 0.1),
        line("14. 오른쪽 다음 문제", 0.56, 0.55),
      ]),
    ]);
    expect(result.map((q) => q.number)).toEqual([11, 12, 13, 14]);
    expect(result[0].regions[0].x + result[0].regions[0].w).toBeLessThan(0.56);
    expect(result[0].regions[0].y + result[0].regions[0].h).toBeGreaterThan(
      0.5,
    );
    expect(result[0].text).toContain("① 2");
    expect(result.every((q) => !q.confirmed && q.unit === "")).toBe(true);
  });

  it("keeps numbered choices and subparts inside their outer question", () => {
    const result = detectProblems([
      page(1, [
        line("17. 다음 중 옳은 것은?", 0.07, 0.1),
        line("1) 첫 번째 선택지", 0.1, 0.2),
        line("2) 두 번째 선택지", 0.1, 0.3),
        line("3) 세 번째 선택지", 0.1, 0.4),
        line("18. 다음 문제", 0.07, 0.6),
      ]),
    ]);
    expect(result.map((q) => q.number)).toEqual([17, 18]);
    expect(result[0].text).toContain("3) 세 번째");
  });

  it("does not create questions from numeric tables, decimals, years or footer numbers", () => {
    const result = detectProblems([
      page(1, [
        line("17. 다음 표를 보시오.", 0.07, 0.1),
        line("1", 0.2, 0.25, 0.02),
        line("2", 0.4, 0.25, 0.02),
        line("3.", 0.2, 0.35, 0.02),
        line("4.", 0.4, 0.35, 0.02),
        line("3.14", 0.3, 0.45, 0.04),
        line("2026년", 0.07, 0.06, 0.08),
        line("123", 0.49, 0.97, 0.03),
      ]),
    ]);
    expect(result.map((q) => q.number)).toEqual([17]);
  });

  it("uses a standalone number only when nearby question text corroborates it", () => {
    const result = detectProblems([
      page(1, [
        line("27", 0.07, 0.1, 0.03),
        line("방정식의 해를 구하시오.", 0.12, 0.1, 0.6),
        line("99", 0.3, 0.4, 0.03),
      ]),
    ]);
    expect(result.map((q) => q.number)).toEqual([27]);
  });

  it("preserves separate number tokens in two columns without promoting single-column numeric tables", () => {
    const result = detectProblems([
      page(1, [
        line("27.", 0.06, 0.1, 0.035),
        line("첫 번째 방정식을 구하시오.", 0.11, 0.1, 0.32),
        line("28", 0.56, 0.1, 0.035),
        line("두 번째 방정식을 구하시오.", 0.61, 0.1, 0.32),
        line("1.", 0.21, 0.4, 0.025),
        line("2.", 0.21, 0.5, 0.025),
        line("3.", 0.21, 0.6, 0.025),
      ]),
    ]);
    expect(result.map((q) => q.number)).toEqual([27, 28]);
  });

  it("excludes answer headings and dense continuation keys", () => {
    const answerPage = page(2, [
      line("정답 및 해설", 0.1, 0.04),
      line("1. ③", 0.1, 0.1),
    ]);
    const continuation = page(
      3,
      [1, 2, 3, 4].map((n) => line(`${n + 10}. ③`, 0.1, n * 0.15)),
    );
    const result = detectProblems([
      page(1, [line("1. 정답을 구하시오.", 0.07, 0.1)]),
      answerPage,
      continuation,
    ]);
    expect(result.map((q) => [q.page, q.number])).toEqual([[1, 1]]);
  });

  it("excludes OCR answer headings with spaces between Korean characters", () => {
    const result = detectProblems([
      page(1, [line("정 답 및 해 설", 0.07, 0.03), line("17. ③", 0.07, 0.15)]),
    ]);
    expect(result).toEqual([]);
  });

  it("excludes a dense choice-only answer key even without a repeated heading", () => {
    const result = detectProblems([
      page(
        1,
        [1, 2, 3, 4].map((n) => line(`${n}. ③`, 0.07, n * 0.15)),
      ),
    ]);
    expect(result).toEqual([]);
  });

  it("prepends a full-width common passage to questions in both columns", () => {
    const result = detectProblems([
      page(1, [
        line("[1-2] 다음 글을 읽고 물음에 답하시오.", 0.07, 0.06, 0.8),
        line(
          "가로로 넓게 놓인 공통 지문을 모두 보존해야 한다.",
          0.07,
          0.13,
          0.86,
        ),
        line("1. 첫 번째 문제", 0.07, 0.4),
        line("2. 두 번째 문제", 0.56, 0.4),
      ]),
    ]);
    expect(result.map((q) => q.number)).toEqual([1, 2]);
    expect(
      result.every((q) => q.sharedRegionCount === 1 && q.regions.length === 2),
    ).toBe(true);
    expect(result[0].regions[0]).toEqual(result[1].regions[0]);
    expect(result[0].regions[0].w).toBeGreaterThan(0.9);
  });

  it("retains a shared passage across adjacent pages only within its explicit number range", () => {
    const result = detectProblems([
      page(1, [
        line("[21-22] 다음 글을 읽으시오.", 0.07, 0.06),
        line("공통 지문", 0.07, 0.12),
        line("21. 첫 문제", 0.07, 0.4),
      ]),
      page(2, [
        line("22. 둘째 문제", 0.07, 0.1),
        line("24. 별개의 답을 구하시오.", 0.07, 0.6),
      ]),
    ]);
    expect(result[1].regions[0].page).toBe(1);
    expect(result[1].sharedRegionCount).toBe(1);
    expect(result[2].sharedRegionCount).toBe(0);
    expect(result.map((q) => q.number)).toEqual([21, 22, 24]);
  });

  it("joins explicit continuation regions and stops before the next question", () => {
    const result = detectProblems([
      page(1, [
        line("8. 다음 문제", 0.07, 0.7),
        line("다음 페이지에 계속", 0.07, 0.9),
      ]),
      page(2, [
        line("(계속)", 0.07, 0.06),
        line("계속되는 선택지", 0.07, 0.12),
        line("9. 새로운 문제", 0.07, 0.4),
      ]),
    ]);
    expect(result[0].regions.map((r) => r.page)).toEqual([1, 2]);
    expect(result[0].regions[1].y + result[0].regions[1].h).toBeLessThan(0.4);
    expect(result[0].text).toContain("계속되는 선택지");
    expect(result[0].text).not.toContain("9. 새로운");
  });

  it("never invents continuation, missing numbers or links across page gaps", () => {
    const result = detectProblems([
      page(1, [line("8. 다음 문제", 0.07, 0.7)]),
      page(2, [
        line("새로운 단원", 0.07, 0.06),
        line("12. 새로운 문제", 0.07, 0.4),
      ]),
      page(4, [line("(계속)", 0.07, 0.06), line("13. 다음 문제", 0.07, 0.4)]),
    ]);
    expect(result.map((q) => q.number)).toEqual([8, 12, 13]);
    expect(result.every((q) => q.regions.length === 1)).toBe(true);
  });

  it("preserves duplicate numbers in distinct pages and yields normalized regions", () => {
    const result = detectProblems([
      page(1, [line("1. A의 값을 구하시오.", 0.07, 0.1)]),
      page(2, [line("1. B의 값을 구하시오.", 0.07, 0.1)]),
    ]);
    expect(result.map((q) => [q.page, q.number])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    for (const q of result)
      for (const r of q.regions) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(1);
        expect(r.y + r.h).toBeLessThanOrEqual(1);
        expect(r.w * r.h).toBeGreaterThan(0);
      }
  });

  it("retains an explicit question near the bottom margin while ignoring footer digits", () => {
    const result = detectProblems([
      page(1, [
        line("27. 다음 페이지의 그림을 보시오.", 0.07, 0.95),
        line("123", 0.49, 0.985, 0.03, 0.01),
      ]),
    ]);
    expect(result.map((q) => q.number)).toEqual([27]);
    expect(result[0].regions[0].y).toBeGreaterThan(0.9);
  });
});
