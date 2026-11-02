import { describe, expect, it, vi } from "vitest";
import { runTask, type ProviderState } from "../supabase/functions/_shared/ai/router.ts";

// Transport-only fixtures: no live API calls and no user database writes.
const output = { questions: [{ type: "short_answer", difficulty: "easy", prompt: "테스트", answer: "2", explanation: "테스트 해설", options: [], misconception_tags: [], source_citations: ["source-a"] }] };
const states = (): ProviderState[] => [
  { provider: "nvidia", enabled: true, model: "meta/llama-3.3-70b-instruct", access: "free_confirmed", status: "connected" },
  { provider: "gemini", enabled: true, model: "gemini-3.8-flash", access: "free_confirmed", status: "connected" },
];
const input = { kind: "generate_questions" as const, prompt: "테스트 자료", sourceIds: ["source-a"], count: 1 };
function context(rotationIndex = 0, providers = states(), transport?: typeof fetch) {
  const events: unknown[] = [];
  return { rotationIndex, providers, mode: "round_robin" as const, allowPaid: false, getKey: async () => "test-only-key", now: () => 1000000, sleep: async () => {}, updateProvider: async (_p: string, data: unknown) => { events.push(data); }, log: async (data: unknown) => { events.push(data); }, fetch: transport ?? (async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("nvidia") ? { choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { total_tokens: 20 } } : { candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 20 } }), { status: 200 })) as typeof fetch, events };
}
describe("persistent rotation routing", () => {
  it('preserves a full inference window and defers fallback instead of issuing a truncated request',async()=>{
    let clock=1000000;const seen:string[]=[],good=context().fetch;
    const timeout=vi.spyOn(AbortSignal,'timeout');
    const providers=[...['a','b','c'].map(credentialId=>({...states()[1],credentialId})),states()[0]];
    const ctx=context(1,providers,(async(...args:Parameters<typeof fetch>)=>{seen.push(String(args[0]));if(String(args[0]).includes('googleapis')){clock+=110000;throw new DOMException('timeout','TimeoutError');}return good(...args);})as typeof fetch);ctx.now=()=>clock;
    try{
      expect(await runTask(input,ctx)).toMatchObject({status:'paused',lastError:'timeout'});
      expect(timeout).toHaveBeenCalledWith(110000);
      expect(seen).toHaveLength(1);
    }finally{timeout.mockRestore();}
  });
  it('applies the shared provider group reservation before every upstream request including retries',async()=>{
    let clock=1000000, reservations=0,calls=0;const good=context().fetch,waits:number[]=[];
    const ctx={...context(0,[{...states()[0],credentialId:'a',quotaGroup:'account'}],(async(...args:Parameters<typeof fetch>)=>{calls++;return calls===1?new Response('{}',{status:503}):good(...args);})as typeof fetch),reserveRequest:async(provider:string,group:string)=>{expect(provider).toBe('nvidia');expect(group).toBe('account');reservations++;return reservations===2?{granted:false,retryAt:clock+500}:{granted:true};}};
    ctx.now=()=>clock;ctx.sleep=async(ms:number)=>{clock+=ms;waits.push(ms);};
    expect(await runTask(input,ctx)).toMatchObject({status:'succeeded'});
    expect(calls).toBe(2);expect(reservations).toBe(3);expect(waits).toEqual([1000,500]);
  });
  it("rotates keys and models and isolates an inaccessible model", async () => {
    const p=states()[0];
    const slots=[{...p,credentialId:'key-a',quotaGroup:'shared',selectedModels:['nvidia/nemotron-3-super-120b-a12b','openai/gpt-oss-20b']},{...p,credentialId:'key-b',quotaGroup:'other',selectedModels:['nvidia/nemotron-3-super-120b-a12b']}];
    const seen:string[]=[];const good=context().fetch;
    const ctx=context(0,slots,(async(...args:Parameters<typeof fetch>)=>{const body=JSON.parse(String(args[1]?.body));seen.push(body.model);return seen.length===1?new Response('{}',{status:404}):good(...args);})as typeof fetch);
    expect(await runTask(input,ctx)).toMatchObject({status:'succeeded',model:'openai/gpt-oss-20b'});
    expect(seen).toEqual(['nvidia/nemotron-3-super-120b-a12b','openai/gpt-oss-20b']);
  });
  it("does not hop across keys sharing an exhausted project quota", async () => {
    const p=states()[0];const seen:string[]=[];
    const slots=['a','b'].map(credentialId=>({...p,credentialId,quotaGroup:'shared',selectedModels:['nvidia/nemotron-3-super-120b-a12b','openai/gpt-oss-20b']}));
    const ctx=context(0,slots,(async(_u,init)=>{seen.push(JSON.parse(String(init?.body)).model);return new Response('{}',{status:429});})as typeof fetch);
    expect(await runTask(input,ctx)).toMatchObject({status:'paused'});expect(seen).toHaveLength(1);
  });
  it("treats an explicitly empty model selection as disabled", async () => {
    const ctx=context(0,[{...states()[0],credentialId:'a',selectedModels:[]}]);
    expect(await runTask(input,ctx)).toMatchObject({status:'paused',reason:'no_available_provider'});
  });
  it('switches models after a timeout without repeating the timed-out model',async()=>{
   const good=context().fetch,seen:string[]=[],ctx=context(0,[{...states()[1],credentialId:'a',selectedModels:['gemini-3.8-flash','gemini-3.6-flash']}],(async(...args:Parameters<typeof fetch>)=>{seen.push(String(args[0]));if(seen.length===1)throw new DOMException('timed out','TimeoutError');const body=JSON.parse(String(args[1]?.body));expect(body.store).toBe(false);return good(...args);})as typeof fetch);
   expect(await runTask(input,ctx)).toMatchObject({status:'succeeded',model:'gemini-3.6-flash'});expect(seen).toHaveLength(2);
  });
  it("uses another model when upstream explicitly identifies a per-model quota",async()=>{
    const seen:string[]=[],good=context().fetch,p=states()[1];
    const ctx=context(0,[{...p,credentialId:'a',selectedModels:['gemini-3.8-flash','gemini-3.6-flash']}],(async(...args:Parameters<typeof fetch>)=>{seen.push(String(args[0]));return seen.length===1?new Response(JSON.stringify({error:{details:[{violations:[{quotaDimensions:{model:'gemini-3.8-flash'}}]}]}}),{status:429}):good(...args);})as typeof fetch);
    expect(await runTask(input,ctx)).toMatchObject({status:'succeeded',model:'gemini-3.6-flash'});expect(seen).toHaveLength(2);
  });
  it("uses the durable rotation index to alternate providers across new runtimes", async () => {
    expect(await runTask(input, context(0))).toMatchObject({ status: "succeeded", provider: "nvidia" });
    expect(await runTask(input, context(1))).toMatchObject({ status: "succeeded", provider: "gemini" });
    expect(await runTask(input, context(2))).toMatchObject({ status: "succeeded", provider: "nvidia" });
  });
  it("does not send images to a text-only model", async () => {
    expect(await runTask({ ...input, images: [{ mimeType: "image/png", data: "dGVzdA==" }] }, context())).toMatchObject({ status: "succeeded", provider: "gemini" });
  });
  it("blocks paid and unknown billing when paid access is disabled", async () => {
    const providers = states(); providers[0].access = "paid"; providers[1].access = "unknown";
    let calls = 0;
    const ctx = context(0, providers, (async () => { calls++; throw new Error("must not call"); }) as typeof fetch);
    expect(await runTask(input, ctx)).toMatchObject({ status: "paused", reason: "no_available_provider" });
    expect(calls).toBe(0);
  });
  it("honors Retry-After, switches provider and keeps errors free of response secrets", async () => {
    const ctx = context(0, states(), (async (url: string | URL | Request) => {
      if (String(url).includes("nvidia")) return new Response("secret upstream body test-only-key", { status: 429, headers: { "Retry-After": "60" } });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] }, finishReason: "STOP" }] }));
    }) as typeof fetch);
    expect(await runTask(input, ctx)).toMatchObject({ status: "succeeded", provider: "gemini" });
    expect(ctx.events).toContainEqual(expect.objectContaining({ cooldown_until: new Date(1060000).toISOString(), last_error: "rate_limited" }));
    expect(JSON.stringify(ctx.events)).not.toContain("test-only-key");
  });
  it("disables invalid credentials and preserves a job when both fail", async () => {
    const ctx = context(0, states(), (async () => new Response("test-only-key", { status: 401 })) as typeof fetch);
    expect(await runTask(input, ctx)).toMatchObject({ status: "paused", reason: "all_providers_failed" });
    expect(ctx.events.filter((value: any) => value.status === "auth_error")).toHaveLength(2);
  });
  it("retries server failure once with backoff then fails over", async () => {
    let nvidiaCalls = 0; const waits: number[] = [];
    const good = context().fetch;
    const ctx = context(0, states(), (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes("nvidia")) { nvidiaCalls++; return new Response("upstream", { status: 503 }); }
      return good(...args);
    }) as typeof fetch);
    ctx.sleep = async (ms?: number) => { waits.push(ms!); };
    expect(await runTask(input, ctx)).toMatchObject({ status: "succeeded", provider: "gemini" });
    expect(nvidiaCalls).toBe(2); expect(waits).toEqual([1000]);
  });
  it("does not accept structurally invalid or truncated provider output", async () => {
    const ctx = context(0, states(), (async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "length" }], candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "MAX_TOKENS" }] }))) as typeof fetch);
    expect(await runTask(input, ctx)).toMatchObject({ status: "paused", reason: "all_providers_failed" });
  });
  it("does not buy another generation if persisting a successful call fails", async () => {
    const ctx = context(); let calls = 0; const transport = ctx.fetch;
    ctx.fetch = (async (...args: Parameters<typeof fetch>) => { calls++; return transport(...args); }) as typeof fetch;
    ctx.updateProvider = async () => { throw new Error("database offline"); };
    await expect(runTask(input, ctx)).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("honors an explicitly selected role provider while keeping the paid gate", async () => {
    const ctx = { ...context(0), preferredProvider: "gemini" as const };
    expect(await runTask(input, ctx)).toMatchObject({ status: "succeeded", provider: "gemini" });
    ctx.providers[1].access = "paid";
    expect(await runTask(input, ctx)).toMatchObject({ status: "succeeded", provider: "nvidia" });
  });
  it("rejects generation that ignores the requested type or difficulty", async () => {
    expect(await runTask({ ...input, types: ["multiple_choice"], difficulty: "easy" }, context())).toMatchObject({ status: "paused", reason: "all_providers_failed" });
    expect(await runTask({ ...input, types: ["short_answer"], difficulty: "hard" }, context())).toMatchObject({ status: "paused", reason: "all_providers_failed" });
  });
});
