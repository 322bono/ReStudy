import type { Provider } from "./crypto.ts";

export const catalogVersion='2026-11-03-no-charge-gemma4';
export const generationContractVersion='validated-json-v2-gemma4';
const nvidiaOrder=['nvidia/nemotron-3.5-lightning-30b-a3b','nvidia/nemotron-3.5-bolt-e4b','openai/gpt-oss-20b','nvidia/nemotron-3.5-super-vl-120b-a12b','nvidia/nemotron-3-super-120b-a12b','nvidia/nemotron-3-ultra-550b-a55b'];
export function nvidiaModelRank(id:string){const index=nvidiaOrder.indexOf(id);return index<0?nvidiaOrder.length:index;}
export type ModelDefinition = { provider: Provider; id: string; label: string; text: boolean; image: boolean; structured: boolean; maxInputTokens: number; maxInputChars: number; roles: string[]; documentation: string; maxOutputTokens?: number; requestModel?:string; nvidiaThinking?:'disabled'; nvidiaReasoningEffort?: 'none'|'low'; geminiThinkingLevel?:'LOW'|'MINIMAL'; freeEligible?: boolean; pricingDocumentation?: string; legacy?: boolean };
// Request fields rechecked against official documentation and NVIDIA /v1/models
// on 2026-11-04. Catalog version above tracks the unchanged no-charge policy.
// Eligibility is not a claim about a particular key's billing or quota.
// NVIDIA's public list does not authenticate a key. Its hosted endpoint output
// limit can be lower than the model's context window (notably GPT-OSS-20B).
export const models: ModelDefinition[] = [
  { provider: "nvidia", id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super · 개념·문제", text: true, image: false, structured: true, maxInputTokens: 1000000, maxInputChars: 48000, maxOutputTokens: 32768, nvidiaReasoningEffort: 'none', roles: ["concept_analysis", "question_generation"], documentation: "https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b-infer" },
  { provider: "nvidia", id: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "Nemotron 3.5 Lightning · 빠른 생성", text: true, image: false, structured: true, maxInputTokens: 1000000, maxInputChars: 48000, maxOutputTokens: 32768, nvidiaThinking: 'disabled', roles: ["concept_analysis", "question_generation"], documentation: "https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-lightning-30b-a3b-infer" },
  { provider: "nvidia", id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra · 개념·문제", text: true, image: false, structured: true, maxInputTokens: 1000000, maxInputChars: 48000, maxOutputTokens: 32768, nvidiaReasoningEffort: 'none', roles: ["concept_analysis", "question_generation"], documentation: "https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-ultra-550b-a55b-infer" },
  { provider: "nvidia", id: "openai/gpt-oss-20b", label: "GPT OSS 20B · 짧은 생성", text: true, image: false, structured: true, maxInputTokens: 128000, maxInputChars: 48000, maxOutputTokens: 4096, nvidiaReasoningEffort: 'low', roles: ["concept_analysis", "question_generation"], documentation: "https://docs.api.nvidia.com/nim/reference/openai-gpt-oss-20b-infer" },
  { provider: "nvidia", id: "nvidia/nemotron-3.5-bolt-e4b", requestModel:'stg/nvidia/nemotron-3.5-bolt-e4b', label: "Nemotron 3.5 Bolt E4B · 짧은 본문", text: true, image: false, structured: true, maxInputTokens: 65536, maxInputChars: 24000, maxOutputTokens: 65536, nvidiaThinking:'disabled', roles:["concept_analysis","question_generation"], documentation:'https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-bolt-e4b-infer' },
  { provider: "nvidia", id: "nvidia/nemotron-3.5-super-vl-120b-a12b", label: "Nemotron 3.5 Super VL · 이미지·문제", text: true, image: true, structured: true, maxInputTokens: 1000000, maxInputChars: 48000, maxOutputTokens: 131072, nvidiaReasoningEffort:'none', roles:["concept_analysis","image_analysis","question_generation"], documentation:'https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-super-vl-120b-a12b-infer' },
  // Existing saved selections remain readable. This ID was absent from the live
  // public list; never add it to an automatically discovered model pool unless
  // the provider actually returns it again. Documentation alone is insufficient.
  { provider: "nvidia", id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 · 기존 설정", text: true, image: false, structured: true, maxInputTokens: 131072, maxInputChars: 48000, maxOutputTokens: 4096, legacy: true, roles: ["concept_analysis", "question_generation"], documentation: "https://docs.api.nvidia.com/nim/reference/meta-llama-3_3-70b-instruct-infer" },
  { provider: "gemini", id: "gemini-3.8-flash", label: "Gemini 3.8 Flash · 이미지·문제", text: true, image: true, structured: true, maxInputTokens: 1048576, maxInputChars: 48000, maxOutputTokens: 65536, freeEligible: true, pricingDocumentation: 'https://ai.google.dev/gemini-api/docs/pricing', roles: ["concept_analysis", "image_analysis", "question_generation"], documentation: "https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash" },
  { provider: "gemini", id: "gemini-3.6-flash", label: "Gemini 3.6 Flash · 이미지·문제", text: true, image: true, structured: true, maxInputTokens: 1048576, maxInputChars: 48000, maxOutputTokens: 65536, freeEligible: true, pricingDocumentation: 'https://ai.google.dev/gemini-api/docs/pricing', roles: ["concept_analysis", "image_analysis", "question_generation"], documentation: "https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash" },
  { provider: "gemini", id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite · 빠른 처리", text: true, image: true, structured: true, maxInputTokens: 1048576, maxInputChars: 48000, maxOutputTokens: 65536, freeEligible: true, pricingDocumentation: 'https://ai.google.dev/gemini-api/docs/pricing', roles: ["concept_analysis", "image_analysis", "question_generation"], documentation: "https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite" },
  { provider: "gemini", id: "gemma-4-26b-a4b-it", label: "Gemma 4 26B A4B · 무료 본문·이미지", text:true,image:true,structured:true,maxInputTokens:262144,maxInputChars:48000,maxOutputTokens:8192,geminiThinkingLevel:'MINIMAL',freeEligible:true,pricingDocumentation:'https://ai.google.dev/gemini-api/docs/pricing',roles:['concept_analysis','image_analysis','question_generation'],documentation:'https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api' },
  { provider: "gemini", id: "gemma-4-31b-it", label: "Gemma 4 31B · 무료 본문·이미지", text:true,image:true,structured:true,maxInputTokens:262144,maxInputChars:48000,maxOutputTokens:8192,geminiThinkingLevel:'MINIMAL',freeEligible:true,pricingDocumentation:'https://ai.google.dev/gemini-api/docs/pricing',roles:['concept_analysis','image_analysis','question_generation'],documentation:'https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api' },
];
export function modelFor(provider: Provider, id: string): ModelDefinition | undefined { return models.find((model) => model.provider === provider && model.id === id); }
// This is an application policy, not a user-editable billing preference. Gemini
// Flash has both free and paid rates; key metadata cannot prove a free project.
// Gemma 4's documented paid tier is unavailable (checked 2026-11-03):
// https://ai.google.dev/gemini-api/docs/pricing#gemma-4
// Keep historic definitions above readable without permitting their execution.
export function isGenerationModel(provider: Provider, id: string): boolean {
  return provider === 'gemini' && (id === 'gemma-4-26b-a4b-it' || id === 'gemma-4-31b-it');
}
export const generationModels = models.filter(model => isGenerationModel(model.provider, model.id));
export function generationModelRank(id: string): number { return id === 'gemma-4-26b-a4b-it' ? 0 : 1; }
export function defaultModel(provider: Provider): string { return (generationModels.find(model => model.provider === provider) ?? models.find(model => model.provider === provider && !model.legacy))!.id; }
