import {
  normalize,
  questionFingerprint,
  type StandardJob,
  validateRestudyParts,
} from "./restudy.ts";
type Validated = ReturnType<typeof validateRestudyParts>;
export type ConceptBindings=Record<string,{key:string;subject:string;major:string;minor:string}>;
async function hash(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function compileRestudy(merged: Validated, job: StandardJob,bindings:ConceptBindings={}) {
  if (!merged.valid)
    throw new Error("검증 오류가 있는 콘텐츠는 저장할 수 없습니다.");
  if (!merged.ready)
    return {
      ready: false,
      chapters: [],
      concepts: [],
      questions: [],
      flashcards: [],
      analyses: [],
      similarities: [],
    };
  const chapterMap = new Map(merged.chapters.map((c) => [c.id, c])),
    conceptMap = new Map(merged.concepts.map((c) => [c.id, c]));
  const conceptKey = (id: string) => {
    if(bindings[id]?.key)return bindings[id].key;
    const c = conceptMap.get(id)!;
    return normalize(
      [job.subject, chapterMap.get(c.chapter_id)!.title, "", c.name].join("|"),
    ).toLowerCase();
  };
  const sources = (pages: number[]) =>
    pages.map((page) => ({ materialId: job.documentId, page }));
  const conceptSources = (id: string) => {
    const c = conceptMap.get(id)!,
      ch = chapterMap.get(c.chapter_id)!;
    return sources(
      job.selectedPages.filter((p) => p >= ch.start_page && p <= ch.end_page),
    );
  };
  return {
    ready: true,
    chapters: merged.chapters.map((c) => ({
      ...c,
      externalId: c.id,
      key: normalize(`${c.title}|${c.start_page}|${c.end_page}`),
      data: {
        externalId: c.id,
        importJobId: job.id,
        evidence:
          job.taskType === "toc"
            ? "toc_only"
            : job.taskType === "bank" && job.method !== "external"
              ? "saved_concepts"
              : "selected_pages",
      },
    })),
    concepts: merged.concepts.map((c) => ({
      ...c,
      externalId: c.id,
      key: conceptKey(c.id),
      subject: bindings[c.id]?.subject??job.subject,
      major: bindings[c.id]?.major??chapterMap.get(c.chapter_id)!.title,
      minor: bindings[c.id]?.minor??"",
      data: {
        name: c.name,
        subject: bindings[c.id]?.subject??job.subject,
        major: bindings[c.id]?.major??chapterMap.get(c.chapter_id)!.title,
        minor: bindings[c.id]?.minor??"",
        definition: c.summary,
        properties: [...c.formulas, ...c.memorize],
        formulas: c.formulas,
        memorize: c.memorize,
        pitfalls: c.pitfalls,
        misconceptions: c.pitfalls.map((label, i) => ({
          id: `pitfall-${i + 1}`,
          label,
          correction: "",
        })),
        sources: conceptSources(c.id),
        sourceGranularity: "chapter",
        importJobId: job.id,
        externalId: c.id,
        evidence:
          bindings[c.id] ? "saved_concepts" : job.taskType === "toc"
            ? "toc_only"
            : job.taskType === "bank" && job.method !== "external"
              ? "saved_concepts"
              : "selected_pages",
      },
    })),
    questions: await Promise.all(
      merged.questions.map(async (q) => {
        const choices =
            q.kind === "mcq" ? q.options : q.kind === "ox" ? ["O", "X"] : [],
          answer =
            q.kind === "mcq"
              ? q.options[q.answer.charCodeAt(0) - 65]
              : q.answer;
        const feedback = Object.fromEntries(
          choices.map((choice, index) => [
            choice,
            {
              explanation:
                q.kind === "mcq"
                  ? q.option_explanations["ABCDE"[index]]
                  : q.explanation,
              misconceptionTag: "",
            },
          ]),
        );
        return {
          externalId: q.id,
          chapter_id: q.chapter_id,
          concept_ids: q.concept_ids,
          purpose: q.purpose,
          source_problem: q.source_problem,
          fingerprint: await hash(
            questionFingerprint(q, q.concept_ids.map(conceptKey)),
          ),
          data: {
            type: (
              {
                mcq: "객관식",
                ox: "OX",
                short: "단답형",
                blank: "빈칸",
              } as const
            )[q.kind],
            kind: q.kind,
            purpose: q.purpose,
            level: q.level,
            prompt: q.prompt,
            choices,
            answer,
            acceptedAnswers: [...new Set([answer, ...q.accepted_answers])],
            explanation: q.explanation,
            choiceFeedback: feedback,
            correction: q.explanation,
            difficulty: (
              { easy: "기본", medium: "보통", hard: "심화" } as const
            )[q.level],
            modes: q.purpose === "concept" ? ["check", "quiz"] : ["quiz"],
            sources: sources(q.source_pages),
            sourceProblem: q.source_problem,
            importJobId: job.id,
            externalId: q.id,
            standardQuestion: q,
          },
        };
      }),
    ),
    flashcards: await Promise.all(
      merged.flashcards.map(async (c) => ({
        externalId: c.id,
        concept_id: c.concept_id,
        fingerprint: await hash(
          JSON.stringify([
            "flashcard",
            normalize(c.front),
            normalize(c.back),
            conceptKey(c.concept_id),
          ]),
        ),
        data: {
          type: "플래시카드",
          kind: "short",
          purpose: "concept",
          prompt: c.front,
          choices: [],
          answer: c.back,
          acceptedAnswers: [c.back],
          explanation: c.back,
          choiceFeedback: {},
          correction: "",
          difficulty: "기본",
          modes: ["memory"],
          sources: conceptSources(c.concept_id),
          sourceGranularity: "chapter",
          importJobId: job.id,
          externalId: c.id,
        },
      })),
    ),
    analyses: merged.problemAnalyses,
    similarities: await Promise.all(
      merged.similarities.map(async (s) => ({
        ...s,
        fingerprint: await hash(JSON.stringify(s)),
      })),
    ),
  };
}
