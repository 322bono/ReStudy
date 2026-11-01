import { models, modelFor, defaultModel } from "./catalog.ts";
import { decryptKey, encryptKey, type Provider } from "./crypto.ts";
import { checkConnection, ProviderError } from "./providers.ts";
import { providerState, sanitizeSettings } from "./settings.ts";
import type { Json } from "./schemas.ts";
export type AuthContext = { user: { id: string }; db: any; admin: any };
export class AiError extends Error { constructor(public code: string, public status = 400) { super(code); } }
export function checked(result: { data: any; error: any }): any { if (result.error) throw new AiError("database_error", 500); return result.data; }
export async function readProfile(ctx: AuthContext): Promise<Json> { return checked(await ctx.admin.from("profiles").select("data").eq("user_id", ctx.user.id).maybeSingle())?.data ?? {}; }
export async function loadProviders(ctx: AuthContext): Promise<any[]> { return checked(await ctx.admin.from("ai_providers").select("provider,data").eq("user_id", ctx.user.id)) ?? []; }
async function patchProvider(ctx: AuthContext, provider: Provider, changes: Json): Promise<void> {
  const existing = checked(await ctx.admin.from("ai_providers").select("data").eq("user_id", ctx.user.id).eq("provider", provider).maybeSingle());
  checked(await ctx.admin.from("ai_providers").upsert({ user_id: ctx.user.id, provider, data: { ...existing?.data, ...changes } }, { onConflict: "user_id,provider" }));
}
export async function credentialAction(body: Json, ctx: AuthContext, master: string, transport: typeof fetch = fetch): Promise<Json> {
  const action = body.action ?? "status";
  if (action === "status") {
    const [rows, configured, profile, jobs, usage] = await Promise.all([
      loadProviders(ctx), ctx.admin.from("ai_credentials").select("provider").eq("user_id", ctx.user.id).then(checked), readProfile(ctx),
      ctx.admin.from("ai_jobs").select("id,kind,status,attempts,available_at,created_at,updated_at,data").eq("user_id", ctx.user.id).order("created_at", { ascending: false }).limit(30).then(checked),
      ctx.admin.from("ai_usage_logs").select("id,job_id,data,created_at").eq("user_id", ctx.user.id).order("created_at", { ascending: false }).limit(50).then(checked),
    ]);
    return { providers: (["nvidia", "gemini"] as Provider[]).map((provider) => providerState(provider, rows.find((row) => row.provider === provider)?.data, configured.some((row: Json) => row.provider === provider))), models, settings: sanitizeSettings(profile.ai_settings), encryption_configured: !!master, jobs: jobs.map((row: Json) => ({ id: row.id, kind: row.kind, status: row.status, attempts: row.attempts, available_at: row.available_at, created_at: row.created_at, updated_at: row.updated_at, last_error: row.data?.last_error ?? null })), usage: usage.map((row: Json) => ({ id: row.id, job_id: row.job_id, created_at: row.created_at, ...Object.fromEntries(["provider", "model", "kind", "success", "attempt", "duration_ms", "error", "http_status", "usage"].filter((key) => row.data?.[key] !== undefined).map((key) => [key, row.data[key]])) })) };
  }
  if (action === "settings") {
    const profile = await readProfile(ctx); const settings = sanitizeSettings({ ...profile.ai_settings, ...(body.settings ?? body) });
    if (Array.isArray(body.providers)) {
      if (body.providers.length > 2) throw new AiError("invalid_request");
      for (const item of body.providers) {
        if (!["nvidia", "gemini"].includes(item.provider) || !modelFor(item.provider, item.model) || !["unknown", "free_confirmed", "paid"].includes(item.access) || typeof item.enabled !== "boolean") throw new AiError("invalid_request");
      }
      for (const item of body.providers) await patchProvider(ctx, item.provider, { enabled: item.enabled, model: item.model, access: item.access, generation_verified: false });
    }
    checked(await ctx.admin.from("profiles").update({ data: { ...profile, ai_settings: settings } }).eq("user_id", ctx.user.id));
    return { settings };
  }
  if (!["nvidia", "gemini"].includes(body.provider)) throw new AiError("invalid_provider");
  const provider = body.provider as Provider;
  if (action === "delete") {
    checked(await ctx.admin.from("ai_credentials").delete().eq("user_id", ctx.user.id).eq("provider", provider));
    await patchProvider(ctx, provider, { enabled: false, status: "not_configured", generation_verified: false, last_error: null, cooldown_until: null });
    return { provider, configured: false, status: "not_configured" };
  }
  if (!["save", "check"].includes(action)) throw new AiError("invalid_action");
  if (!master) throw new AiError("encryption_not_configured", 503);
  const row = checked(await ctx.admin.from("ai_providers").select("data").eq("user_id", ctx.user.id).eq("provider", provider).maybeSingle());
  const model = body.model ?? row?.data?.model ?? defaultModel(provider);
  if (!modelFor(provider, model)) throw new AiError("invalid_model");
  if (provider === "nvidia") {
    const settings = sanitizeSettings((await readProfile(ctx)).ai_settings);
    const access = action === "save" ? body.access ?? "unknown" : row?.data?.access ?? "unknown";
    if (!settings.allow_paid && access !== "free_confirmed") throw new AiError("billing_confirmation_required");
  }
  if (row?.data?.checked_at && Date.now() - Date.parse(row.data.checked_at) < 3000) throw new AiError("check_rate_limited", 429);
  let key: string;
  if (action === "save") {
    if (typeof body.key !== "string" || !body.key.trim() || body.key.length > 4096 || /[\r\n]/.test(body.key) || ![undefined, "unknown", "free_confirmed", "paid"].includes(body.access)) throw new AiError("invalid_credential");
    key = body.key.trim();
    // Validate master configuration before any external connection attempt.
    const encrypted = await encryptKey(key, ctx.user.id, provider, master);
    try { await checkConnection(provider, model, key, transport); } catch (error) { throw new AiError(error instanceof ProviderError ? error.code : "connection_failed", 422); }
    checked(await ctx.admin.from("ai_credentials").upsert({ user_id: ctx.user.id, provider, ...encrypted, data: { updated_at: new Date().toISOString() } }, { onConflict: "user_id,provider" }));
  } else {
    const record = checked(await ctx.admin.from("ai_credentials").select("ciphertext,iv,key_version").eq("user_id", ctx.user.id).eq("provider", provider).maybeSingle());
    if (!record) throw new AiError("credential_not_found", 404);
    key = await decryptKey(record, ctx.user.id, provider, master);
    try { await checkConnection(provider, model, key, transport); } catch (error) {
      const code = error instanceof ProviderError ? error.code : "connection_failed";
      await patchProvider(ctx, provider, { status: code === "auth_error" ? "auth_error" : "error", last_error: code, checked_at: new Date().toISOString() });
      throw new AiError(code, 422);
    }
  }
  await patchProvider(ctx, provider, { model, enabled: true, access: action === "save" ? body.access ?? "unknown" : row?.data?.access ?? "unknown", status: "connected", generation_verified: provider === "nvidia", connection_verified: true, checked_at: new Date().toISOString(), last_error: null, cooldown_until: null });
  return { provider, configured: true, status: "connected", connection_verified: true, generation_verified: provider === "nvidia" };
}
