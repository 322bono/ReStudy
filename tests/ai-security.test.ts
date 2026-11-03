import { describe, expect, it, vi } from "vitest";
import { encryptKey, decryptKey } from "../supabase/functions/_shared/ai/crypto.ts";
import { validateOutput } from "../supabase/functions/_shared/ai/schemas.ts";
import { credentialAction } from "../supabase/functions/_shared/ai/credentials.ts";
import { providerContext } from "../supabase/functions/_shared/ai/service.ts";
import { sanitizeSettings } from "../supabase/functions/_shared/ai/settings.ts";

// Isolated test values: never sent to a provider or inserted in a user database.
const master = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
describe("AI credential encryption", () => {
  it("encrypts with fresh IVs and only decrypts for the original owner/provider", async () => {
    const first = await encryptKey("test-only-key", "owner-a", "gemini", master);
    const second = await encryptKey("test-only-key", "owner-a", "gemini", master);
    expect(first.ciphertext).not.toContain("test-only-key");
    expect(first.iv).not.toBe(second.iv);
    expect(await decryptKey(first, "owner-a", "gemini", master)).toBe("test-only-key");
    await expect(decryptKey(first, "owner-b", "gemini", master)).rejects.toThrow();
    await expect(decryptKey(first, "owner-a", "nvidia", master)).rejects.toThrow();
  });
  it("rejects ciphertext changes and invalid master keys", async () => {
    const record = await encryptKey("test-only-key", "owner-a", "nvidia", master);
    const bytes = Uint8Array.from(atob(record.ciphertext), (x) => x.charCodeAt(0));
    bytes[0] ^= 1;
    record.ciphertext = btoa(String.fromCharCode(...bytes));
    await expect(decryptKey(record, "owner-a", "nvidia", master)).rejects.toThrow();
    await expect(encryptKey("test-only-key", "owner-a", "nvidia", "invalid")).rejects.toThrow();
  });
});

const question = () => ({
  type: "multiple_choice", difficulty: "medium", prompt: "테스트 문항", answer: "c",
  explanation: "테스트 해설", misconception_tags: [], source_citations: ["source-a"],
  options: ["a", "b", "c", "d", "e"].map((id) => ({ id, text: `선택지 ${id}`, explanation: "테스트 선택지 해설" })),
});
describe("generated content validation", () => {
  it("rejects missing answers and duplicate alternatives before saving", () => {
    const value = question(); value.answer = "missing";
    expect(() => validateOutput("generate_questions", { questions: [value] }, ["source-a"], 1)).toThrow();
    value.answer = "c"; value.options[1].text = value.options[0].text;
    expect(() => validateOutput("generate_questions", { questions: [value] }, ["source-a"], 1)).toThrow();
  });
  it("rejects invented citations and forces review on structurally valid content", () => {
    expect(() => validateOutput("generate_questions", { questions: [question()] }, ["another-source"], 1)).toThrow();
    expect(validateOutput("generate_questions", { questions: [question()] }, ["source-a"], 1)).toMatchObject({ review_status: "needs_review" });
  });
  it("rejects a wrong deterministic numeric answer", () => {
    const value = { ...question(), type: "short_answer", options: [], answer: "9", verification: { expression: "2*(3+1)", expected: 9 } };
    expect(() => validateOutput("generate_questions", { questions: [value] }, ["source-a"], 1)).toThrow();
    value.answer = "8"; value.verification.expected = 8;
    expect(validateOutput("generate_questions", { questions: [value] }, ["source-a"], 1)).toMatchObject({ review_status: "needs_review" });
  });
  it("keeps actual misconception corrections in concept analysis", () => {
    const result = validateOutput("analyze_problem", { concepts: [{ subject: "수학", major: "함수", minor: "", name: "일대일대응", definition: "일대일함수이며 치역과 공역이 같다.", properties: [], prerequisites: [], misconceptions: [{ label: "일대일함수이면 충분하다", correction: "치역과 공역도 같아야 한다." }], source_citations: ["problem-a"] }], analyses: [{ problem_id: "problem-a", concept_keys: ["수학|함수||일대일대응"], problem_type: "조건 판단", conditions: [], misconceptions: [], confidence: 0.8 }] }, ["problem-a"]);
    expect(result.concepts[0].misconceptions).toEqual([{ label: "일대일함수이면 충분하다", correction: "치역과 공역도 같아야 한다." }]);
  });
});

function database() {
  const tables: Record<string, any[]> = { profiles: [{ user_id: "owner-a", data: {} }], ai_credentials: [], ai_providers: [], ai_key_slots:[],ai_key_model_states:[],ai_quota_cooldowns:[],ai_jobs: [], ai_usage_logs: [] };
  return { tables, from(table: string) {
    let filters: [string, any][] = []; let change: any; let operation = "select";
    const query: any = {
      select: () => query, eq: (key: string, value: any) => { filters.push([key, value]); return query; }, order: () => query, limit: () => query,
      insert:(value:any)=>{change=value;operation='insert';return query;},upsert: (value: any) => { change = value; operation = "upsert"; return query; }, delete: () => { operation = "delete"; return query; }, update: (value: any) => { change = value; operation = "update"; return query; },
      then(resolve: any, reject: any) { return Promise.resolve().then(() => {
        const rows = tables[table] ?? []; const matches = (row: any) => filters.every(([key, value]) => row[key] === value);
        if(operation==='insert')rows.push(change);
        if (operation === "upsert") { const old = rows.find((row) => row.user_id === change.user_id && row.provider === change.provider); if (old) Object.assign(old, change); else rows.push(change); }
        if (operation === "delete") tables[table] = rows.filter((row) => !matches(row));
        if (operation === "update") rows.filter(matches).forEach((row) => Object.assign(row, change));
        return { data: rows.filter(matches), error: null };
      }).then(resolve, reject); },
      async maybeSingle() { const result = await query; return { data: result.data[0] ?? null, error: null }; },
    }; return query;
  } };
}
describe("server-only credential operations", () => {
  it('blocks NVIDIA checks before any inference and preserves encrypted historic selections',async()=>{
    const db=database(),ctx={user:{id:'owner-a'},db,admin:db},encrypted=await encryptKey('test-only-key','owner-a','nvidia',master);
    const selected=['nvidia/nemotron-3-super-120b-a12b','nvidia/nemotron-3.5-lightning-30b-a3b'];
    db.tables.ai_key_slots.push({id:'slot-a',user_id:'owner-a',provider:'nvidia',...encrypted,data:{access:'free_confirmed',modelIds:selected,selectedModels:selected,poolConfigured:true}});
    let calls=0;
    const transport=(async()=>{calls++;throw Error('must not call');})as typeof fetch;
    await expect(credentialAction({action:'check',provider:'nvidia',credentialId:'slot-a'},ctx,master,transport)).rejects.toThrow('free_only_policy');
    expect(calls).toBe(0);expect(db.tables.ai_key_slots[0]).toMatchObject({...encrypted,data:{selectedModels:selected}});
  });
  it('refreshes NVIDIA metadata while keeping historic pools preserved and generation disabled',async()=>{
    for(const custom of [false,true]){
      const db=database(),ctx={user:{id:'owner-a'},db,admin:db};
      const encrypted=await encryptKey('test-only-key','owner-a','nvidia',master);
      db.tables.ai_key_slots.push({id:'slot-a',user_id:'owner-a',provider:'nvidia',...encrypted,data:{access:'free_confirmed',modelIds:['nvidia/nemotron-3.5-lightning-30b-a3b'],selectedModels:['nvidia/nemotron-3.5-lightning-30b-a3b'],poolConfigured:custom}});
      const transport=(async(_url,init)=>{expect(init?.method).toBeUndefined();return new Response(JSON.stringify({data:[{id:'nvidia/nemotron-3.5-lightning-30b-a3b'},{id:'nvidia/nemotron-3.5-bolt-e4b'},{id:'nvidia/nemotron-3.5-super-vl-120b-a12b'}]}));})as typeof fetch;
      await credentialAction({action:'discover',provider:'nvidia',credentialId:'slot-a'},ctx,master,transport);
      expect(db.tables.ai_key_slots[0].data.selectedModels).toEqual(['nvidia/nemotron-3.5-lightning-30b-a3b']);
      const status=await credentialAction({action:'status'},ctx,master);
      expect(status.providers[0].credentials[0]).toMatchObject({enabled:false,selectedModels:[],models:[]});
    }
  });
  it("adds separate encrypted slots, preserves a failed replacement and allows empty model pools",async()=>{
    const db=database(),ctx={user:{id:'owner-a'},db,admin:db};
    const good=(async()=>new Response(JSON.stringify({models:[{name:'models/gemma-4-26b-a4b-it',supportedGenerationMethods:['generateContent']},{name:'models/gemma-4-31b-it',supportedGenerationMethods:['generateContent']}]})))as typeof fetch;
    const first=await credentialAction({action:'save',provider:'gemini',key:'test-first',access:'free_confirmed',label:'첫 키'},ctx,master,good);
    await credentialAction({action:'save',provider:'gemini',key:'test-second',access:'free_confirmed',label:'둘째 키'},ctx,master,good);
    expect(db.tables.ai_key_slots).toHaveLength(2);
    const old=db.tables.ai_key_slots[0].ciphertext;
    db.tables.ai_key_slots[0].data.checked_at='2000-01-01T00:00:00Z';
    await expect(credentialAction({action:'save',provider:'gemini',credentialId:first.credentialId,key:'failed-replacement'},ctx,master,(async()=>new Response('{}',{status:401}))as typeof fetch)).rejects.toThrow('auth_error');
    expect(db.tables.ai_key_slots[0].ciphertext).toBe(old);
    await credentialAction({action:'toggle',provider:'gemini',credentialId:first.credentialId,enabled:true,selectedModels:[]},ctx,master);
    expect(db.tables.ai_key_slots[0].data.selectedModels).toEqual([]);
    await expect(credentialAction({action:'delete',provider:'gemini',credentialId:'foreign-slot'},ctx,master)).rejects.toThrow('credential_not_found');
    await expect(credentialAction({action:'delete',provider:'gemini'},ctx,master)).rejects.toThrow('credential_id_required');
    const status=await credentialAction({action:'status'},ctx,master);
    expect(status.providers[1].credentials).toHaveLength(2);
    for(const secret of ['test-first','test-second','ciphertext','fingerprint','iv'])expect(JSON.stringify(status)).not.toContain(secret==='iv'?'"iv"':secret);
    await expect(credentialAction({action:'save',provider:'gemini',key:'test-second'},ctx,master,good)).rejects.toThrow('credential_duplicate');
  });
  it("returns only connection metadata and never stores the plaintext submitted key", async () => {
    const db = database(); const ctx = { user: { id: "owner-a" }, db, admin: db };
    const transport = (async () => new Response(JSON.stringify({models:[{ name: "models/gemma-4-26b-a4b-it", supportedGenerationMethods: ["generateContent"] }]}))) as typeof fetch;
    const response = await credentialAction({ action: "save", provider: "gemini", key: "test-only-plaintext-secret", access: "free_confirmed" }, ctx, master, transport);
    expect(response).toMatchObject({ configured: true, generation_verified: false });
    expect(JSON.stringify(db.tables)).not.toContain("test-only-plaintext-secret");
    const status = await credentialAction({ action: "status" }, ctx, master, transport);
    expect(JSON.stringify(status)).not.toContain("ciphertext");
    expect(JSON.stringify(status)).not.toContain("test-only-plaintext-secret");
    expect(status.providers[1]).toMatchObject({ configured: true, access: "free_confirmed", access_confirmation: "user" });
  });
  it("leaves the previous valid key intact after a failed replacement", async () => {
    const db = database(); const ctx = { user: { id: "owner-a" }, db, admin: db };
    db.tables.ai_credentials.push({ user_id: "owner-a", provider: "gemini", ciphertext: "previous-ciphertext", iv: "previous-iv", key_version: 1 });
    await expect(credentialAction({ action: "save", provider: "gemini", key: "test-only-replacement" }, ctx, master, (async () => new Response("test-only-replacement", { status: 401 })) as typeof fetch)).rejects.toThrow("auth_error");
    expect(db.tables.ai_credentials[0].ciphertext).toBe("previous-ciphertext");
  });
  it("deletes only the authenticated owner's provider key", async () => {
    const db = database(); const ctx = { user: { id: "owner-a" }, db, admin: db };
    db.tables.ai_credentials.push({ user_id: "owner-a", provider: "gemini" }, { user_id: "owner-b", provider: "gemini" });
    db.tables.ai_key_slots.push({id:'slot-a',user_id:'owner-a',provider:'gemini',data:{legacy:true}},{id:'slot-b',user_id:'owner-b',provider:'gemini',data:{legacy:true}});
    await credentialAction({ action: "delete", provider: "gemini" }, ctx, master);
    expect(db.tables.ai_credentials).toEqual([{ user_id: "owner-b", provider: "gemini" }]);
  });
  it("rejects new NVIDIA credentials without using a free-account checkbox as payment evidence", async () => {
    const db = database(); const ctx = { user: { id: "owner-a" }, db, admin: db };
    let probes = 0;
    const transport = (async (_url: any, init: any) => {
      if (init.method === "POST") { probes++; return new Response("secret auth failure", { status: 401 }); }
      return new Response(JSON.stringify({ data: [{ id: "nvidia/nemotron-3-super-120b-a12b" }] }));
    }) as typeof fetch;
    await expect(credentialAction({ action: "save", provider: "nvidia", key: "test-only-key", access: "free_confirmed" }, ctx, master, transport)).rejects.toThrow("free_only_policy");
    expect(probes).toBe(0); expect(db.tables.ai_credentials).toEqual([]);
  });
  it("cannot enable NVIDIA generation through forged paid account settings", async () => {
    const db = database(); const ctx = { user: { id: "owner-a" }, db, admin: db }; let calls = 0;
    db.tables.profiles[0].data.ai_settings={allow_paid:true};
    await expect(credentialAction({ action: "save", provider: "nvidia", key: "test-only-key",access:'paid' }, ctx, master, (async () => { calls++; throw new Error("must not call"); }) as typeof fetch)).rejects.toThrow("free_only_policy");
    expect(calls).toBe(0);
  });
  it('reports only no-charge models and refuses unsafe model selections',async()=>{
    const db=database(),ctx={user:{id:'owner-a'},db,admin:db};
    db.tables.ai_key_slots.push({id:'slot-a',user_id:'owner-a',provider:'gemini',data:{modelIds:['gemini-3.8-flash','gemma-4-26b-a4b-it','gemma-4-31b-it'],selectedModels:['gemini-3.8-flash']}});
    const status=await credentialAction({action:'status'},ctx,master);
    expect(status.models.map((model:any)=>model.id)).toEqual(['gemma-4-26b-a4b-it','gemma-4-31b-it']);
    await expect(credentialAction({action:'toggle',provider:'gemini',credentialId:'slot-a',enabled:true,selectedModels:['gemini-3.8-flash']},ctx,master)).rejects.toThrow('invalid_model');
    expect(db.tables.ai_key_slots[0].data.selectedModels).toEqual(['gemini-3.8-flash']);
    expect((await credentialAction({action:'settings',settings:{allow_paid:true,mode:'nvidia_only'}},ctx,master)).settings).toMatchObject({allow_paid:false,mode:'gemini_only'});
  });
  it('refreshes stale model metadata on explicit AI actions and preserves original selection IDs',async()=>{
    const db=database(),ctx={user:{id:'owner-a'},db,admin:db},encrypted=await encryptKey('test-only-key','owner-a','gemini',master);
    db.tables.ai_key_slots.push({id:'slot-a',user_id:'owner-a',provider:'gemini',...encrypted,data:{modelIds:['gemini-3.8-flash'],selectedModels:['gemini-3.8-flash'],poolConfigured:true,listed_at:'2026-10-01T00:00:00Z',catalog_version:'historic'}});
    const calls:string[]=[];
    vi.stubGlobal('fetch',async(url:string|URL|Request,init?:RequestInit)=>{calls.push(String(url));expect(init?.method).toBeUndefined();return new Response(JSON.stringify({models:[{name:'models/gemma-4-26b-a4b-it',supportedGenerationMethods:['generateContent']},{name:'models/gemma-4-31b-it',supportedGenerationMethods:['generateContent']}]}));});
    try{
      const routing=await providerContext(ctx,'job-a',sanitizeSettings({allow_paid:true}),master,{kind:'generate_questions',prompt:'fixture',sourceIds:[]});
      expect(calls).toHaveLength(1);expect(routing).toMatchObject({allowPaid:false,mode:'gemini_only'});
      expect(routing.providers[0].selectedModels).toEqual(['gemma-4-26b-a4b-it','gemma-4-31b-it']);
      expect(db.tables.ai_key_slots[0]).toMatchObject({...encrypted,data:{selectedModels:['gemini-3.8-flash']}});
    }finally{vi.unstubAllGlobals();}
  });
});
