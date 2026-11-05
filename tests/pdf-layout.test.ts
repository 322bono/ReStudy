import { describe, expect, it } from "vitest";
import {
  analyzeProblemLayout,
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
  it("recognizes large text-layer badges across a numbering reset and retains the boxed choices", () => {
    const badge = (text: string, y: number) => ({ ...line(text, .09, y, .028, .019), fontName: "badge-font" });
    const block = (number: string, y: number) => [
      badge(number, y),
      line("그림은 두 지역을 나타낸 것이다.", .09, y + .023, .34, .011),
      line("옳은 것을 [보기]에서 고른 것은?", .09, y + .13, .35, .011),
      { ...line("78", .27, y + .15, .019, .008), fontName: "decorative-font" },
      line("ㄱ. 두 지역은 온도가 다르다.", .10, y + .17, .3, .011),
      line("① ㄱ", .09, y + .2, .03, .011),
      line("② ㄴ", .21, y + .2, .03, .011),
    ];
    const result = detectProblems([
      page(31, [...block("01", .1), ...block("02", .53)]),
      page(35, [...block("01", .1), ...block("02", .53)]),
    ], [35]);
    expect(result.map((q) => [q.page, q.number])).toEqual([[31, 1], [31, 2], [35, 1], [35, 2]]);
    expect(result.every((q) => q.text.includes("ㄱ. 두 지역") && q.text.includes("② ㄴ"))).toBe(true);
  });

  it("attaches continuing choices on the next page without taking the next question or crossing a chapter", () => {
    const input = [
      page(1, [line("7. 다음 중 옳은 것은?", .07, .7), line("① 첫째 선택지", .07, .85), line("② 둘째 선택지", .07, .89)]),
      page(2, [line("③ 셋째 선택지", .07, .075), line("④ 넷째 선택지", .07, .1), line("8. 새로운 문제", .07, .3)]),
    ];
    const result = detectProblems(input);
    expect(result.map((q) => q.number)).toEqual([7, 8]);
    expect(result[0].regions.map((r) => r.page)).toEqual([1, 2]);
    expect(result[0].text).toContain("④ 넷째");
    expect(result[0].text).not.toContain("8. 새로운");
    expect(detectProblems(input, [2])[0].regions).toHaveLength(1);
  });

  it("keeps continued choices above the next question in the right column", () => {
    const result = detectProblems([page(1, [
      line("7. 다음 중 옳은 것은?", .07, .5),
      line("① 첫째 선택지", .07, .8),
      line("② 둘째 선택지", .07, .85),
      line("③ 셋째 선택지", .55, .1),
      line("④ 넷째 선택지", .55, .13),
      line("8. 새로운 문제", .55, .4),
    ])]);
    expect(result.map((q) => q.number)).toEqual([7, 8]);
    expect(result[0].regions).toHaveLength(2);
    expect(result[0].regions[1].x).toBeGreaterThan(.4);
    expect(result[0].text).toContain("④ 넷째");
    expect(result[0].text).not.toContain("8. 새로운");
  });
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

  it("links a spaced pipe-delimited passage and stops before an unindexed next passage", () => {
    const result = detectProblems([page(78, [
      line("| 382~383 |", .51, .14, .08, .01),
      line("두 문항의 공통 자료", .51, .2, .28, .012),
      line("382. 원인을 쓰시오.", .51, .37),
      line("383. 정책을 서술하시오.", .51, .47),
      line("| 384~385 |", .51, .57, .08, .01),
      line("다른 문항의 그래프", .51, .62),
    ])]);
    expect(result.map((q) => q.number)).toEqual([382, 383]);
    expect(result[1].regions).toHaveLength(2);
    expect(result[1].text).toContain("두 문항의 공통 자료");
    expect(result[1].text).not.toContain("다른 문항의 그래프");
  });

  it("shares a table when PDF text omits the graphics around the number range", () => {
    const badge = (text: string, y: number) => ({
      ...line(text, .51111, y, .04803, .01764),
      fontName: "question-badge",
    });
    const result = detectProblems([page(78, [
      badge("309", .07896),
      line("다음 중 옳지 않은 것은?", .51111, .107, .32, .01082),
      line("⑤ 앞 문항의 마지막 선택지", .51111, .32, .31, .01082),
      { ...line("310~311", .51927, .36056, .06144, .00941), fontName: "question-badge" },
      line("표는 공통 자료를 나타낸 것이다.", .59759, .36061, .29, .01082),
      line("표의 마지막 행", .58667, .47223, .29, .00941),
      badge("310", .50026),
      line("공통 자료의 특징을 설명하시오.", .51111, .52796, .35, .01082),
      badge("311", .66307),
      line("위 표를 해석한 내용으로 옳은 것은?", .51111, .69077, .35, .01082),
    ])]);
    expect(result.map(q => q.number)).toEqual([309, 310, 311]);
    const [previous, first, second] = result;
    expect([previous.sharedRegionCount, first.sharedRegionCount, second.sharedRegionCount]).toEqual([0, 1, 1]);
    expect(first.regions[0]).toEqual(second.regions[0]);
    expect(first.regions[0].y).toBeLessThan(.36056);
    expect(first.regions[0].y + first.regions[0].h).toBeGreaterThan(.48164);
    expect(previous.regions[0].y + previous.regions[0].h).toBeLessThan(.36056);
    expect(first.text).toContain("표의 마지막 행");
    expect(second.text).toContain("표의 마지막 행");
  });

  it("keeps an ordinary numeric interval with the preceding question", () => {
    const result = detectProblems([page(1, [
      line("309. 표의 값으로 옳은 것은?", .1, .1),
      line("310~311", .1, .2, .05),
      line("표에 기록된 온도 범위", .16, .2, .28),
      line("310. 별개의 값을 구하시오.", .1, .4),
      line("311. 별개의 값을 구하시오.", .1, .65),
    ])]);
    expect(result.map(q => q.sharedRegionCount)).toEqual([0, 0, 0]);
    expect(result[0].text).toContain("표에 기록된 온도 범위");
  });

  it("retains all choices beside a late question number in the other column", () => {
    const badge = (text: string, x: number, y: number) => ({
      ...line(text, x, y, .04, .016),
      fontName: "workbook-number",
    });
    const result = detectProblems([page(72, [
      badge("344", .084, .51),
      line("다음 중 옳은 것은?", .084, .535, .3, .011),
      badge("345", .084, .9033),
      line("다음 주장을 설명하시오.", .084, .928, .3, .011),
      badge("347", .519, .593),
      line("밑줄 친 부분에 대한 설명으로 옳은 것은?", .519, .618, .35, .011),
      line("③ 셋째 선택지", .519, .863, .29, .0113),
      line("④ 넷째 선택지", .519, .9013, .29, .0113),
      line("⑤ 다섯째 선택지", .519, .9203, .35, .0113),
      line("72", .084, .9513, .023, .0143),
    ])]);
    expect(result.map(q => q.number)).toEqual([344, 345, 347]);
    const question = result[2];
    expect(question.text).toContain("⑤ 다섯째 선택지");
    expect(question.regions[0].y + question.regions[0].h).toBeGreaterThan(.9316);
  });

  it("joins an explicitly bracketed range split into PDF text tokens without changing the question numbers", () => {
    const result = detectProblems([page(73, [
      line("351. 다음 문제를 푸시오.", .528, .069),
      line("[", .5282, .4364, .0061, .011),
      line("352", .5349, .4364, .0264, .011),
      line("~", .5619, .4364, .011, .011),
      line("353", .5735, .4364, .027, .011),
      line("] 빈출 자료", .6011, .4364, .0782, .011),
      line("다음 사례를 읽고 물음에 답하시오.", .528, .457),
      line("카페에서 일하는 갑의 사례", .543, .489),
      line("352. 기회비용을 구하시오.", .528, .584),
      line("⑤ 마지막 선택지", .528, .684),
      line("353. 위 사례와 관련해 옳은 것은?", .528, .753),
      line("보기", .71, .800, .03),
      line("ㄱ. 명시적 비용은 30만 원이다.", .543, .816),
      line("355. 별개의 답을 구하시오.", .528, .93),
    ])]);
    expect(result.map(q => q.number)).toEqual([351, 352, 353, 355]);
    const [previous, first, second, next] = result;
    expect(first.regions[0]).toEqual(second.regions[0]);
    expect(first.sharedRegionCount).toBe(1);
    expect(second.sharedRegionCount).toBe(1);
    expect(first.text).toContain("카페에서 일하는 갑의 사례");
    expect(second.text).toContain("ㄱ. 명시적 비용");
    expect(previous.text).not.toContain("카페에서 일하는 갑의 사례");
    expect(next.sharedRegionCount).toBe(0);
  });

  it.each([
    { pageNumber: 84, x: .51860, first: 411, last: 413, digitWidth: .01949 },
    { pageNumber: 85, x: .09302, first: 414, last: 415, digitWidth: .02289 },
  ])("links the entire graph to $first–$last when narrow digits split the heading", ({ pageNumber, x, first, last, digitWidth }) => {
    const y = .06749;
    const endX = x + .01827 + digitWidth;
    const graphBottom = .26189;
    const result = detectProblems([page(pageNumber, [
      line("[", x, y, .00606, .01105),
      line(String(first), x + .00667, y, digitWidth, .01105),
      line("~", x + .00728 + digitWidth, y, .01099, .01105),
      line(String(last), endX + .00061, y, .02289, .01105),
      line("] 빈출 자료", endX + .02411, y, .07822, .01105),
      line("위 그래프를 읽고 물음에 답하시오.", x, .08785, .35, .01128),
      line("시기", x + .31, .25361, .020, .00828),
      ...Array.from({ length: last - first + 1 }, (_, i) =>
        line(`${first + i}. 위 그래프에 대한 설명으로 옳은 것은?`, x, .275 + i * .21)),
    ])]);
    expect(result.map(q => q.number)).toEqual(Array.from({ length: last - first + 1 }, (_, i) => first + i));
    for (const question of result) {
      expect(question.sharedRegionCount).toBe(1);
      expect(question.regions[0]).toEqual(result[0].regions[0]);
      expect(question.regions[0].y + question.regions[0].h).toBeGreaterThan(graphBottom);
      expect(question.text).toContain("시기");
    }
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

  it("keeps a shared table across a page header and stops at a numbering reset", () => {
    const result = detectProblems([
      page(1, [
        line("[21~22] 다음 표를 보고 답하시오.", .07, .08),
        line("공통 표의 마지막 행", .07, .3),
        line("21. 표에서 옳은 것을 고르시오.", .07, .5),
      ]),
      page(2, [
        line("생태계와 환경", .07, .025),
        line("22. 같은 표에서 답을 구하시오.", .07, .1),
        line("1. 새 단원에서 답을 구하시오.", .07, .4),
        line("21. 다른 자료에서 답을 구하시오.", .07, .7),
      ]),
    ]);
    expect(result.map(q => q.sharedRegionCount)).toEqual([1, 1, 0, 0]);
    expect(result[1].regions[0]).toEqual(result[0].regions[0]);
    expect(result[1].text).toContain("공통 표의 마지막 행");
  });

  it("does not reuse an earlier shared passage after the numbering restarts on the same page", () => {
    const result = detectProblems([page(1, [
      line("[21~22] 다음 글을 읽고 답하시오.", .07, .07),
      line("첫 번째 단원의 공통 보기", .07, .15),
      line("21. 첫 문제", .07, .25),
      line("22. 둘째 문제", .07, .45),
      line("1. 새로운 문제", .07, .65),
      line("21. 다른 자료에서 답을 구하시오.", .07, .85),
    ])]);
    expect(result.map(q => q.sharedRegionCount)).toEqual([1, 1, 0, 0]);
    expect(result[3].text).not.toContain("첫 번째 단원의 공통 보기");
  });

  it("links a shared table at a page end to questions beginning on the next page", () => {
    const result = detectProblems([
      page(1, [
        line("18. 답을 구하시오.", .07, .1),
        line("[19~20] 다음 표를 보고 답하시오.", .07, .6),
        line("다음 쪽 두 문항에 쓰이는 표", .07, .8),
      ]),
      page(2, [
        line("19. 표에 대한 설명을 고르시오.", .07, .1),
        line("20. 표에서 답을 구하시오.", .07, .5),
      ]),
    ]);
    expect(result.map(q => q.sharedRegionCount)).toEqual([0, 1, 1]);
    expect(result[1].regions[0].page).toBe(1);
    expect(result[1].text).toContain("다음 쪽 두 문항에 쓰이는 표");
    expect(result[0].regions[0].y + result[0].regions[0].h).toBeLessThan(.6);
  });

  it("audits every number in a shared range without inventing an unrecognized question", () => {
    const result = analyzeProblemLayout([page(1, [
      line("[310~312] 다음 표를 보고 답하시오.", .07, .07),
      line("생물의 특징 표", .07, .15),
      line("310. 옳은 설명을 고르시오.", .07, .3),
      line("312. 답을 구하시오.", .07, .6),
    ])]);
    expect(result.problems.map(q => q.number)).toEqual([310, 312]);
    expect(result.problems.every(q => q.sharedRegionCount === 1)).toBe(true);
    expect(result.sharedContextChecks).toHaveLength(1);
    expect(result.sharedContextChecks[0]).toMatchObject({
      page: 1, startNumber: 310, endNumber: 312,
      linkedNumbers: [310, 312], missingNumbers: [311], status: "partial",
    });
  });

  it.each([
    { nextPage: 3, chapterStarts: [] },
    { nextPage: 2, chapterStarts: [2] },
  ])("closes a shared range at a skipped page or chapter boundary $nextPage/$chapterStarts", ({nextPage, chapterStarts}) => {
    const result = analyzeProblemLayout([
      page(1, [line("[21~22] 다음 자료를 보시오.", .07, .08), line("21. 답을 구하시오.", .07, .4)]),
      page(nextPage, [line("22. 다른 단원에서 답을 구하시오.", .07, .1)]),
    ], chapterStarts);
    expect(result.problems[1].sharedRegionCount).toBe(0);
    expect(result.sharedContextChecks[0].missingNumbers).toEqual([22]);
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
