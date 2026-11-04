import {parseRestudy,RestudySchema,RestudyJSONSchema}from'../../../../src/domain/restudy.ts';
export type TaskKind = "analyze_problem" | "generate_questions" | "generate_material" | "restudy_v1" | "wrong_review";
export type Json = Record<string, any>;
const schemaFields=new Set<string>();
export function unreadableWrongReview(raw: unknown): boolean {
  if (raw === null) return true;
  if (!raw || typeof raw !== "object" || !("solution" in raw)) return false;
  const solution = raw.solution as Json | null;
  if (solution === null || solution?.answer === null) return true;
  return typeof solution?.answer === "string" &&
    /^(?:null|unknown|n\/?a|판독\s*불가|확인\s*불가|알\s*수\s*없음|답을\s*구할\s*수\s*없음)[.。]?$/i.test(solution.answer.trim());
}
function collectSchemaFields(value:any){if(!value||typeof value!=='object')return;for(const [key,entry]of Object.entries(value)){if(key==='properties'&&entry&&typeof entry==='object')for(const field of Object.keys(entry))schemaFields.add(field);if(Array.isArray(entry))entry.forEach(collectSchemaFields);else collectSchemaFields(entry);}}
collectSchemaFields(RestudyJSONSchema);
/** Schema field names, array indices and counts only; never provider values,
 * record keys, issue messages, expected literals or source identifiers. */
export function validationMetadata(kind:TaskKind,raw:unknown,count?:number):Json{
 const value=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Json:{};
 const counts=Object.fromEntries(['chapters','concepts','problem_analyses','questions','flashcards','similarities'].map(key=>[key,Array.isArray(value[key])?Math.min(value[key].length,1000000):-1]));
 const checked=kind==='restudy_v1'?RestudySchema.safeParse(raw):null;
 const codes=new Set(['invalid_type','too_big','too_small','invalid_format','not_multiple_of','unrecognized_keys','invalid_union','invalid_key','invalid_element','invalid_value','custom']);
 return{expected_questions:count??null,counts,...(checked?{schema_valid:checked.success,issues:checked.success?[]:checked.error.issues.slice(0,12).map(issue=>({path:issue.path.map(part=>typeof part==='number'?Math.max(0,Math.min(1000000,part)):typeof part==='string'&&schemaFields.has(part)?part:'*').join('.'),code:codes.has(issue.code)?issue.code:'other'}))}:{})};
}
function invalid(): never { throw new Error("invalid_ai_output"); }
function object(value: unknown): Json { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Json; }
function text(value: unknown, max = 6000): string { if (typeof value !== "string" || !value.trim() || value.length > max) invalid(); return value.trim(); }
function list(value: unknown, max = 30): unknown[] { if (!Array.isArray(value) || value.length > max) invalid(); return value; }
function strings(value: unknown, max = 30): string[] { return list(value, max).map((value) => text(value, 1500)); }
function citations(value: unknown, sourceIds: string[]): string[] {
  const ids = strings(value, 20); if (!ids.length || ids.some((id) => !sourceIds.includes(id))) invalid(); return [...new Set(ids)];
}
export function conceptKey(value: {subject: string; major: string; minor: string; name: string}): string {
  return [value.subject, value.major, value.minor, value.name].map((part) => part.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US")).join("|");
}
// A bounded arithmetic parser; never evaluates JavaScript or model-provided code.
function arithmetic(expression: string): number {
  if (expression.length > 120 || !/^[\d\s.+*/()\-]+$/.test(expression)) invalid();
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)|[+*/()\-]/g) ?? []; let index = 0;
  function factor(): number {
    const token = tokens[index++];
    if (token === "+") return factor(); if (token === "-") return -factor();
    if (token === "(") { const value = sum(); if (tokens[index++] !== ")") invalid(); return value; }
    if (!token || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) invalid(); return Number(token);
  }
  function product(): number { let value = factor(); while (["*", "/"].includes(tokens[index])) { const op = tokens[index++]; const next = factor(); value = op === "*" ? value * next : value / next; } return value; }
  function sum(): number { let value = product(); while (["+", "-"].includes(tokens[index])) { const op = tokens[index++]; const next = product(); value = op === "+" ? value + next : value - next; } return value; }
  const value = sum(); if (index !== tokens.length || !Number.isFinite(value)) invalid(); return value;
}
export function validateOutput(kind: TaskKind, raw: unknown, sourceIds: string[], count = 3): Json {
  if(kind==='restudy_v1'){const parsed=parseRestudy(raw);if(parsed.questions.length!==count)invalid();return parsed;}
  const value = object(raw);
  if (kind === "wrong_review") {
    if (unreadableWrongReview(value)) invalid();
    const solution = object(value.solution);
    const concepts = list(value.concepts, 5).map((entry) => {
      const concept = object(entry);
      return { name: text(concept.name, 150), summary: text(concept.summary, 1200) };
    });
    const memorize = strings(value.memorize, 8);
    const questions = list(value.questions, 3).map((entry) => {
      const question = object(entry);
      return { prompt: text(question.prompt, 1500), answer: text(question.answer, 600), explanation: text(question.explanation, 1500) };
    });
    if (!concepts.length || !memorize.length || !questions.length) invalid();
    return {
      solution: { answer: text(solution.answer, 600), explanation: text(solution.explanation, 3500) },
      concepts, memorize, questions,
    };
  }
  if (kind === "generate_material") {
    const concepts = validateConcepts(value.concepts, sourceIds);
    const questions = validateOutput("generate_questions", { questions: value.questions }, sourceIds, count).questions.map((question: Json, index: number) => {
      const key = text(object(value.questions[index]).concept_key, 600); const concept = concepts.find((concept) => concept.key === key);
      if (!concept || question.source_citations.some((id: string) => !concept.source_citations.includes(id))) invalid();
      return { ...question, concept_key: key };
    });
    return { concepts, questions, review_status: "needs_review" };
  }
  if (kind === "generate_questions") {
    const questions = list(value.questions, 5); if (!questions.length || questions.length !== count) invalid();
    const seenPrompts = new Set<string>();
    return { review_status: "needs_review", questions: questions.map((raw) => {
      const q = object(raw); const type = text(q.type, 50); const difficulty = text(q.difficulty, 20);
      if (!["multiple_choice", "true_false", "fill_blank", "short_answer", "free_response", "flashcard", "masked_sentence", "application", "data_interpretation", "condition_judgment", "statement_judgment"].includes(type) || !["easy", "medium", "hard"].includes(difficulty)) invalid();
      const prompt = text(q.prompt); if (seenPrompts.has(prompt)) invalid(); seenPrompts.add(prompt);
      const options = list(q.options, 5).map((raw) => { const option = object(raw); return { id: text(option.id, 20), text: text(option.text, 2000), explanation: text(option.explanation, 2500) }; });
      if (new Set(options.map((o) => o.id)).size !== options.length || new Set(options.map((o) => o.text.normalize("NFKC").replace(/\s/g, ""))).size !== options.length) invalid();
      if (type === "multiple_choice" && options.length !== 5 || type === "true_false" && options.length !== 2 || options.length === 1) invalid();
      if (options.length && type !== "true_false" && options.length !== 5) invalid();
      if (["fill_blank", "short_answer", "free_response", "flashcard", "masked_sentence"].includes(type) && options.length) invalid();
      const answer = text(q.answer, 2000); if (options.length && !options.some((option) => option.id === answer)) invalid();
      let verification;
      if (q.verification !== undefined && q.verification !== null) {
        const proof = object(q.verification); const expression = text(proof.expression, 120); const result = arithmetic(expression);
        if (typeof proof.expected !== "number" || !Number.isFinite(proof.expected) || Math.abs(proof.expected - result) > 1e-9) invalid();
        const answerText = options.length ? options.find((option) => option.id === answer)!.text : answer;
        if (Number(answerText) !== result) invalid(); verification = { expression, expected: result, passed: true };
      }
      return { type, difficulty, prompt, options, answer, explanation: text(q.explanation), misconception_tags: strings(q.misconception_tags, 10), source_citations: citations(q.source_citations, sourceIds), ...(verification ? { verification } : {}) };
    }) };
  }
  const concepts = validateConcepts(value.concepts, sourceIds);
  const analyses = list(value.analyses, 3).map((raw) => {
    const p = object(raw); const id = text(p.problem_id, 100); const keys = strings(p.concept_keys, 20);
    if (!sourceIds.includes(id) || !keys.length || keys.some((key) => !concepts.some((c) => c.key === key))) invalid();
    if (typeof p.confidence !== "number" || p.confidence < 0 || p.confidence > 1) invalid();
    return { problem_id: id, concept_keys: keys, problem_type: text(p.problem_type, 200), conditions: strings(p.conditions), misconceptions: strings(p.misconceptions), confidence: p.confidence };
  });
  if (analyses.length !== sourceIds.length || new Set(analyses.map((p) => p.problem_id)).size !== analyses.length) invalid();
  return { concepts, analyses, review_status: "needs_review" };
}
function validateConcepts(raw: unknown, sourceIds: string[]) {
  const concepts = list(raw, 20).map((raw) => {
    const c = object(raw); const entry = { subject: text(c.subject, 100), major: typeof c.major === "string" ? c.major.slice(0, 100).trim() : "", minor: typeof c.minor === "string" ? c.minor.slice(0, 100).trim() : "", name: text(c.name, 200), definition: text(c.definition), properties: strings(c.properties), misconceptions: list(c.misconceptions, 20).map((raw) => { const misconception = object(raw); return { label: text(misconception.label, 1500), correction: text(misconception.correction, 2500) }; }), prerequisites: strings(c.prerequisites), source_citations: citations(c.source_citations, sourceIds) };
    return { ...entry, key: conceptKey(entry) };
  });
  if (!concepts.length || new Set(concepts.map((c) => c.key)).size !== concepts.length) invalid();
  return concepts;
}
const stringSchema = { type: "string" }; const stringsSchema = { type: "array", items: stringSchema };
function schema(properties: Json, required = Object.keys(properties)): Json { return { type: "object", properties, required, additionalProperties: false }; }
export function outputSchema(kind: TaskKind): Json {
  if(kind==='restudy_v1')return RestudyJSONSchema;
  if (kind === "wrong_review") return schema({
    solution: schema({ answer: stringSchema, explanation: stringSchema }),
    concepts: { type: "array", minItems: 1, maxItems: 5, items: schema({ name: stringSchema, summary: stringSchema }) },
    memorize: { ...stringsSchema, minItems: 1, maxItems: 8 },
    questions: { type: "array", minItems: 1, maxItems: 3, items: schema({ prompt: stringSchema, answer: stringSchema, explanation: stringSchema }) },
  });
  if (kind === "generate_material") {
    const questions = outputSchema("generate_questions").properties.questions;
    questions.items.properties.concept_key = stringSchema; questions.items.required.push("concept_key");
    return schema({ concepts: outputSchema("analyze_problem").properties.concepts, questions });
  }
  if (kind === "generate_questions") {
    const properties = { type: { type: "string", enum: ["multiple_choice", "true_false", "fill_blank", "short_answer", "free_response", "flashcard", "masked_sentence", "application", "data_interpretation", "condition_judgment", "statement_judgment"] }, difficulty: { type: "string", enum: ["easy", "medium", "hard"] }, prompt: stringSchema, options: { type: "array", items: schema({ id: stringSchema, text: stringSchema, explanation: stringSchema }) }, answer: stringSchema, explanation: stringSchema, misconception_tags: stringsSchema, source_citations: stringsSchema, verification: schema({ expression: stringSchema, expected: { type: "number" } }) };
    return schema({ questions: { type: "array", minItems: 1, maxItems: 5, items: schema(properties, Object.keys(properties).filter((key) => key !== "verification")) } });
  }
  return schema({ concepts: { type: "array", items: schema({ subject: stringSchema, major: stringSchema, minor: stringSchema, name: stringSchema, definition: stringSchema, properties: stringsSchema, misconceptions: { type: "array", items: schema({ label: stringSchema, correction: stringSchema }) }, prerequisites: stringsSchema, source_citations: stringsSchema }) }, analyses: { type: "array", items: schema({ problem_id: stringSchema, concept_keys: stringsSchema, problem_type: stringSchema, conditions: stringsSchema, misconceptions: stringsSchema, confidence: { type: "number" } }) } });
}
