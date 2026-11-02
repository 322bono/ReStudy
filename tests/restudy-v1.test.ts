import { describe, expect, it } from "vitest";
import {
  parseRestudy,
  validateRestudyParts,
  createExternalPrompt,
  splitCount,
  questionFingerprint,
  RestudyJSONSchema,
} from "../src/domain/restudy";
import { createJob,previewPart,jobView } from "../supabase/functions/_shared/standard/service";
import ContentReview from "../src/components/ContentReview";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const job = {
  id: "job_001",
  documentId: "doc_001",
  pageCount: 120,
  selectedPages: [22, 23],
  tocPages: [3, 4],
  subject: "수학",
  title: "실제 등록 자료",
  questionCount: 100,
  totalParts: 5,
  partSize: 20,
  taskType: "bank",
  questionTypes: ["mcq", "ox", "short", "blank"],
  difficultyDistribution: { easy: 20, medium: 50, hard: 30 },
  targetQuestions: [],
};
function part(n = 1): any {
  return {
    schema_version: "restudy.v1",
    document_id: "doc_001",
    job_id: "job_001",
    part: n,
    total_parts: 5,
    chapters:
      n === 1
        ? [{ id: "ch1", title: "함수", start_page: 15, end_page: 40 }]
        : [],
    concepts:
      n === 1
        ? [
            {
              id: "c1",
              chapter_id: "ch1",
              name: "일대일대응",
              summary: "치역과 공역이 같은 일대일함수",
              formulas: [],
              memorize: ["치역과 공역 일치"],
              pitfalls: ["일대일함수와 구별"],
            },
          ]
        : [],
    problem_analyses: [],
    questions: [
      {
        id: `q${n}`,
        chapter_id: "ch1",
        concept_ids: ["c1"],
        kind: "mcq",
        purpose: "concept",
        level: "medium",
        source_problem: null,
        prompt: `조건을 구별하는 문제 ${n}`,
        options: ["선지1", "선지2", "선지3", "선지4"],
        answer: "C",
        accepted_answers: [],
        explanation: "조건을 모두 확인한다.",
        option_explanations: {
          A: "조건 부족",
          B: "조건 부족",
          C: "모든 조건",
          D: "조건 오류",
        },
        source_pages: [22],
      },
    ],
    flashcards: [],
    similarities: [],
  };
}
it('accepts the same stored chapter/concept after PostgreSQL jsonb reorders object keys',()=>{
 const incoming=part(),chapter=incoming.chapters[0],concept=incoming.concepts[0];
 const reorder=(value:any):any=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reorder(v)])):value;
 const result=validateRestudyParts([incoming],job,{chapters:[reorder(chapter)],concepts:[reorder(concept)]});
 expect(result.errors).toEqual([]);
 const changed=validateRestudyParts([incoming],job,{chapters:[{...chapter,title:'다른 단원'}]});
 expect(changed.errors.join(' ')).toContain('서로 다른 내용');
});
describe("restudy.v1 shared pipeline", () => {
  it("allocates whole-job purpose and type quotas into actual part sizes", () => {
    const prompt = createExternalPrompt(
      {
        ...job,
        purposeCounts: { concept: 5, practice: 95, similar: 0 },
        questionTypeCounts: { mcq: 15, ox: 85 },
      },
      1,
    );
    expect(prompt).toContain(
      '목적별 이번 분할 수: {"concept":5,"practice":15,"similar":0}',
    );
    expect(prompt).toContain('유형별 이번 분할 수: {"mcq":15,"ox":5}');
    expect(
      createExternalPrompt(
        { ...job, purposeCounts: { concept: 5, practice: 95, similar: 0 } },
        2,
      ),
    ).toContain('목적별 이번 분할 수: {"concept":0,"practice":20,"similar":0}');
  });
  it("strips only an outer JSON fence and requires every top-level collection", () => {
    expect(
      parseRestudy("```json\n" + JSON.stringify(part()) + "\n```").questions[0]
        .answer,
    ).toBe("C");
    const p = part();
    delete p.flashcards;
    expect(() => parseRestudy(p)).toThrow();
    expect(() => parseRestudy("설명\n" + JSON.stringify(part()))).toThrow();
  });
  it("rejects invalid option letters, duplicate options and missing option feedback", () => {
    for (const change of [
      { answer: "E" },
      { options: ["A", "A", "B", "C"] },
      { option_explanations: { A: "a" } },
    ]) {
      const p = part();
      Object.assign(p.questions[0], change);
      expect(() => parseRestudy(p)).toThrow();
    }
  });
  it("rejects document/job mismatch and pages outside the actual selected PDF range", () => {
    const p = part();
    expect(
      validateRestudyParts([{ ...p, document_id: "other" }], job).errors.join(),
    ).toMatch(/문서/);
    expect(
      validateRestudyParts([{ ...p, job_id: "other" }], job).errors.join(),
    ).toMatch(/작업/);
    p.questions[0].source_pages = [24];
    expect(validateRestudyParts([p], job).errors.join()).toMatch(/페이지/);
  });
  it("accepts out-of-order parts as pending then resolves cross-part concepts", () => {
    const p2 = part(2);
    const first = validateRestudyParts([p2], job);
    expect(first.errors).toEqual([]);
    expect(first.unresolved.length).toBeGreaterThan(0);
    expect(first.ready).toBe(false);
    const combined = validateRestudyParts([p2, part(1)], job);
    expect(combined.errors).toEqual([]);
    expect(combined.unresolved).toEqual([]);
    expect(combined.questions).toHaveLength(2);
    expect(combined.ready).toBe(true);
  });
  it("re-imports the same part idempotently and rejects conflicting versions", () => {
    expect(validateRestudyParts([part(), part()], job).questions).toHaveLength(
      1,
    );
    const altered = part();
    altered.questions[0].prompt = "다른 내용";
    expect(validateRestudyParts([part(), altered], job).errors.join()).toMatch(
      /분할/,
    );
  });
  it("rejects unresolved references after all five parts arrive", () => {
    const ps = [1, 2, 3, 4, 5].map((n) => part(n));
    ps[4].questions[0].concept_ids = ["missing"];
    expect(validateRestudyParts(ps, job).errors.join()).toMatch(/참조/);
  });
  it("deduplicates exact questions without discarding conceptually similar wording", () => {
    const p2 = part(2);
    p2.questions[0].prompt = part().questions[0].prompt;
    const r = validateRestudyParts([part(), p2], job);
    expect(r.questions).toHaveLength(1);
    expect(r.duplicates).toHaveLength(1);
    p2.questions[0].prompt += " 조건 변형";
    expect(validateRestudyParts([part(), p2], job).questions).toHaveLength(2);
  });
  it("fingerprints preserve meaningful mathematical case and normalize whitespace", () => {
    const a = part().questions[0],
      b = { ...a, prompt: "x = 1" },
      c = { ...b, prompt: " x  =  1 " };
    expect(questionFingerprint(b)).toBe(questionFingerprint(c));
    expect(questionFingerprint(b)).not.toBe(
      questionFingerprint({ ...b, prompt: "X = 1" }),
    );
  });
  it("all five 20-question parts produce a real 100-question pool", () => {
    const ps = [1, 2, 3, 4, 5].map((n) => {
      const p = part(n);
      p.questions = Array.from({ length: 20 }, (_, i) => ({
        ...p.questions[0],
        id: `q${n}-${i}`,
        prompt: `조건 판단 ${n}-${i}`,
      }));
      return p;
    });
    const r = validateRestudyParts(ps, job);
    expect(r.errors).toEqual([]);
    expect(r.questions).toHaveLength(100);
    expect(r.complete).toBe(true);
    expect(splitCount(100)).toEqual([20, 20, 20, 20, 20]);
  });
  it("embeds the entire actual schema and registered IDs in the external prompt", () => {
    const prompt = createExternalPrompt(job, 2);
    expect(prompt).toContain("job_001");
    expect(prompt).toContain("doc_001");
    expect(prompt).toContain(JSON.stringify(RestudyJSONSchema));
    expect(prompt).toContain("현재 분할: 2");
    expect(prompt).toContain("전체 분할: 5");
  });

  it("gives problem linkage prompts actual source identities and independent generation categories", () => {
    const prompt = createExternalPrompt(
      {
        ...job,
        taskType: "problem",
        printedPageOffset: 7,
        targetQuestions: [
          {
            id: "actual-original-id",
            q_number: "47",
            pdf_page: 22,
            chapter_id: "saved-chapter",
          },
        ],
        purposeCounts: { concept: 5, practice: 5, similar: 5 },
        questionCount: 15,
        totalParts: 1,
      },
      1,
    );
    const manifest = JSON.parse(prompt.match(/작업 정보 JSON:\n([^\n]+)/)![1]);
    expect(manifest).toMatchObject({
      document_id: "doc_001",
      job_id: "job_001",
      task_type: "problem",
      part: 1,
      total_parts: 1,
      original_scope: "provided_originals",
      target_originals: [
        {
          id: "actual-original-id",
          q_number: "47",
          pdf_page: 22,
          chapter_id: "saved-chapter",
        },
      ],
      selected_pdf_pages: [22, 23],
      printed_page_offset: 7,
    });
    expect(manifest.output_rules).toMatchObject({
      kinds: ["mcq", "ox", "short", "blank"],
      purposes: ["concept", "practice", "similar"],
      levels: ["easy", "medium", "hard"],
    });
    expect(manifest.part_quotas.purposes).toEqual({
      concept: 5,
      practice: 5,
      similar: 5,
    });
    expect(prompt).toContain("problem_analyses");
    expect(prompt).toContain("source_problem");
    expect(prompt).toContain("key_point");
  });
  it("allows external PDF-wide original analysis before indexing and preserves physical-page export maps", () => {
    const prompt = createExternalPrompt(
      { ...job, method: "external", taskType: "problem", targetQuestions: [] },
      2,
    );
    const manifest = JSON.parse(prompt.match(/작업 정보 JSON:\n([^\n]+)/)![1]);
    expect(manifest.original_scope).toBe("all_selected_pdf_pages");
    expect(manifest.attachment_page_maps).toEqual({
      selected: [
        { attachment_page: 1, pdf_page: 22 },
        { attachment_page: 2, pdf_page: 23 },
      ],
      toc: [
        { attachment_page: 1, pdf_page: 3 },
        { attachment_page: 2, pdf_page: 4 },
      ],
    });
    expect(manifest.part_quotas.questions).toBe(20);
    expect(prompt).toContain("PDF에서 실제로 읽은 문제 번호");
    expect(prompt).toContain("판독할 수 없는");
    expect(prompt).toContain("JSON 코드 블록");
  });
  it("shows the actual merged original-concept links alongside generated bank questions during review", () => {
    const markup = renderToStaticMarkup(
      createElement(ContentReview, {
        content: {
          concepts: [
            { id: "concept-x", name: "실제 연결 개념", summary: "개념 정의" },
          ],
          problemAnalyses: [
            {
              q_number: "47",
              pdf_page: 22,
              concept_ids: ["concept-x"],
              key_point: "공역과 치역을 비교",
              memorize: ["공역과 치역 일치"],
              mistakes: ["조건 누락 가능성"],
            },
          ],
          questions: [part().questions[0]],
          chapters: [],
          flashcards: [],
        },
      }),
    );
    expect(markup).toContain("47번");
    expect(markup).toContain("PDF 22쪽");
    expect(markup).toContain("공역과 치역을 비교");
    expect(markup).toContain("실제 연결 개념");
    expect(markup).toContain("조건을 구별하는 문제 1");
  });
});

function jobContext() {
  const owner = "10000000-0000-4000-8000-000000000001",
    documentId = "30000000-0000-4000-8000-000000000003";
  const records: Record<string, any[]> = {
    documents: [
      {
        id: documentId,
        user_id: owner,
        title: "등록한 PDF",
        subject: "수학",
        data: {
          pageCount: 120,
          analysisRange: "22-23",
          tocRange: "3-4",
          printedPageOffset: 7,
        },
      },
    ],
    problems: [],
    document_chapters: [],
    content_jobs: [],
    content_parts: [],
  };
  const from = (table: string) => {
    let filters: Record<string, unknown> = {},
      incoming: any;
    return {
      select() {
        return this;
      },
      eq(key: string, value: unknown) {
        filters[key] = value;
        return this;
      },
      order(){return this;},
      then(resolve:any,reject:any){return this.range(0,Number.MAX_SAFE_INTEGER).then(resolve,reject);},
      limit(n:number){return this.range(0,n-1);},
      insert(value: any) {
        incoming = { id: "70000000-0000-4000-8000-000000000007", ...value };
        records[table].push(incoming);
        return this;
      },
      async single() {
        return { data: incoming, error: null };
      },
      async maybeSingle() {
        return {
          data:
            records[table]?.find((r) =>
              Object.entries(filters).every(([key, value]) => r[key] === value),
            ) || null,
          error: null,
        };
      },
      async range(a: number, b: number) {
        return {
          data: (records[table] || [])
            .filter((r) =>
              Object.entries(filters).every(([key, value]) => r[key] === value),
            )
            .slice(a, b + 1),
          error: null,
        };
      },
    };
  };
  return {
    ctx: { user: { id: owner }, db: { from }, admin: { from } },
    records,
    documentId,
  };
}
describe("original-analysis job preparation", () => {
  it('accepts the later API batches of a 1000-question bank without changing its job identity',()=>{
    const raw={...part(),part:101,total_parts:200};
    expect(parseRestudy(raw)).toMatchObject({part:101,total_parts:200});
  });
  it('preserves legacy hashes when unchanged jsonb content is reimported and retains the last question preview',async()=>{
    const {ctx,records}=jobContext(),incoming=part();
    records.content_jobs.push({id:job.id,user_id:ctx.user.id,document_id:job.documentId,data:{...job,knownChapters:incoming.chapters,knownConcepts:incoming.concepts}});
    const reordered=Object.fromEntries(Object.entries(incoming).reverse());
    records.content_parts.push({job_id:job.id,user_id:ctx.user.id,part:1,total_parts:5,raw:reordered,content_hash:'legacy-hash'});
    const preview=await previewPart(ctx,job.id,incoming);
    expect(preview.hash).toBe('legacy-hash');expect(preview.preview.valid).toBe(true);
    records.content_parts.push({job_id:job.id,user_id:ctx.user.id,part:2,total_parts:5,raw:{...part(2),questions:[]},content_hash:'another'});
    const summary=await jobView(ctx,job.id);
    expect(summary.preparedQuestions).toBe(1);expect(summary.preparedPreview[0]).toMatchObject({part:1,prompt:incoming.questions[0].prompt,options:incoming.questions[0].options,source_pages:[22]});
  });
  it('prepares all-in-one API content in small validated units without crop targets',async()=>{
   const {ctx,documentId}=jobContext();
   const created=await createJob(ctx,{documentId,method:'api',taskType:'complete',questionCount:12,purposeCounts:{concept:4,practice:4,similar:4}});
   expect(created).toMatchObject({taskType:'complete',method:'api',partSize:5,totalParts:3,partCounts:[4,4,4]});
   expect(created.apiStatus).toMatchObject({state:'not_started',importedQuestions:0});
   const prompt=createExternalPrompt(created,1);expect(prompt).toContain('통합 준비');expect(prompt).toContain('problem_analyses');expect(prompt).toContain('flashcards');
  });
  it("prepares external PDF analysis in one complete package regardless of question count", async () => {
    const { ctx, documentId } = jobContext();
    const created = await createJob(ctx, {
      documentId,
      method: "external",
      taskType: "problem",
      questionCount: 100,
      purposeCounts: { concept: 20, practice: 40, similar: 40 },
    });
    expect(created).toMatchObject({
      documentId,
      method: "external",
      taskType: "problem",
      targetQuestions: [],
      printedPageOffset: 7,
      totalParts: 1,
      partSize: 100,
      partCounts: [100],
      purposeCounts: { concept: 20, practice: 40, similar: 40 },
    });
    const prompt=createExternalPrompt(created,1);
    expect(prompt).toContain('part=1, total_parts=1');
    expect(prompt).not.toContain('100문제는 기본 20문제씩');
    expect(prompt).not.toContain('다음 분할을 요청하세요');
  });
  it('prepares concept-only textbook content without requiring generated questions or source problem numbers',async()=>{
    const {ctx,documentId}=jobContext();
    const created=await createJob(ctx,{documentId,method:'external',taskType:'concepts'});
    expect(created).toMatchObject({taskType:'concepts',questionCount:0,totalParts:1,partCounts:[0],purposeCounts:{concept:0,practice:0,similar:0}});
    expect(createExternalPrompt(created,1)).toContain('문제 번호를 찾거나 원본 문제를 분석하지');
  });
  it("rejects a problem API job with no original crop targets instead of creating a text-only request", async () => {
    const { ctx, records, documentId } = jobContext();
    await expect(
      createJob(ctx, {
        documentId,
        method: "api",
        taskType: "problem",
        questionCount: 5,
      }),
    ).rejects.toThrow();
    expect(records.content_jobs).toHaveLength(0);
  });
  it("rejects conflicting purpose totals before saving a job", async () => {
    const { ctx, records, documentId } = jobContext();
    await expect(
      createJob(ctx, {
        documentId,
        method: "external",
        taskType: "problem",
        questionCount: 5,
        purposeCounts: { concept: 5, similar: 5 },
      }),
    ).rejects.toThrow();
    expect(records.content_jobs).toHaveLength(0);
  });
});
