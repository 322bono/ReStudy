import { expect, test } from 'vitest';
import { sanitizeSettings } from '../supabase/functions/_shared/ai/settings';
import { publicSlot } from '../supabase/functions/_shared/ai/key-slots';
import { generate, checkConnection } from '../supabase/functions/_shared/ai/providers';
import { runTask } from '../supabase/functions/_shared/ai/router';

test('a forged paid setting cannot restore paid routing; Flash preferences still require server verification', () => {
  expect(sanitizeSettings({ allow_paid: true, mode: 'nvidia_only', modelRoles: { generation: { provider: 'nvidia', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b' }, vision: { provider: 'gemini', model: 'gemma-4-31b-it' } } })).toMatchObject({
    allow_paid: false, mode: 'gemini_only', modelRoles: { vision: { provider: 'gemini', model: 'gemma-4-31b-it' } },
  });
  expect(sanitizeSettings({ modelRoles: { generation: { provider: 'gemini', model: 'gemini-3.8-flash' } } }).modelRoles?.generation).toEqual({ provider: 'gemini', model: 'gemini-3.8-flash' });
});

test('old NVIDIA slot data remains intact while its public generation pool is disabled', () => {
  const slot = { id: 'old-key', provider: 'nvidia', data: { enabled: true, access: 'free_confirmed', modelIds: ['nvidia/nemotron-3.5-super-vl-120b-a12b'], selectedModels: ['nvidia/nemotron-3.5-super-vl-120b-a12b'], generation_verified: true } };
  const before = JSON.stringify(slot);
  expect(publicSlot(slot)).toMatchObject({ enabled: false, models: [], selectedModels: [] });
  expect(JSON.stringify(slot)).toBe(before);
});

test('legacy Gemini selections use discovered no-charge models without erasing explicit empty pools', () => {
  const slot = { id: 'old-key', provider: 'gemini', data: { access: 'free_confirmed', modelIds: ['gemini-3.8-flash', 'gemma-4-26b-a4b-it', 'gemma-4-31b-it'], selectedModels: ['gemini-3.8-flash'], poolConfigured: true } };
  const before = JSON.stringify(slot);
  expect(publicSlot(slot).selectedModels).toEqual(['gemma-4-26b-a4b-it', 'gemma-4-31b-it']);
  expect(publicSlot(slot).models.map((model: any) => model.id)).toEqual(['gemma-4-26b-a4b-it', 'gemma-4-31b-it']);
  expect(publicSlot({...slot,data:{...slot.data,poolConfigured:false}}, true).selectedModels).toEqual(['gemini-3.8-flash', 'gemma-4-26b-a4b-it', 'gemma-4-31b-it']);
  expect(publicSlot({ ...slot, data: { ...slot.data, selectedModels: [] } }).selectedModels).toEqual([]);
  expect(JSON.stringify(slot)).toBe(before);
});

test('generation rejects any Flash without independent billing verification and any NVIDIA model', async () => {
  let calls = 0;
  const transport = (async () => { calls++; throw Error('unexpected upstream call'); }) as typeof fetch;
  const input = { kind: 'restudy_v1', prompt: 'fixture' } as const;
  const nvidia = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
  await expect(generate('nvidia', nvidia, 'test-key', input, transport, 0)).rejects.toMatchObject({ code: 'model_access_denied' });
  await expect(checkConnection('nvidia', nvidia, 'test-key', transport)).rejects.toMatchObject({ code: 'model_access_denied' });
  for (const model of ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']) {
    await expect(generate('gemini', model, 'test-key', input, transport, 0)).rejects.toMatchObject({ code: 'billing_confirmation_required' });
    await expect(generate('gemini', model, 'test-key', input, transport, 0, 20000, async () => undefined)).rejects.toMatchObject({ code: 'billing_confirmation_required' });
  }
  expect(calls).toBe(0);
});

test('verified Flash uses standard JSON generation without billable tool or service options', async () => {
  const events: string[] = [];
  const transport = (async (url, init) => {
    events.push('generate');
    expect(String(url)).toContain('gemini-3.8-flash:generateContent');
    const body = JSON.parse(String(init?.body));
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'LOW' } });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('serviceTier');
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] });
  }) as typeof fetch;
  await generate('gemini', 'gemini-3.8-flash', 'test-key', { kind: 'restudy_v1', prompt: 'fixture' }, transport, 0, 20000, async (key) => {
    expect(key).toBe('test-key');
    events.push('verify');
    return '123';
  });
  expect(events).toEqual(['verify', 'generate']);
});

test('router ignores a forged paid flag and unsafe preferred model without loading credentials', async () => {
  let keyReads = 0, calls = 0;
  const result = await runTask({ kind: 'generate_questions', prompt: 'fixture', sourceIds: [] }, {
    mode: 'round_robin', rotationIndex: 0, allowPaid: true, preferredProvider: 'nvidia', preferredModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    providers: [{ provider: 'nvidia', enabled: true, model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', access: 'free_confirmed', status: 'connected' }, { provider: 'gemini', enabled: true, model: 'gemini-3.8-flash', access: 'paid', status: 'connected' }],
    getKey: async () => { keyReads++; return 'test-key'; }, updateProvider: async () => {}, log: async () => {},
    fetch: (async () => { calls++; throw Error('unexpected upstream call'); }) as typeof fetch,
  });
  expect(result).toMatchObject({ status: 'paused', reason: 'no_available_provider' });
  expect(keyReads).toBe(0); expect(calls).toBe(0);
});

test('Gemma requests use documented image and thinking fields with prompt JSON plus application validation', async () => {
  const transport = (async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    expect(request.systemInstruction.parts[0].text).toContain('exactly one JSON object');
    expect(request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(request.generationConfig.responseFormat).toBeUndefined();
    expect(request.generationConfig.responseMimeType).toBeUndefined();
    expect(request.store).toBeUndefined(); expect(request.tools).toBeUndefined();
    expect(request.contents[0].parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: 'dGVzdA==' } });
    expect(request.contents[0].parts[0].text).toContain('"questions"');
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }));
  }) as typeof fetch;
  expect((await generate('gemini', 'gemma-4-26b-a4b-it', 'test-key', { kind: 'generate_questions', prompt: 'fixture', images: [{ mimeType: 'image/png', data: 'dGVzdA==' }] }, transport, 0)).raw).toEqual({});
});
