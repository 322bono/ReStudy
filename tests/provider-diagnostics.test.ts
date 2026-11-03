import { expect, test } from 'vitest';
import { requestDiagnostic, generate, checkConnection, ProviderError, geminiSchema } from '../supabase/functions/_shared/ai/providers';
import { RestudySchema, RestudyJSONSchema } from '../src/domain/restudy';
const model = 'gemma-4-26b-a4b-it';
const response = (content: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }] }));

test('standard generation sends one complete contract without duplicate tool schema', async () => {
  let request: any;
  const transport = (async (_url, init) => { request = JSON.parse(String(init?.body)); return response('{}'); }) as typeof fetch;
  expect((await generate('gemini', model, 'test-only', { kind: 'restudy_v1', prompt: 'one-contract' }, transport, Date.now())).raw).toEqual({});
  expect(request.tools).toBeUndefined(); expect(request.contents[0].parts[0].text).toBe('one-contract');
  expect(request.systemInstruction.parts[0].text).toContain('restudy.v1');
  expect(request.systemInstruction.parts[0].text).not.toMatch(/concept_keys|multiple_choice|option id|submit_result/);
});
test('Gemma connection verification reads metadata without generating content', async () => {
  const calls: any[] = [];
  const transport = (async (url, init) => { calls.push({ url: String(url), method: init?.method }); return new Response(JSON.stringify({ name: `models/${model}`, supportedGenerationMethods: ['generateContent'] })); }) as typeof fetch;
  await expect(checkConnection('gemini', model, 'test-only', transport)).resolves.toBeUndefined();
  expect(calls).toEqual([{ url: `https://generativelanguage.googleapis.com/v1beta/models/${model}`, method: undefined }]);
});
test('diagnostics retain bounded counts and finish categories without private text or thoughts', async () => {
  const transport = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'private-reasoning', thought: true }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { candidatesTokenCount: 8192, thoughtsTokenCount: 8192 } }))) as typeof fetch;
  const error = await generate('gemini', model, 'private-key', { kind: 'restudy_v1', prompt: 'private-prompt' }, transport, Date.now()).catch(e => e);
  expect(error.responseMetadata).toMatchObject({ finish_reason: 'MAX_TOKENS', content_chars: 0, reasoning_chars: 17, usage: { candidatesTokenCount: 8192, thoughtsTokenCount: 8192 } });
  expect(JSON.stringify(error)).not.toMatch(/private/);
});
test('provider schema preserves supported constraints and application validation enforces conditional answers', () => {
  const schema = geminiSchema(RestudyJSONSchema);
  expect(schema.properties.schema_version.enum).toEqual(['restudy.v1']); expect(schema.properties.questions.items.allOf).toBeUndefined();
  expect(JSON.stringify(schema)).not.toMatch(/allOf|propertyNames|exclusiveMinimum|\$schema/);
  const bad = { schema_version: 'restudy.v1', document_id: 'd', job_id: 'j', part: 1, total_parts: 1, chapters: [], concepts: [], problem_analyses: [], flashcards: [], similarities: [], questions: [{ id: 'q', chapter_id: 'c', concept_ids: ['x'], kind: 'mcq', purpose: 'concept', level: 'easy', source_problem: null, prompt: '질문', options: ['1', '2', '3', '4'], answer: 'E', accepted_answers: [], explanation: '설명', option_explanations: { A: '설명', B: '설명', C: '설명', D: '설명' }, source_pages: [1] }] };
  const parsed=RestudySchema.safeParse(bad);
  expect(parsed.success).toBe(false);
  if(!parsed.success)expect(parsed.error.issues.map(issue=>issue.path.join('.'))).toContain('questions.0.answer');
});
test('request failure diagnostics expose fixed categories without upstream secrets', async () => {
  const payload = { error: { message: 'Invalid schema allOf; key=private-value and source=private-text' } };
  expect(requestDiagnostic(payload)).toBe('schema_rejected');
  const transport = (async () => new Response(JSON.stringify(payload), { status: 400 })) as typeof fetch;
  try { await generate('gemini', model, 'private-key', { kind: 'restudy_v1', prompt: 'private-source' }, transport, Date.now()); throw Error('expected rejection'); }
  catch (error) { expect(error).toBeInstanceOf(ProviderError); expect(error).toMatchObject({ code: 'request_invalid', diagnostic: 'schema_rejected', status: 400 }); expect(JSON.stringify(error)).not.toMatch(/private/); }
  expect(requestDiagnostic({ error: { message: 'Unknown name "store"' } })).toBe('store_rejected');
  expect(requestDiagnostic({ error: { message: 'private arbitrary message' } })).toBe('invalid_argument');
});
test('only removes a complete JSON fence or BOM without repairing incomplete output', async () => {
  const transport = (content: string) => (async () => response(content)) as typeof fetch;
  const input = { kind: 'restudy_v1' as const, prompt: 'fixture' };
  expect((await generate('gemini', model, 'test-only', input, transport('\uFEFF```json\n{"chapters":[]}\n```'), Date.now())).raw).toEqual({ chapters: [] });
  await expect(generate('gemini', model, 'test-only', input, transport('Result: {"chapters":[]}'), Date.now())).rejects.toMatchObject({ code: 'invalid_response', diagnostic: 'json_invalid' });
});
test('classifies a response body timeout as a timeout rather than invalid JSON', async () => {
  const transport = (async () => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('private upstream message', 'TimeoutError')); } }))) as typeof fetch;
  await expect(generate('gemini', model, 'test-only', { kind: 'restudy_v1', prompt: 'fixture' }, transport, Date.now())).rejects.toMatchObject({ code: 'timeout' });
});
