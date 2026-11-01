import type { Provider } from "./crypto.ts";
import { modelFor } from "./catalog.ts";
import { generate, ProviderError, type ImageInput } from "./providers.ts";
import { validateOutput, type TaskKind, type Json } from "./schemas.ts";
export type Mode = "round_robin" | "nvidia_first" | "gemini_first" | "nvidia_only" | "gemini_only";
export type ProviderState = { provider: Provider; enabled: boolean; model: string; access: "unknown" | "free_confirmed" | "paid"; status: string; cooldown_until?: string; credentialId?:string; label?:string; quotaGroup?:string; selectedModels?:string[]; modelStates?:Record<string,Json>; quotaCooldowns?:Record<string,string>; [key: string]: unknown };
export type TaskInput = { kind: TaskKind; prompt: string; sourceIds: string[]; count?: number; images?: ImageInput[]; types?: string[]; difficulty?: string;allowedPages?:number[] };
export type RouterContext = { providers: ProviderState[]; mode: Mode; rotationIndex: number; allowPaid: boolean; preferredProvider?: Provider; preferredModel?:string; getKey(provider: Provider,credentialId?:string): Promise<string>; updateProvider(provider: Provider, changes: Json,credentialId?:string,model?:string): Promise<void>; log(entry: Json): Promise<void>; fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> };
export type TaskResult = { status: "succeeded"; provider: Provider; model: string; output: Json; usage: Record<string, number>; duration_ms: number } | { status: "paused"; reason: "no_available_provider" | "all_providers_failed"; retryAt?: number;lastError?:string };
export class SuccessfulTaskPersistenceError extends Error {
  constructor(public result: Extract<TaskResult, { status: "succeeded" }>) { super("provider_result_persistence_failed"); }
}
export async function runTask(input: TaskInput, context: RouterContext): Promise<TaskResult> {
  const now = context.now ?? Date.now; const sleep = context.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline=now()+85000;
  let order: Provider[] = context.mode === "gemini_first" || context.mode === "gemini_only" ? ["gemini", "nvidia"] : ["nvidia", "gemini"];
  if (context.mode === "round_robin" && context.rotationIndex % 2 === 1) order.reverse();
  if (context.mode.endsWith("_only")) order = order.slice(0, 1);
  if (context.preferredProvider && !context.mode.endsWith("_only")) order = [context.preferredProvider, ...order.filter((provider) => provider !== context.preferredProvider)];
  let tried = false,lastError:string|undefined; const retryTimes: number[] = [], blockedKeys=new Set<string>(),groupCooldowns=new Map<string,number>();
  const rotate=<T>(values:T[],index:number)=>values.length?[...values.slice(index%values.length),...values.slice(0,index%values.length)]:[];
  for (const provider of order) {
    const slots=context.providers.filter(s=>s.provider===provider);
    for(const state of rotate(slots,Math.floor(context.rotationIndex/2))){
    const keyId=state.credentialId??provider,groupId=`${provider}:${state.quotaGroup??'shared'}`;
    let selected=rotate(state.selectedModels??[state.model],Math.floor(context.rotationIndex/(2*Math.max(1,slots.length))));
    if(context.preferredModel&&selected.includes(context.preferredModel))selected=[context.preferredModel,...selected.filter(m=>m!==context.preferredModel)];
    for(const modelId of selected){
    const model=modelFor(provider,modelId);
    if (!state?.enabled || !model?.text || !model.structured || state.status === "auth_error" || !context.allowPaid && state.access !== "free_confirmed" || input.images?.length && !model.image || input.prompt.length > model.maxInputChars) continue;
    if(blockedKeys.has(keyId))continue;
    const cooldown = Math.max((state.cooldown_until ? Date.parse(state.cooldown_until) : 0)||0,groupCooldowns.get(groupId)??0,groupCooldowns.get(`${groupId}:${modelId}`)??0,Date.parse(state.quotaCooldowns?.['']??'')||0,Date.parse(state.quotaCooldowns?.[modelId]??'')||0,Date.parse(state.modelStates?.[modelId]?.cooldown_until??'')||0);
    if (cooldown > now()) { retryTimes.push(cooldown); continue; }
    tried = true;
    let key: string;
    try { key = await context.getKey(provider,state.credentialId); } catch { blockedKeys.add(keyId);await context.updateProvider(provider, { status: "key_error", last_error: "credential_unavailable" },state.credentialId); continue; }
    for (let attempt = 0; attempt < 2; attempt++) {
      if(now()+1000>=deadline)return {status:'paused',reason:'all_providers_failed',lastError,retryAt:now()+30000};
      const start = now();
      let successful: Extract<TaskResult, { status: "succeeded" }> | undefined;
      try {
        const response = await generate(provider, model.id, key, input, context.fetch ?? fetch, now(),Math.max(1000,Math.min(input.kind==='restudy_v1'?40000:20000,deadline-now()-1000)));
        let output: Json;
        try { output = validateOutput(input.kind, response.raw, input.sourceIds, input.count); } catch { throw new ProviderError("invalid_response"); }
        if(input.kind==='restudy_v1'&&input.allowedPages&&(output.questions.some((q:Json)=>q.source_pages.some((n:number)=>!input.allowedPages!.includes(n)))||output.problem_analyses.some((q:Json)=>!input.allowedPages!.includes(q.pdf_page))))throw new ProviderError('invalid_response');
        if (input.kind !== "analyze_problem" && input.kind!=='restudy_v1' && output.questions.some((question: Json) => input.types?.length && !input.types.includes(question.type) || input.difficulty && input.difficulty !== question.difficulty)) throw new ProviderError("invalid_response");
        const duration_ms = Math.max(0, now() - start);
        successful = { status: "succeeded", provider, model: model.id, output, usage: response.usage, duration_ms };
      } catch (error) {
        // Never persist provider bodies, exception messages, prompts or request headers.
        const failure = error instanceof ProviderError ? error : new ProviderError("provider_error");
        lastError=failure.code;
        await context.log({ provider,credential_id:state.credentialId,key_label:state.label, model: model.id, kind: input.kind, success: false, attempt: attempt + 1, duration_ms: Math.max(0, now() - start), error: failure.code, http_status: failure.status ?? null });
        if (["provider_error", "network_error"].includes(failure.code) && attempt === 0) { await sleep(1000); continue; }
        const until = failure.retryAt ?? (["provider_error", "network_error","timeout"].includes(failure.code) ? now() + 5000 : now()+600000);
        if (until) retryTimes.push(until);
        if(failure.code==='auth_error')blockedKeys.add(keyId);
        if(failure.code==='rate_limited')groupCooldowns.set(failure.quotaScope==='model'?`${groupId}:${model.id}`:groupId,until);
        await context.updateProvider(provider, { status: failure.code === "auth_error" ? "auth_error" : "error", last_error: failure.code, cooldown_until: new Date(until).toISOString(),...(failure.code==='rate_limited'?{quotaCooldown:{group:state.quotaGroup??'shared',model:failure.quotaScope==='model'?model.id:'',until:new Date(until).toISOString()}}:{}) },state.credentialId,model.id); break;
      }
      if (successful) {
        // Persistence failures must escape; retrying inference here could incur duplicate charges.
        try {
          await context.log({ provider,credential_id:state.credentialId,key_label:state.label, model: model.id, kind: input.kind, success: true, attempt: attempt + 1, duration_ms: successful.duration_ms, usage: successful.usage });
          await context.updateProvider(provider, { status: "connected", generation_verified: true, last_error: null, cooldown_until: null, last_success_at: new Date(now()).toISOString() },state.credentialId,model.id);
        } catch { throw new SuccessfulTaskPersistenceError(successful); }
        return successful;
      }
    }
    }
    }
  }
  return { status: "paused", reason: tried ? "all_providers_failed" : "no_available_provider",lastError,...(retryTimes.length ? { retryAt: Math.min(...retryTimes) } : {}) };
}
