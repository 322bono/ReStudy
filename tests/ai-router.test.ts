import { describe, expect, it, vi } from 'vitest';
import { runTask, type ProviderState } from '../supabase/functions/_shared/ai/router.ts';

// Transport-only fixtures: no live API calls and no user database writes.
const primary = 'gemma-4-26b-a4b-it', fallback = 'gemma-4-31b-it';
const output = { questions: [{ type: 'short_answer', difficulty: 'easy', prompt: '테스트', answer: '2', explanation: '테스트 해설', options: [], misconception_tags: [], source_citations: ['source-a'] }] };
const state = (): ProviderState => ({ provider: 'gemini', enabled: true, model: primary, access: 'free_confirmed', status: 'connected', selectedModels: [primary, fallback] });
const input = { kind: 'generate_questions' as const, prompt: '테스트 자료', sourceIds: ['source-a'], count: 1 };
const response = (value: unknown = output) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 20 } }));
function context(rotationIndex = 0, providers = [state()], transport?: typeof fetch) {
  const events: any[] = [];
  return { rotationIndex, providers, mode: 'gemini_only' as const, allowPaid: false, getKey: async () => 'test-only-key', now: () => 1000000, sleep: async (_ms: number) => {}, updateProvider: async (_p: string, data: unknown) => { events.push(data); }, log: async (data: unknown) => { events.push(data); }, fetch: transport ?? (async () => response()) as typeof fetch, events };
}

describe('durable no-charge routing', () => {
  it('preserves a full inference window and defers fallback after a full timeout', async () => {
    let clock = 1000000; const seen: string[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const ctx = context(0, ['a', 'b', 'c'].map(credentialId => ({ ...state(), credentialId })), (async url => { seen.push(String(url)); clock += 110000; throw new DOMException('timeout', 'TimeoutError'); }) as typeof fetch); ctx.now = () => clock;
    try {
      expect(await runTask(input, ctx)).toMatchObject({ status: 'paused', lastError: 'timeout' });
      expect(timeout).toHaveBeenCalledWith(110000); expect(seen).toHaveLength(1);
      expect(ctx.events).toContainEqual(expect.objectContaining({ last_error: 'timeout', cooldown_until: new Date(1410000).toISOString() }));
    } finally { timeout.mockRestore(); }
  });
  it('reserves shared provider quota before each request including retries', async () => {
    let clock = 1000000, reservations = 0, calls = 0; const waits: number[] = [];
    const ctx = { ...context(0, [{ ...state(), credentialId: 'a', quotaGroup: 'account' }], (async () => ++calls === 1 ? new Response('{}', { status: 503 }) : response()) as typeof fetch), reserveRequest: async (provider: string, group: string) => { expect(provider).toBe('gemini'); expect(group).toBe('account'); return ++reservations === 2 ? { granted: false, retryAt: clock + 500 } : { granted: true }; } };
    ctx.now = () => clock; ctx.sleep = async ms => { clock += ms; waits.push(ms); };
    expect(await runTask(input, ctx)).toMatchObject({ status: 'succeeded' });
    expect(calls).toBe(2); expect(reservations).toBe(3); expect(waits).toEqual([1000, 500]);
  });
  it('uses the second allowed model after an inaccessible primary', async () => {
    const seen: string[] = [];
    const ctx = context(0, [state()], (async url => { seen.push(String(url)); return seen.length === 1 ? new Response('{}', { status: 404 }) : response(); }) as typeof fetch);
    expect(await runTask(input, ctx)).toMatchObject({ status: 'succeeded', model: fallback });
    expect(seen[0]).toContain(primary); expect(seen[1]).toContain(fallback);
  });
  it('does not hop across keys sharing an exhausted project quota', async () => {
    let calls = 0;
    const slots = ['a', 'b'].map(credentialId => ({ ...state(), credentialId, quotaGroup: 'shared' }));
    const ctx = context(0, slots, (async () => { calls++; return new Response('{}', { status: 429 }); }) as typeof fetch);
    expect(await runTask(input, ctx)).toMatchObject({ status: 'paused' }); expect(calls).toBe(1);
  });
  it('treats an explicitly empty model pool as disabled', async () => {
    expect(await runTask(input, context(0, [{ ...state(), selectedModels: [] }]))).toMatchObject({ status: 'paused', reason: 'no_available_provider' });
  });
  it('switches models after a timeout without immediately retrying that model', async () => {
    let calls = 0;
    const ctx = context(0, [state()], (async () => { if (++calls === 1) throw new DOMException('timeout', 'TimeoutError'); return response(); }) as typeof fetch);
    expect(await runTask(input, ctx)).toMatchObject({ status: 'succeeded', model: fallback }); expect(calls).toBe(2);
  });
  it('tries the fallback only when the provider identifies a per-model quota', async () => {
    let calls = 0;
    const ctx = context(0, [state()], (async () => ++calls === 1 ? new Response(JSON.stringify({ error: { details: [{ violations: [{ quotaDimensions: { model: primary } }] }] } }), { status: 429 }) : response()) as typeof fetch);
    expect(await runTask(input, ctx)).toMatchObject({ status: 'succeeded', model: fallback }); expect(calls).toBe(2);
  });
  it('rotates credentials while keeping the smaller allowed model first', async () => {
    const keys: string[] = [];
    const slots = ['a', 'b', 'c', 'd'].map(credentialId => ({ ...state(), credentialId, selectedModels: [fallback, primary] }));
    for (const rotationIndex of [0, 2, 4, 6]) {
      const ctx = context(rotationIndex, slots); ctx.getKey = async (_provider?: string, credentialId?: string) => { keys.push(credentialId!); return 'test-only-key'; };
      expect(await runTask(input, ctx)).toMatchObject({ status: 'succeeded', model: primary });
    }
    expect(keys).toEqual(['a', 'b', 'c', 'd']);
  });
  it('shares timeout health across one account group without blocking another group', async () => {
    const first = { ...state(), credentialId: 'a', quotaGroup: 'account' };
    const unhealthy = { ...first, credentialId: 'b', modelStates: { [primary]: { last_error: 'timeout', cooldown_until: new Date(1300000).toISOString() } } };
    expect(await runTask(input, context(0, [first, unhealthy]))).toMatchObject({ status: 'succeeded', model: fallback });
    expect(await runTask(input, context(0, [first, { ...unhealthy, quotaGroup: 'other' }]))).toMatchObject({ status: 'succeeded', model: primary });
  });
  it('sends saved images only to an allowed image-capable model', async () => {
    expect(await runTask({ ...input, images: [{ mimeType: 'image/png', data: 'dGVzdA==' }] }, context())).toMatchObject({ status: 'succeeded', provider: 'gemini', model: primary });
  });
  it('uses no-charge-only models without treating a billing attestation as proof', async () => {
    for (const access of ['unknown', 'paid', 'free_confirmed'] as const) expect(await runTask(input, context(0, [{ ...state(), access }]))).toMatchObject({ status: 'succeeded', model: primary });
  });
  it('honors Retry-After without logging provider response secrets', async () => {
    const ctx = context(0, [state()], (async () => new Response('secret upstream body test-only-key', { status: 429, headers: { 'Retry-After': '60' } })) as typeof fetch);
    expect(await runTask(input, ctx)).toMatchObject({ status: 'paused', retryAt: 1060000 });
    expect(ctx.events).toContainEqual(expect.objectContaining({ cooldown_until: new Date(1060000).toISOString(), last_error: 'rate_limited' }));
    expect(JSON.stringify(ctx.events)).not.toContain('test-only-key');
  });
  it('disables invalid credentials and preserves a job when every key fails', async () => {
    const ctx = context(0, ['a', 'b'].map(credentialId => ({ ...state(), credentialId })), (async () => new Response('test-only-key', { status: 401 })) as typeof fetch);
    expect(await runTask(input, ctx)).toMatchObject({ status: 'paused', reason: 'all_providers_failed' });
    expect(ctx.events.filter(value => value.status === 'auth_error')).toHaveLength(2);
  });
  it('retries server failures once with backoff before using the fallback', async () => {
    const seen: string[] = [], waits: number[] = [];
    const ctx = context(0, [state()], (async url => { seen.push(String(url)); return String(url).includes(primary) ? new Response('upstream', { status: 503 }) : response(); }) as typeof fetch);
    ctx.sleep = async ms => { waits.push(ms); };
    expect(await runTask(input, ctx)).toMatchObject({ status: 'succeeded', model: fallback });
    expect(seen.filter(url => url.includes(primary))).toHaveLength(2); expect(waits).toEqual([1000]);
  });
  it('does not accept structurally invalid or truncated provider output', async () => {
    const ctx = context(0, [state()], (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'MAX_TOKENS' }] }))) as typeof fetch);
    expect(await runTask(input, ctx)).toMatchObject({ status: 'paused', reason: 'all_providers_failed' });
  });
  it('logs schema paths and counts without logging malformed content or thoughts', async () => {
    const malformed = { schema_version: 'restudy.v1', document_id: 'private-document', job_id: 'private-job', part: 1, total_parts: 1, chapters: [], concepts: [], problem_analyses: [], flashcards: [], similarities: [], questions: [{ prompt: 'private-prompt', answer: 'private-answer' }] };
    const ctx = context(0, [state()], (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'private-reasoning', thought: true }, { text: JSON.stringify(malformed) }] }, finishReason: 'STOP' }] }))) as typeof fetch);
    expect(await runTask({ ...input, kind: 'restudy_v1' }, ctx)).toMatchObject({ status: 'paused' });
    const failure = ctx.events.find(event => event.success === false);
    expect(failure.response_metadata).toMatchObject({ finish_reason: 'STOP', reasoning_chars: 17, schema: { expected_questions: 1, counts: { questions: 1 }, issues: expect.arrayContaining([expect.objectContaining({ path: 'questions.0.id', code: 'invalid_type' })]) } });
    expect(JSON.stringify(ctx.events)).not.toMatch(/private-document|private-job|private-prompt|private-answer|private-reasoning/);
  });
  it('does not issue another inference if persisting a successful call fails', async () => {
    let calls = 0; const ctx = context(0, [state()], (async () => { calls++; return response(); }) as typeof fetch);
    ctx.updateProvider = async () => { throw Error('database offline'); };
    await expect(runTask(input, ctx)).rejects.toThrow(); expect(calls).toBe(1);
  });
  it('honors a selected allowed role model while retaining fallback', async () => {
    const ctx = { ...context(), preferredProvider: 'gemini' as const, preferredModel: fallback };
    expect(await runTask(input, ctx)).toMatchObject({ status: 'succeeded', model: fallback });
  });
  it('rejects generation that ignores requested type or difficulty', async () => {
    expect(await runTask({ ...input, types: ['multiple_choice'], difficulty: 'easy' }, context())).toMatchObject({ status: 'paused', reason: 'all_providers_failed' });
    expect(await runTask({ ...input, types: ['short_answer'], difficulty: 'hard' }, context())).toMatchObject({ status: 'paused', reason: 'all_providers_failed' });
  });
});
