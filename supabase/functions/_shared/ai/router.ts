import type { Provider } from "./crypto.ts";
import { modelFor } from "./catalog.ts";
import { generate, ProviderError, type ImageInput } from "./providers.ts";
import { validateOutput, type TaskKind, type Json } from "./schemas.ts";
export type Mode = "round_robin" | "nvidia_first" | "gemini_first" | "nvidia_only" | "gemini_only";
export type ProviderState = { provider: Provider; enabled: boolean; model: string; access: "unknown" | "free_confirmed" | "paid"; status: string; cooldown_until?: string; [key: string]: unknown };
export type TaskInput = { kind: TaskKind; prompt: string; sourceIds: string[]; count?: number; images?: ImageInput[]; types?: string[]; difficulty?: string;allowedPages?:number[] };
export type RouterContext = { providers: ProviderState[]; mode: Mode; rotationIndex: number; allowPaid: boolean; preferredProvider?: Provider; getKey(provider: Provider): Promise<string>; updateProvider(provider: Provider, changes: Json): Promise<void>; log(entry: Json): Promise<void>; fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> };
export type TaskResult = { status: "succeeded"; provider: Provider; model: string; output: Json; usage: Record<string, number>; duration_ms: number } | { status: "paused"; reason: "no_available_provider" | "all_providers_failed"; retryAt?: number };
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
  let tried = false; const retryTimes: number[] = [];
  for (const provider of order) {
    const state = context.providers.find((state) => state.provider === provider); const model = state && modelFor(provider, state.model);
    if (!state?.enabled || !model?.text || !model.structured || state.status === "auth_error" || !context.allowPaid && state.access !== "free_confirmed" || input.images?.length && !model.image || input.prompt.length > model.maxInputChars) continue;
    const cooldown = state.cooldown_until ? Date.parse(state.cooldown_until) : 0;
    if (cooldown > now()) { retryTimes.push(cooldown); continue; }
    tried = true;
    let key: string;
    try { key = await context.getKey(provider); } catch { await context.updateProvider(provider, { status: "key_error", last_error: "credential_unavailable" }); continue; }
    for (let attempt = 0; attempt < 2; attempt++) {
      if(now()+1000>=deadline)return {status:'paused',reason:'all_providers_failed',retryAt:now()+30000};
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
        await context.log({ provider, model: model.id, kind: input.kind, success: false, attempt: attempt + 1, duration_ms: Math.max(0, now() - start), error: failure.code, http_status: failure.status ?? null });
        if (["provider_error", "network_error"].includes(failure.code) && attempt === 0) { await sleep(1000); continue; }
        const until = failure.retryAt ?? (["provider_error", "network_error"].includes(failure.code) ? now() + 5000 : undefined);
        if (until) retryTimes.push(until);
        await context.updateProvider(provider, { status: failure.code === "auth_error" ? "auth_error" : "error", last_error: failure.code, ...(until ? { cooldown_until: new Date(until).toISOString() } : {}) }); break;
      }
      if (successful) {
        // Persistence failures must escape; retrying inference here could incur duplicate charges.
        try {
          await context.log({ provider, model: model.id, kind: input.kind, success: true, attempt: attempt + 1, duration_ms: successful.duration_ms, usage: successful.usage });
          await context.updateProvider(provider, { status: "connected", generation_verified: true, last_error: null, cooldown_until: null, last_success_at: new Date(now()).toISOString() });
        } catch { throw new SuccessfulTaskPersistenceError(successful); }
        return successful;
      }
    }
  }
  return { status: "paused", reason: tried ? "all_providers_failed" : "no_available_provider", ...(retryTimes.length ? { retryAt: Math.min(...retryTimes) } : {}) };
}
