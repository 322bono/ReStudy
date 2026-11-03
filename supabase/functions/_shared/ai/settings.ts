import { defaultModel, modelFor, isGenerationModel } from "./catalog.ts";
import type { Provider } from "./crypto.ts";
import type { Mode, ProviderState } from "./router.ts";
import type { Json } from "./schemas.ts";
export type Settings = { mode: Mode; allow_paid: boolean; daily_limit: number; max_attempts: number; max_questions: number; modelRoles?: Json };
export const defaultSettings: Settings = { mode: "gemini_only", allow_paid: false, daily_limit: 20, max_attempts: 3, max_questions: 20 };
export function sanitizeSettings(raw: Json = {}): Settings {
  const modelRoles: Json = {};
  for (const role of ["analysis", "vision", "generation"]) {
    const choice = raw.modelRoles?.[role]; const model = choice && modelFor(choice.provider, choice.model);
    if (model?.text && model.structured && isGenerationModel(model.provider, model.id) && (role !== "vision" || model.image)) modelRoles[role] = { provider: model.provider, model: model.id };
  }
  return { mode: "gemini_only", allow_paid: false, daily_limit: Number.isInteger(raw.daily_limit) ? Math.min(100, Math.max(1, raw.daily_limit)) : 20, max_attempts: Number.isInteger(raw.max_attempts) ? Math.min(5, Math.max(1, raw.max_attempts)) : 3, max_questions: Number.isInteger(raw.max_questions) ? Math.min(20, Math.max(1, raw.max_questions)) : 20, modelRoles };
}
export function providerState(provider: Provider, data: Json = {}, configured = false): ProviderState {
  return { provider, enabled: configured && data.enabled !== false, model: modelFor(provider, data.model) ? data.model : defaultModel(provider), access: ["unknown", "free_confirmed", "paid"].includes(data.access) ? data.access : "unknown", access_confirmation: data.access === "free_confirmed" ? "user" : null, status: configured ? data.status ?? "unverified" : "not_configured", cooldown_until: typeof data.cooldown_until === "string" ? data.cooldown_until : undefined, configured, connection_verified: configured && data.connection_verified === true, generation_verified: configured && data.generation_verified === true, checked_at: data.checked_at ?? null, last_error: data.last_error ?? null };
}
