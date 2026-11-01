import { describe, expect, it } from "vitest";
import { encryptKey, decryptKey } from "../supabase/functions/_shared/ai/crypto.ts";
import { validateOutput } from "../supabase/functions/_shared/ai/schemas.ts";
import { credentialAction } from "../supabase/functions/_shared/ai/credentials.ts";

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
  it("adds separate encrypted slots, preserves a failed replacement and allows empty model pools",async()=>{
    const db=database(),ctx={user:{id:'owner-a'},db,admin:db};
    const good=(async()=>new Response(JSON.stringify({models:[{name:'models/gemini-3.8-flash',supportedGenerationMethods:['generateContent']},{name:'models/gemini-3.6-flash',supportedGenerationMethods:['generateContent']}]})))as typeof fetch;
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
    const transport = (async () => new Response(JSON.stringify({models:[{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }]}))) as typeof fetch;
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
  it("does not mistake the public NVIDIA model list for valid credentials", async () => {
    const db = database(); const ctx = { user: { id: "owner-a" }, db, admin: db };
    let probes = 0;
    const transport = (async (_url: any, init: any) => {
      if (init.method === "POST") { probes++; return new Response("secret auth failure", { status: 401 }); }
      return new Response(JSON.stringify({ data: [{ id: "nvidia/nemotron-3-super-120b-a12b" }] }));
    }) as typeof fetch;
    await expect(credentialAction({ action: "save", provider: "nvidia", key: "test-only-key", access: "free_confirmed" }, ctx, master, transport)).rejects.toThrow("auth_error");
    expect(probes).toBe(1); expect(db.tables.ai_credentials).toEqual([]);
  });
  it("does not run a NVIDIA connection generation without billing confirmation", async () => {
    const db = database(); const ctx = { user: { id: "owner-a" }, db, admin: db }; let calls = 0;
    await expect(credentialAction({ action: "save", provider: "nvidia", key: "test-only-key" }, ctx, master, (async () => { calls++; throw new Error("must not call"); }) as typeof fetch)).rejects.toThrow("billing_confirmation_required");
    expect(calls).toBe(0);
  });
});
