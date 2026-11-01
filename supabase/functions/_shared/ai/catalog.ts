import type { Provider } from "./crypto.ts";

export type ModelDefinition = { provider: Provider; id: string; label: string; text: boolean; image: boolean; structured: boolean; maxInputTokens: number; maxInputChars: number; roles: string[]; documentation: string };
// Capabilities from provider documentation, not an assertion of account quota or entitlement.
export const models: ModelDefinition[] = [
  { provider: "nvidia", id: "meta/llama-3.3-70b-instruct", label: "일반 개념 분석", text: true, image: false, structured: true, maxInputTokens: 131072, maxInputChars: 48000, roles: ["concept_analysis", "question_generation"], documentation: "https://docs.api.nvidia.com/nim/reference/meta-llama-3_3-70b-instruct-infer" },
  { provider: "gemini", id: "gemini-3.8-flash", label: "이미지 분석 · 개념 문제 생성", text: true, image: true, structured: true, maxInputTokens: 1048576, maxInputChars: 48000, roles: ["concept_analysis", "image_analysis", "question_generation"], documentation: "https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash" },
];
export function modelFor(provider: Provider, id: string): ModelDefinition | undefined { return models.find((model) => model.provider === provider && model.id === id); }
export function defaultModel(provider: Provider): string { return models.find((model) => model.provider === provider)!.id; }
