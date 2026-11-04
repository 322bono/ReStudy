import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowLeft,
  Check,
  Download,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { Button } from "../../components/ui";
import { NumberInput } from "../../components/number-input";
import "../styles/cloud.css";

type Provider = "nvidia" | "gemini";
type Mode =
  | "round_robin"
  | "nvidia_first"
  | "gemini_first"
  | "nvidia_only"
  | "gemini_only";
type ModelRole = "analysis" | "vision" | "generation";
type ModelChoice = { provider: Provider; model: string };
type Model = {
  id: string;
  label: string;
  supportsText?: boolean;
  supportsImages?: boolean;
  supportsJson?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  freeEligible?: boolean;
  generationVerified?: boolean;
  paid?: boolean;
};
type CredentialState = {
  id?: string;
  legacy: boolean;
  label: string;
  configured: boolean;
  enabled: boolean;
  status: string;
  access: "unknown" | "free_confirmed" | "paid";
  quotaGroup: string;
  connectionVerified: boolean;
  generationVerified: boolean;
  checkedAt?: string;
  cooldownUntil?: string;
  lastError?: string;
  notice?: string;
  models: Model[];
  selectedModels: string[];
};
type ProviderState = {
  provider: Provider;
  configured: boolean;
  status: string;
  models: Model[];
  access: "unknown" | "free_confirmed" | "paid";
  lastError?: string;
  notice?: string;
  credentials: CredentialState[];
};
type KeyEditor = { provider: Provider; credentialId?: string; legacy?: boolean };
type Preferences = {
  mode: Mode;
  dailyLimit: number;
  maxRetries: number;
  allowPaid: boolean;
  modelRoles: Partial<Record<ModelRole, ModelChoice>>;
};
type Row = Record<string, unknown>;
type SettingsData = Preferences & {
  providers: ProviderState[];
  freeProjectVerificationConfigured: boolean;
  usage: Row[];
  jobs: Row[];
};
export type SettingsProps = {
  transport: (action: string, payload?: unknown) => Promise<any>;
  onClose: () => void;
  onLogout: () => void | Promise<void>;
};

const providers: Provider[] = ["nvidia", "gemini"];
const providerNames = { nvidia: "NVIDIA NIM", gemini: "Google Gemini" };
const roles: { value: ModelRole; label: string }[] = [
  { value: "analysis", label: "일반 개념 분석" },
  { value: "vision", label: "이미지 포함 문제 분석" },
  { value: "generation", label: "개념 문제 생성" },
];
const tabs = [
  { id: "connections", label: "AI 연결" },
  { id: "activity", label: "작업·사용 기록" },
  { id: "data", label: "데이터" },
  { id: "account", label: "계정" },
] as const;
type Tab = (typeof tabs)[number]["id"];

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}
function text(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : "";
}
function first(row: Row, ...keys: string[]): unknown {
  for (const key of keys)
    if (row[key] !== undefined && row[key] !== null) return row[key];
  return undefined;
}
function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "요청을 처리하지 못했습니다. 다시 시도해 주세요.";
}
function readModels(value: unknown): Model[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Model[] => {
    if (typeof item === "string") return [{ id: item, label: item }];
    const model = record(item);
    const capabilities = record(model.capabilities);
    const id = text(model.id || model.model);
    if (!id) return [];
    const textInput =
      first(model, "supportsText", "supports_text", "text") ??
      first(capabilities, "text", "textInput");
    const images =
      first(model, "supportsImages", "supports_images", "image") ??
      first(capabilities, "images", "image", "imageInput");
    const json =
      first(model, "supportsJson", "supports_json", "structured") ??
      first(capabilities, "json", "structuredJson", "structured_output");
    const limit =
      first(model, "maxInputTokens", "max_input_tokens") ??
      first(capabilities, "maxInputTokens", "max_input_tokens");
    const paid = model.paid ?? capabilities.paid;
    const output = first(model, "maxOutputTokens", "max_output_tokens") ?? first(capabilities, "maxOutputTokens", "max_output_tokens");
    const free = first(model, "freeEligible", "free_eligible");
    return [
      {
        id,
        label: text(model.label || model.name) || id,
        ...(typeof textInput === "boolean" ? { supportsText: textInput } : {}),
        ...(typeof images === "boolean" ? { supportsImages: images } : {}),
        ...(typeof json === "boolean" ? { supportsJson: json } : {}),
        ...(typeof limit === "number" ? { maxInputTokens: limit } : {}),
        ...(typeof output === "number" ? { maxOutputTokens: output } : {}),
        ...(typeof free === "boolean" ? { freeEligible: free } : {}),
        generationVerified: model.generation_verified === true || model.generationVerified === true,
        ...(typeof paid === "boolean" ? { paid } : {}),
      },
    ];
  });
}
function readCredential(row: Row, index: number, fallbackModels: Model[], legacy = false): CredentialState {
  const credentialId = legacy ? "" : text(row.id);
  const selected = first(row, "selectedModels", "selected_models");
  if (!legacy && !credentialId) throw new Error("저장된 키 식별 정보를 확인하지 못했습니다. 설정을 다시 불러와 주세요.");
  return {
    ...(credentialId ? { id: credentialId } : {}), legacy,
    label: text(row.label).trim() || (legacy ? "기존 API 키" : `API 키 ${index + 1}`),
    configured: row.configured !== false,
    enabled: row.enabled !== false,
    status: text(row.status),
    access: row.access === "free_confirmed" || row.access === "paid" ? row.access : "unknown",
    quotaGroup: text(row.quotaGroup || row.quota_group).trim() || "shared",
    connectionVerified: row.connection_verified === true || row.connectionVerified === true,
    generationVerified: row.generation_verified === true || row.generationVerified === true,
    checkedAt: text(row.checked_at || row.checkedAt) || undefined,
    cooldownUntil: text(row.cooldown_until || row.cooldownUntil) || undefined,
    lastError: text(row.last_error || row.lastError) || undefined,
    notice: text(row.notice) || undefined,
    models: Array.isArray(row.models) ? readModels(row.models) : legacy ? fallbackModels : [],
    selectedModels: Array.isArray(selected)
      ? [...new Set(selected.filter((value): value is string => typeof value === "string"))]
      : legacy && typeof row.model === "string" ? [row.model] : [],
  };
}
function readSettings(value: unknown): SettingsData {
  const data = record(value);
  if (
    !Number.isInteger(data.dailyLimit) ||
    !Number.isInteger(data.maxRetries)
  ) {
    throw new Error("설정 응답을 확인하지 못했습니다. 다시 불러와 주세요.");
  }
  const rows = Array.isArray(data.providers) ? data.providers.map(record) : [];
  const savedRoles = record(data.modelRoles);
  const modelRoles: Preferences["modelRoles"] = {};
  for (const role of roles) {
    const choice = record(savedRoles[role.value]);
    if (
      providers.includes(choice.provider as Provider) &&
      typeof choice.model === "string"
    ) {
      modelRoles[role.value] = {
        provider: choice.provider as Provider,
        model: choice.model,
      };
    }
  }
  return {
    mode: data.mode as Mode,
    dailyLimit: data.dailyLimit as number,
    maxRetries: data.maxRetries as number,
    allowPaid: data.allowPaid === true,
    freeProjectVerificationConfigured: data.free_project_verification_configured === true,
    modelRoles,
    providers: providers.map((provider) => {
      const row = rows.find((item) => item.provider === provider) || {};
      const models = readModels(row.models);
      const credentials = Array.isArray(row.credentials)
        ? row.credentials.map((value, index) => readCredential(record(value), index, models))
        : row.configured === true ? [readCredential(row, 0, models, true)] : [];
      return {
        provider,
        configured: credentials.some((credential) => credential.configured),
        status: text(row.status),
        models,
        credentials,
        access:
          row.access === "free_confirmed" || row.access === "paid"
            ? row.access
            : "unknown",
        lastError: text(row.lastError || row.last_error) || undefined,
        notice: text(row.notice) || undefined,
      };
    }),
    usage: Array.isArray(data.usage) ? data.usage.map(record) : [],
    jobs: Array.isArray(data.jobs) ? data.jobs.map(record) : [],
  };
}
function connectionStatus(credential: CredentialState): {
  label: string;
  tone: string;
} {
  if (!credential.configured) return { label: "등록되지 않음", tone: "neutral" };
  if (!credential.enabled) return { label: "사용 중지", tone: "neutral" };
  if (
    ["error", "invalid", "auth_error", "unauthorized", "failed"].includes(
      credential.status,
    )
  )
    return { label: "연결 오류", tone: "error" };
  if (
    ["cooldown", "rate_limited", "limited", "paused"].includes(credential.status) ||
    !!credential.cooldownUntil && Date.parse(credential.cooldownUntil) > Date.now()
  )
    return { label: "일시 제한", tone: "warning" };
  if (credential.generationVerified) return { label: "생성 확인됨", tone: "success" };
  if (credential.connectionVerified) return { label: "연결 확인됨", tone: "success" };
  return { label: "키 저장됨 · 확인 필요", tone: "neutral" };
}
function dateTime(value: unknown): string {
  const raw = text(value);
  const date = new Date(raw);
  return raw && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date)
    : "—";
}
function jobStatus(value: unknown): string {
  const labels: Record<string, string> = {
    queued: "대기",
    pending: "대기",
    waiting: "보류",
    paused: "일시 중지",
    running: "처리 중",
    processing: "처리 중",
    retry: "재시도 대기",
    retry_wait: "재시도 대기",
    failed: "실패",
    error: "실패",
    blocked: "보류",
    rate_limited: "호출 제한",
    completed: "완료",
    succeeded: "완료",
    success: "완료",
    cancelled: "취소됨",
    needs_review: "학습 가능",
  };
  return labels[text(value)] || text(value) || "상태 확인 필요";
}
function usageTokens(row: Row): string {
  const usage = record(row.usage || row.tokenUsage || row.token_usage);
  const input =
    first(row, "inputTokens", "input_tokens") ??
    first(usage, "input_tokens", "prompt_tokens", "inputTokens");
  const output =
    first(row, "outputTokens", "output_tokens") ??
    first(usage, "output_tokens", "completion_tokens", "outputTokens");
  const total =
    first(row, "totalTokens", "total_tokens") ??
    first(usage, "total_tokens", "totalTokens");
  const parts = [
    typeof input === "number" ? `입력 ${input.toLocaleString()}` : "",
    typeof output === "number" ? `출력 ${output.toLocaleString()}` : "",
  ].filter(Boolean);
  return (
    parts.join(" · ") ||
    (typeof total === "number"
      ? `${total.toLocaleString()} 토큰`
      : "토큰 정보 없음")
  );
}
function taskLabel(value: unknown): string {
  const task = text(value);
  const labels: Record<string, string> = {
    concept_analysis: "개념 분석",
    image_analysis: "이미지 문제 분석",
    question_generation: "개념 문제 생성",
    analyze_problem: "문제 개념 분석",
    generate_questions: "개념 문제 생성",
    analyze: "개념 분석",
    generate: "문제 생성",
  };
  return labels[task] || task || "AI 작업";
}
function validatePackage(value: unknown): Row {
  const packageData = record(value);
  const tables = record(packageData.tables);
  if (
    packageData.schemaVersion !== 1 ||
    packageData.type !== "restudy-backup" ||
    !Object.keys(tables).length
  ) {
    throw new Error("RE:STUDY에서 내보낸 백업 JSON 파일을 선택해 주세요.");
  }
  let count = 0;
  for (const rows of Object.values(tables)) {
    if (
      !Array.isArray(rows) ||
      rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))
    ) {
      throw new Error(
        "백업 파일의 데이터 형식을 확인해 주세요. 테이블별 항목 목록이 필요합니다.",
      );
    }
    count += rows.length;
  }
  if (!count)
    throw new Error("이 백업 파일에는 복원할 학습 데이터가 없습니다.");
  const forbidden = new Set([
    "apikey",
    "api_key",
    "password",
    "access_token",
    "refresh_token",
    "service_role",
    "ai_credentials",
    "credentials",
    "master_key",
  ]);
  const pending: unknown[] = [packageData];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) {
      for (const child of item) pending.push(child);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.has(key.toLowerCase()))
        throw new Error(
          "인증 정보가 포함된 파일은 복원할 수 없습니다. RE:STUDY에서 내보낸 데이터 파일을 선택해 주세요.",
        );
      if (child && typeof child === "object") pending.push(child);
    }
  }
  return packageData;
}
function downloadFile(value: unknown) {
  const file = record(value);
  if (typeof file.content !== "string" || !text(file.filename))
    throw new Error("다운로드할 파일을 받지 못했습니다.");
  const url = URL.createObjectURL(
    new Blob([file.content], {
      type: text(file.mimeType) || "application/octet-stream",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = text(file.filename).replace(/[\\/]/g, "-");
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type CredentialAction = (busyId: string, action: string, payload: Row, success?: string) => Promise<boolean>;
function credentialPayload(provider: Provider, credential: CredentialState): Row {
  return { provider, ...(credential.id ? { credentialId: credential.id } : {}) };
}
function modelAllowed(model: Model, allowPaid: boolean) {
  return model.supportsText === true && model.supportsJson === true && (allowPaid || model.freeEligible === true);
}
function modelDetails(model: Model): string {
  return [
    model.supportsText !== undefined ? `텍스트 ${model.supportsText ? "지원" : "미지원"}` : "",
    model.supportsImages !== undefined ? `이미지 ${model.supportsImages ? "지원" : "미지원"}` : "",
    model.supportsJson !== undefined ? `JSON ${model.supportsJson ? "지원" : "미지원"}` : "",
    model.maxInputTokens !== undefined ? `입력 상한 ${model.maxInputTokens.toLocaleString()} 토큰` : "",
    model.maxOutputTokens !== undefined ? `출력 상한 ${model.maxOutputTokens.toLocaleString()} 토큰` : "",
    model.freeEligible === true ? "무료 사용 후보" : model.freeEligible === false ? "무료 경로 미허용" : "무료 사용 여부 미확인",
    model.generationVerified ? "이 모델의 생성 확인됨" : "이 모델의 생성 미확인",
  ].filter(Boolean).join(" · ");
}
function CredentialCard({ provider, credential, allowPaid, busy, onAction, onReplace }: {
  provider: Provider; credential: CredentialState; allowPaid: boolean; busy: string;
  onAction: CredentialAction; onReplace: () => void;
}) {
  const fieldId = useId(), [deleting, setDeleting] = useState(false);
  const [selected, setSelected] = useState(credential.selectedModels);
  const [quotaGroup, setQuotaGroup] = useState(credential.quotaGroup);
  const selectionKey = JSON.stringify(credential.selectedModels);
  useEffect(() => { setSelected(JSON.parse(selectionKey)); setQuotaGroup(credential.quotaGroup); }, [credential.id, selectionKey, credential.quotaGroup]);
  const state = connectionStatus(credential), payload = credentialPayload(provider, credential);
  const actionId = `${provider}-${credential.id || "legacy"}`;
  const dirty = JSON.stringify([...selected].sort()) !== JSON.stringify([...credential.selectedModels].sort()) || (quotaGroup.trim() || "shared") !== credential.quotaGroup;
  const missing = selected.filter((id) => !credential.models.some((model) => model.id === id));
  return <article className="cloud-credential" aria-labelledby={`${fieldId}-title`}>
    <div className="cloud-credential-head"><div><h4 id={`${fieldId}-title`}>{credential.label}</h4><span className={`cloud-status ${state.tone}`}><i />{state.label}</span></div><label className="cloud-check" htmlFor={`${fieldId}-enabled`}><input id={`${fieldId}-enabled`} type="checkbox" checked={credential.enabled} disabled={!!busy} onChange={(event) => onAction(`toggle-${actionId}`, "credential.toggle", { ...payload, enabled: event.target.checked, quotaGroup: credential.quotaGroup }, "키 사용 설정을 저장했습니다.")} /><span>이 키 사용</span></label></div>
    <div className="cloud-credential-facts"><span>{credential.access === "free_confirmed" ? "무료 사용 계정 · 사용자 확인" : credential.access === "paid" ? "유료 사용 계정" : "요금 상태 미확인"}</span><span>{credential.connectionVerified ? "연결 확인 이력 있음" : "연결 미확인"}</span><span>{credential.generationVerified ? "생성 호출 확인 이력 있음" : "생성 호출 미확인"}</span>{credential.checkedAt ? <span>최근 확인 {dateTime(credential.checkedAt)}</span> : null}{credential.cooldownUntil && Date.parse(credential.cooldownUntil) > Date.now() ? <span>다시 시도 가능 {dateTime(credential.cooldownUntil)}</span> : null}</div>
    {credential.lastError ? <p className="cloud-provider-error">{credential.lastError}</p> : null}
    {credential.notice ? <p className="cloud-key-help">{credential.notice}</p> : null}
    <div className="cloud-actions"><Button size="sm" variant="secondary" disabled={!!busy} busy={busy === `check-${actionId}`} onClick={() => onAction(`check-${actionId}`, "credential.check", payload, "키 확인 결과를 불러왔습니다.")}>연결 확인</Button><Button size="sm" variant="secondary" disabled={!!busy} busy={busy === `discover-${actionId}`} onClick={() => onAction(`discover-${actionId}`, "credential.discover", payload, "이 키의 모델 목록을 갱신했습니다.")}>모델 목록 갱신</Button><Button size="sm" variant="ghost" disabled={!!busy} onClick={onReplace}>키 교체</Button><Button size="sm" variant="ghost" className="cloud-danger-text" disabled={!!busy} onClick={() => setDeleting(true)}>삭제</Button></div>
    <details className="cloud-key-models"><summary>사용할 모델 · 선택 {selected.length}개</summary><p className="cloud-help">이 키에 대해 반환된 모델만 선택할 수 있습니다. 목록 조회와 생성 호출 확인은 별개이며, 잔여 할당량을 표시하지 않습니다.</p><div className="cloud-model-checklist">{credential.models.map((model) => {
      const checked = selected.includes(model.id), allowed = modelAllowed(model, allowPaid);
      const reason = model.supportsText !== true || model.supportsJson !== true ? "텍스트·JSON 지원 확인 필요" : !allowPaid && model.freeEligible !== true ? "현재 무료 경로에서 선택 불가" : "";
      return <label key={model.id} className="cloud-model-choice" htmlFor={`${fieldId}-model-${model.id}`}><input id={`${fieldId}-model-${model.id}`} type="checkbox" checked={checked} disabled={!!busy || !checked && !allowed} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, model.id])] : current.filter((id) => id !== model.id))} /><span><strong>{model.label}</strong>{model.label !== model.id ? <code>{model.id}</code> : null}<small>{modelDetails(model)}</small>{reason ? <small className="cloud-model-reason">{reason}</small> : null}</span></label>;
    })}{missing.map((modelId) => <label key={modelId} className="cloud-model-choice" htmlFor={`${fieldId}-missing-${modelId}`}><input id={`${fieldId}-missing-${modelId}`} type="checkbox" checked disabled={!!busy} onChange={() => setSelected((current) => current.filter((id) => id !== modelId))} /><span><strong>{modelId}</strong><small>현재 목록에서 확인되지 않은 저장된 선택 · 선택 해제 가능</small></span></label>)}</div>{!credential.models.length ? <p className="cloud-help">이 키에서 확인한 모델 목록이 없습니다. 모델 목록을 갱신해 주세요.</p> : null}
      <label className="cloud-field cloud-quota-group" htmlFor={`${fieldId}-group`}><span>한도 그룹</span><input id={`${fieldId}-group`} value={quotaGroup} maxLength={64} disabled={!!busy} placeholder="shared" onChange={(event) => setQuotaGroup(event.target.value)} /><small>같은 프로젝트·계정의 키는 같은 한도 그룹을 사용하세요.</small></label>
      {!selected.length ? <p className="cloud-help">선택한 모델이 없으면 이 키는 생성 작업에서 제외됩니다.</p> : null}
      <div className="cloud-actions">
        <Button size="sm" variant="secondary" disabled={!!busy || !dirty} busy={busy === `models-${actionId}`} onClick={() => onAction(`models-${actionId}`, "credential.toggle", { ...payload, enabled: credential.enabled, selectedModels: selected, quotaGroup: quotaGroup.trim() || "shared" }, "선택 모델과 한도 그룹을 저장했습니다.")}>선택 모델·한도 그룹 저장</Button>
        <Button size="sm" variant="ghost" disabled={!!busy || !credential.models.length} busy={busy === `auto-models-${actionId}`} onClick={() => onAction(`auto-models-${actionId}`, "credential.toggle", { ...payload, enabled: credential.enabled, autoModels: true, quotaGroup: quotaGroup.trim() || "shared" }, "이 키의 사용 가능한 모델을 자동으로 선택합니다.")}>사용 가능한 모델 자동 선택</Button>
      </div>
    </details>
    {deleting ? <div className="cloud-delete-confirm"><p>‘{credential.label}’ 키만 삭제할까요?</p><div className="cloud-actions"><Button variant="danger" size="sm" disabled={!!busy} busy={busy === `delete-${actionId}`} onClick={async () => { if (await onAction(`delete-${actionId}`, "credential.delete", payload, "선택한 API 키를 삭제했습니다.")) setDeleting(false); }}>이 키 삭제</Button><Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setDeleting(false)}>취소</Button></div></div> : null}
  </article>;
}

export default function Settings({
  transport,
  onClose,
  onLogout,
}: SettingsProps) {
  const id = useId();
  const tabsRef = useRef<HTMLElement>(null);
  const locked = useRef(false);
  const transportRef = useRef(transport);
  const mounted = useRef(true);
  const [tab, setTab] = useState<Tab>("connections");
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [draft, setDraft] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<KeyEditor | null>(null);
  const [keyLabel, setKeyLabel] = useState("");
  const [keyQuotaGroup, setKeyQuotaGroup] = useState("shared");
  const [keys, setKeys] = useState<Record<Provider, string>>({
    nvidia: "",
    gemini: "",
  });
  const [freeKeys, setFreeKeys] = useState<Record<Provider, boolean>>({
    nvidia: false,
    gemini: false,
  });
  const [deleting, setDeleting] = useState<Provider | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [passwordAgain, setPasswordAgain] = useState("");
  const [restore, setRestore] = useState<{
    filename: string;
    package: Row;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    transportRef.current = transport;
  }, [transport]);
  const reload = useCallback(async (resetDraft = false) => {
    const result = readSettings(await transportRef.current("settings"));
    if (!mounted.current) return;
    setSettings(result);
    setDraft((current) =>
      resetDraft || !current
        ? {
            mode: result.mode,
            dailyLimit: result.dailyLimit,
            maxRetries: result.maxRetries,
            allowPaid: result.allowPaid,
            modelRoles: result.modelRoles,
          }
        : current,
    );
  }, []);
  useEffect(() => {
    mounted.current = true;
    reload(true)
      .catch((cause) => {
        if (mounted.current) setError(errorMessage(cause));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  async function run(action: string, work: () => Promise<void>, success = "") {
    if (locked.current) return false;
    locked.current = true;
    setBusy(action);
    setError("");
    setMessage("");
    try {
      await work();
      if (mounted.current) setMessage(success);
      return true;
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
      return false;
    } finally {
      locked.current = false;
      if (mounted.current) setBusy("");
    }
  }
  function selectTab(next: Tab) {
    setTab(next);
    setError("");
    setMessage("");
    setKeys({ nvidia: "", gemini: "" });
    setFreeKeys({ nvidia: false, gemini: false });
    setEditing(null);
    setDeleting(null);
    setCurrentPassword("");
    setPassword("");
    setPasswordAgain("");
  }
  function tabKeyDown(event: KeyboardEvent<HTMLElement>) {
    const current = tabs.findIndex((item) => item.id === tab);
    const next =
      event.key === "ArrowRight"
        ? (current + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (current - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    selectTab(tabs[next].id);
    tabsRef.current
      ?.querySelectorAll<HTMLButtonElement>("[role=tab]")
      [next]?.focus();
  }
  async function saveKey(event: FormEvent, provider: Provider) {
    event.preventDefault();
    if (locked.current) return;
    const key = keys[provider].trim();
    if (!key) return;
    const access = freeKeys[provider] ? "free_confirmed" : "unknown";
    setKeys((current) => ({ ...current, [provider]: "" }));
    setFreeKeys((current) => ({ ...current, [provider]: false }));
    const saved = await run(
      `key-${provider}`,
      async () => {
        await transportRef.current("credential.save", {
          provider,
          key,
          access,
          credentialId: editing?.credentialId,
          label: keyLabel.trim() || undefined,
          quotaGroup: keyQuotaGroup.trim() || "shared",
        });
        await reload();
      },
      "API 키를 저장했습니다.",
    );
    if (saved) setEditing(null);
  }
  async function savePreferences(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (
      ![draft.dailyLimit, draft.maxRetries].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    ) {
      setError("사용 제한과 재시도 횟수는 0 이상의 정수로 입력해 주세요.");
      return;
    }
    await run(
      "preferences",
      async () => {
        await transportRef.current("settings.save", {...draft,mode:'gemini_only',allowPaid:false});
        await reload(true);
      },
      "AI 설정을 저장했습니다.",
    );
  }
  async function savePassword(event: FormEvent) {
    event.preventDefault();
    if (locked.current) return;
    if (password !== passwordAgain) {
      setError("새 비밀번호가 일치하지 않습니다.");
      return;
    }
    const submitted = { password, currentPassword };
    setCurrentPassword("");
    setPassword("");
    setPasswordAgain("");
    await run(
      "password",
      async () => {
        await transportRef.current("account.password", submitted);
      },
      "비밀번호를 변경했습니다.",
    );
  }
  const modelOptions = (settings?.providers || []).flatMap((provider) =>
    provider.models.map((model) => ({
      ...model,
      provider: provider.provider,
      value: `${provider.provider}:${model.id}`,
    })),
  );

  return (
    <section className="cloud-settings" aria-labelledby={`${id}-title`}>
      <header className="cloud-settings-head">
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="cloud-back"
          >
            <ArrowLeft size={15} />
            학습으로 돌아가기
          </Button>
          <h1 id={`${id}-title`}>설정</h1>
        </div>
        <Button
          variant="secondary"
          size="sm"
          busy={busy === "refresh"}
          disabled={!!busy || loading}
          onClick={() =>
            run("refresh", () => reload(), "최신 상태를 불러왔습니다.")
          }
        >
          <RefreshCw size={14} />
          새로고침
        </Button>
      </header>
      <nav
        className="cloud-tabs"
        ref={tabsRef}
        role="tablist"
        aria-label="설정 메뉴"
        onKeyDown={tabKeyDown}
      >
        {tabs.map((item) => (
          <Button
            key={item.id}
            variant="ghost"
            role="tab"
            id={`${id}-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`${id}-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => selectTab(item.id)}
            className={tab === item.id ? "cloud-tab active" : "cloud-tab"}
          >
            {item.label}
          </Button>
        ))}
      </nav>
      <div className="cloud-settings-feedback" aria-live="polite">
        {error ? (
          <p className="cloud-feedback error" role="alert">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="cloud-feedback success">
            <Check size={15} />
            {message}
          </p>
        ) : null}
      </div>
      {loading ? (
        <div className="cloud-loading" role="status">
          <LoaderCircle className="spin" size={20} />
          설정을 불러오는 중입니다.
        </div>
      ) : null}
      {!loading && !settings ? (
        <div className="cloud-empty">
          <p>설정을 불러오지 못했습니다.</p>
          <Button
            variant="secondary"
            busy={busy === "retry"}
            onClick={() => run("retry", () => reload(true))}
          >
            다시 불러오기
          </Button>
        </div>
      ) : null}
      {settings && draft ? (
        <div
          role="tabpanel"
          id={`${id}-panel-${tab}`}
          aria-labelledby={`${id}-tab-${tab}`}
          tabIndex={0}
          className="cloud-settings-panel"
        >
          {tab === "connections" ? (
            <>
              <section className="cloud-section">
                <div className="cloud-section-title">
                  <h2>AI 서비스</h2>
                  <p>{settings.freeProjectVerificationConfigured
                    ? "Gemini Flash는 Google에서 결제 미연결을 확인한 요청에만 사용합니다."
                    : "Gemma 4를 사용할 수 있습니다. Gemini Flash를 쓰려면 서버에 Google 결제 확인 연결이 필요합니다."}</p>
                </div>
                <div className="cloud-provider-grid">
                  {settings.providers.filter(provider=>provider.provider==='gemini').map((provider) => <article className="cloud-provider" key={provider.provider}>
                    <div className="cloud-provider-head"><h3>{providerNames[provider.provider]}</h3><span>{provider.credentials.length}개 키</span></div>
                    <div className="cloud-credential-list">{provider.credentials.map(credential => <CredentialCard key={credential.id || "legacy"} provider={provider.provider} credential={credential} allowPaid={draft.allowPaid} busy={busy}
                      onAction={(action, operation, payload, success) => run(action, async () => { try { await transportRef.current(operation, payload); } finally { await reload(); } }, success)}
                      onReplace={() => { setEditing({provider:provider.provider,credentialId:credential.id,legacy:credential.legacy});setKeyLabel(credential.label);setKeyQuotaGroup(credential.quotaGroup);setKeys({nvidia:"",gemini:""});setFreeKeys({nvidia:false,gemini:false}); }} />)}</div>
                    {editing?.provider === provider.provider ? <form className="cloud-form cloud-key-form" onSubmit={event => saveKey(event,provider.provider)}>
                      <h4>{editing.credentialId ? "선택한 키 교체" : "API 키 추가"}</h4>
                      <label className="cloud-field" htmlFor={`${id}-label-${provider.provider}`}><span>키 이름</span><input id={`${id}-label-${provider.provider}`} value={keyLabel} maxLength={60} disabled={!!busy} placeholder="예: 개인 무료 프로젝트" onChange={event=>setKeyLabel(event.target.value)} /></label>
                      <label className="cloud-field" htmlFor={`${id}-key-${provider.provider}`}><span>새 API 키</span><input id={`${id}-key-${provider.provider}`} type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" value={keys[provider.provider]} onChange={event=>setKeys(current=>({...current,[provider.provider]:event.target.value}))} disabled={!!busy} required autoFocus /></label>
                      <label className="cloud-field" htmlFor={`${id}-group-${provider.provider}`}><span>한도 그룹</span><input id={`${id}-group-${provider.provider}`} value={keyQuotaGroup} maxLength={64} disabled={!!busy} onChange={event=>setKeyQuotaGroup(event.target.value)} /><small>같은 프로젝트·계정의 키는 shared 등 같은 그룹을 사용하세요.</small></label>
                      <label className="cloud-key-free" htmlFor={`${id}-free-${provider.provider}`}><input id={`${id}-free-${provider.provider}`} type="checkbox" checked={freeKeys[provider.provider]} disabled={!!busy} onChange={event=>setFreeKeys(current=>({...current,[provider.provider]:event.target.checked}))} /><span>결제가 연결되지 않은 무료 사용 계정임을 확인했어요.</span></label>
                      <p className="cloud-key-help">무료 할당량이 끝나면 대기합니다. 다른 유료 모델을 호출하지 않습니다.</p>
                      <div className="cloud-actions"><Button type="submit" size="sm" busy={busy===`key-${provider.provider}`} disabled={!!busy || !keys[provider.provider].trim()}>확인 후 저장</Button><Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={()=>{setEditing(null);setKeys({nvidia:"",gemini:""});setFreeKeys({nvidia:false,gemini:false});}}>취소</Button></div>
                    </form> : <Button variant="secondary" size="sm" disabled={!!busy} onClick={()=>{setEditing({provider:provider.provider});setKeyLabel("");setKeyQuotaGroup("shared");setKeys({nvidia:"",gemini:""});setFreeKeys({nvidia:false,gemini:false});}}>API 키 추가</Button>}
                  </article>)}
                  <p className="cloud-help">사용 가능한 키와 선택 모델을 순서대로 배분합니다. 같은 프로젝트·계정의 한도는 키를 추가해도 늘어나지 않으며, 제한되면 해당 한도 그룹은 대기합니다.</p>
                </div>
              </section>
              <form className="cloud-preferences" onSubmit={savePreferences}>
                <section className="cloud-section">
                  <div className="cloud-section-title">
                    <h2>사용 방식</h2>
                    <p>
                      저장된 콘텐츠는 AI 연결 없이도 계속 학습할 수 있습니다.
                    </p>
                  </div>
                  <div className="cloud-form-grid">
                    <div className="cloud-field"><span>사용 모델</span><strong>무료 모델 자동 순환</strong><small>사용 가능한 모델을 번갈아 쓰고 한도에 걸린 모델은 잠시 건너뜁니다.</small></div>
                    <label className="cloud-field" htmlFor={`${id}-daily`}>
                      <span>하루 최대 AI 작업 수</span>
                      <NumberInput
                        id={`${id}-daily`}
                        min={0}
                        step={1}
                        required
                        value={
                          Number.isNaN(draft.dailyLimit)
                            ? undefined
                            : draft.dailyLimit
                        }
                        disabled={!!busy}
                        onValueChange={(dailyLimit) =>
                          setDraft({
                            ...draft,
                            dailyLimit,
                          })
                        }
                      />
                    </label>
                    <label className="cloud-field" htmlFor={`${id}-retries`}>
                      <span>작업당 최대 재시도 횟수</span>
                      <NumberInput
                        id={`${id}-retries`}
                        min={0}
                        step={1}
                        required
                        value={
                          Number.isNaN(draft.maxRetries)
                            ? undefined
                            : draft.maxRetries
                        }
                        disabled={!!busy}
                        onValueChange={(maxRetries) =>
                          setDraft({
                            ...draft,
                            maxRetries,
                          })
                        }
                      />
                    </label>
                  </div>
                  <p className="cloud-help">유료 호출은 서버에서 차단합니다. 기존 NVIDIA 키는 보관되며 호출에 사용하지 않습니다.</p>
                </section>
                <details className="cloud-advanced">
                  <summary>고급 모델 설정</summary>
                  <p className="cloud-help">
                    서버에 등록된 모델과 지원 정보를 표시합니다. 자동 선택은
                    작업에 맞는 모델을 서버에서 고릅니다.
                  </p>
                  <div className="cloud-model-roles">
                    {roles.map((role) => {
                      const selected = draft.modelRoles[role.value];
                      const selectedValue = selected
                        ? `${selected.provider}:${selected.model}`
                        : "";
                      const choices = modelOptions.filter(
                        (model) =>
                          model.supportsText === true &&
                          model.supportsJson === true &&
                          (role.value !== "vision" ||
                            model.supportsImages === true),
                      );
                      return (
                        <label
                          className="cloud-field"
                          key={role.value}
                          htmlFor={`${id}-role-${role.value}`}
                        >
                          <span>{role.label}</span>
                          <select
                            id={`${id}-role-${role.value}`}
                            disabled={!!busy}
                            value={selectedValue}
                            onChange={(event) => {
                              const option = modelOptions.find(
                                (model) => model.value === event.target.value,
                              );
                              const next = { ...draft.modelRoles };
                              if (option)
                                next[role.value] = {
                                  provider: option.provider,
                                  model: option.id,
                                };
                              else delete next[role.value];
                              setDraft({ ...draft, modelRoles: next });
                            }}
                          >
                            <option value="">자동 선택</option>
                            {selected &&
                            !choices.some(
                              (choice) => choice.value === selectedValue,
                            ) ? (
                              <option value={selectedValue}>
                                {providerNames[selected.provider]} ·{" "}
                                {selected.model} (목록 확인 필요)
                              </option>
                            ) : null}
                            {choices.map((model) => (
                              <option
                                key={model.value}
                                value={model.value}
                                disabled={
                                  model.paid === true && !draft.allowPaid
                                }
                              >
                                {providerNames[model.provider]} ·{" "}
                                {model.label !== model.id
                                  ? `${model.label} (${model.id})`
                                  : model.id}
                                {model.paid ? " · 유료" : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                  {settings.providers.map((provider) => (
                    <div
                      className="cloud-model-catalogue"
                      key={provider.provider}
                    >
                      <h3>{providerNames[provider.provider]}</h3>
                      {provider.models.length ? (
                        <ul>
                          {provider.models.map((model) => (
                            <li key={model.id}>
                              <strong>{model.label}</strong>
                              {model.label !== model.id ? (
                                <code>{model.id}</code>
                              ) : null}
                              <span>
                                {[
                                  model.supportsText !== undefined
                                    ? `텍스트 ${model.supportsText ? "지원" : "미지원"}`
                                    : "",
                                  model.supportsImages !== undefined
                                    ? `이미지 ${model.supportsImages ? "지원" : "미지원"}`
                                    : "",
                                  model.supportsJson !== undefined
                                    ? `JSON ${model.supportsJson ? "지원" : "미지원"}`
                                    : "",
                                  model.maxInputTokens !== undefined
                                    ? `최대 입력 ${model.maxInputTokens.toLocaleString()} 토큰`
                                    : "",
                                  model.paid !== undefined
                                    ? model.paid
                                      ? "유료"
                                      : "무료 사용 대상"
                                    : "",
                                ]
                                  .filter(Boolean)
                                  .join(" · ") || "지원 기능 확인 필요"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="cloud-help">
                          확인된 모델 정보가 없습니다.
                        </p>
                      )}
                    </div>
                  ))}
                </details>
                <div className="cloud-form-footer">
                  <Button
                    type="submit"
                    busy={busy === "preferences"}
                    disabled={!!busy}
                  >
                    설정 저장
                  </Button>
                </div>
              </form>
            </>
          ) : null}
          {tab === "activity" ? (
            <>
              <section className="cloud-section">
                <div className="cloud-section-title">
                  <h2>AI 작업</h2>
                  <p>보류된 작업을 확인하고 직접 재개할 수 있습니다.</p>
                </div>
                {settings.jobs.length ? (
                  <div className="cloud-job-list">
                    {settings.jobs.map((job, index) => {
                      const jobId = text(job.id);
                      const status = text(job.status);
                      const resumable = [
                        "queued",
                        "pending",
                        "waiting",
                        "paused",
                        "retry",
                        "retry_wait",
                        "failed",
                        "error",
                        "blocked",
                        "rate_limited",
                      ].includes(status);
                      const detail = text(
                        first(
                          job,
                          "lastError",
                          "last_error",
                          "error",
                          "error_message",
                        ),
                      );
                      const retryAt = first(
                        job,
                        "nextRetryAt",
                        "next_retry_at",
                        "retry_at",
                      );
                      return (
                        <article className="cloud-job" key={jobId || index}>
                          <div>
                            <h3>
                              {taskLabel(
                                first(
                                  job,
                                  "title",
                                  "label",
                                  "task",
                                  "kind",
                                  "type",
                                ),
                              )}
                              <span className="cloud-status neutral">
                                {jobStatus(status)}
                              </span>
                            </h3>
                            <p>
                              {dateTime(first(job, "createdAt", "created_at"))}
                              {typeof job.attempts === "number"
                                ? ` · ${job.attempts}회 시도`
                                : ""}
                              {retryAt
                                ? ` · 재시도 가능 ${dateTime(retryAt)}`
                                : ""}
                            </p>
                            {detail ? (
                              <p className="cloud-provider-error">{detail}</p>
                            ) : null}
                          </div>
                          {resumable && jobId ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={!!busy}
                              busy={busy === `job-${jobId}`}
                              onClick={() =>
                                run(
                                  `job-${jobId}`,
                                  async () => {
                                    await transportRef.current("job.resume", {
                                      id: jobId,
                                    });
                                    await reload();
                                  },
                                  "작업 상태를 갱신했습니다.",
                                )
                              }
                            >
                              재개
                            </Button>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="cloud-empty">저장된 AI 작업이 없습니다.</p>
                )}
              </section>
              <section className="cloud-section">
                <div className="cloud-section-title">
                  <h2>API 사용 기록</h2>
                  <p>실제 응답으로 확인된 사용량만 표시합니다.</p>
                </div>
                {settings.usage.length ? (
                  <div className="cloud-table-scroll">
                    <table className="cloud-usage">
                      <caption className="sr-only">
                        API 호출 결과와 실제 사용량
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">일시</th>
                          <th scope="col">제공자·모델</th>
                          <th scope="col">작업</th>
                          <th scope="col">결과</th>
                          <th scope="col">처리·사용량</th>
                        </tr>
                      </thead>
                      <tbody>
                        {settings.usage.map((entry, index) => {
                          const provider = text(entry.provider);
                          const duration = first(
                            entry,
                            "durationMs",
                            "duration_ms",
                            "latency_ms",
                          );
                          const errorDetail = text(
                            first(entry, "error", "lastError", "error_message"),
                          );
                          const success =
                            typeof entry.success === "boolean"
                              ? entry.success
                              : ["success", "completed", "succeeded"].includes(
                                    text(entry.status),
                                  )
                                ? true
                                : ["failed", "error"].includes(
                                      text(entry.status),
                                    )
                                  ? false
                                  : undefined;
                          return (
                            <tr key={text(entry.id) || index}>
                              <td>
                                {dateTime(
                                  first(
                                    entry,
                                    "createdAt",
                                    "created_at",
                                    "timestamp",
                                  ),
                                )}
                              </td>
                              <td>
                                {providerNames[provider as Provider] ||
                                  provider ||
                                  "—"}
                                <small>
                                  {text(
                                    first(
                                      entry,
                                      "model",
                                      "modelId",
                                      "model_id",
                                    ),
                                  ) || "—"}
                                </small>
                              </td>
                              <td>
                                {taskLabel(
                                  first(
                                    entry,
                                    "task",
                                    "kind",
                                    "taskType",
                                    "task_type",
                                    "type",
                                  ),
                                )}
                              </td>
                              <td>
                                <span
                                  className={`cloud-status ${success === true ? "success" : success === false ? "error" : "neutral"}`}
                                >
                                  {success === true
                                    ? "성공"
                                    : success === false
                                      ? "실패"
                                      : jobStatus(entry.status)}
                                </span>
                                {errorDetail ? (
                                  <small className="cloud-provider-error">
                                    {errorDetail}
                                  </small>
                                ) : null}
                              </td>
                              <td>
                                {typeof duration === "number"
                                  ? `${(duration / 1000).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}초`
                                  : "처리 시간 정보 없음"}
                                <small>{usageTokens(entry)}</small>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="cloud-empty">아직 API 사용 기록이 없습니다.</p>
                )}
              </section>
            </>
          ) : null}
          {tab === "data" ? (
            <>
              <section className="cloud-section">
                <div className="cloud-section-title">
                  <h2>데이터 내보내기</h2>
                  <p>학습 데이터와 콘텐츠를 파일로 보관합니다.</p>
                </div>
                <div className="cloud-data-card">
                  <ShieldCheck size={21} />
                  <p>
                    API 키와 비밀번호는 내보내기에 포함하지 않습니다.
                    <br />
                    원본 PDF와 이미지 파일은 포함하지 않습니다.
                  </p>
                </div>
                <div className="cloud-actions">
                  <Button
                    variant="secondary"
                    disabled={!!busy}
                    busy={busy === "export-json"}
                    onClick={() =>
                      run("export-json", async () =>
                        downloadFile(
                          await transportRef.current("data.export", {
                            format: "json",
                            includeOriginals: false,
                          }),
                        ),
                      )
                    }
                  >
                    <Download size={15} />
                    JSON 내보내기
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!!busy}
                    busy={busy === "export-csv"}
                    onClick={() =>
                      run("export-csv", async () =>
                        downloadFile(
                          await transportRef.current("data.export", {
                            format: "csv",
                            includeOriginals: false,
                          }),
                        ),
                      )
                    }
                  >
                    <Download size={15} />
                    CSV 내보내기
                  </Button>
                </div>
              </section>
              <section className="cloud-section">
                <div className="cloud-section-title">
                  <h2>데이터 복원</h2>
                  <p>
                    RE:STUDY에서 내보낸 JSON 파일을 선택합니다. 서버 검증 후
                    복원합니다.
                  </p>
                </div>
                <input
                  className="sr-only"
                  ref={fileRef}
                  id={`${id}-restore`}
                  type="file"
                  accept=".json,application/json"
                  disabled={!!busy}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    if (file.size > 20 * 1024 * 1024) {
                      setError("20MB 이하의 JSON 백업을 선택하세요.");
                      return;
                    }
                    setRestore(null);
                    await run("read-restore", async () => {
                      let parsed: unknown;
                      try {
                        parsed = JSON.parse(await file.text());
                      } catch {
                        throw new Error(
                          "JSON 파일을 읽지 못했습니다. 파일 형식을 확인해 주세요.",
                        );
                      }
                      setRestore({
                        filename: file.name,
                        package: validatePackage(parsed),
                      });
                    });
                  }}
                />
                <Button
                  variant="secondary"
                  disabled={!!busy}
                  busy={busy === "read-restore"}
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload size={15} />
                  JSON 파일 선택
                </Button>
                {restore ? (
                  <div className="cloud-restore">
                    <div>
                      <strong>{restore.filename}</strong>
                      <p>
                        파일을 선택했습니다. 복원하면 파일의 학습 데이터가
                        계정에 적용됩니다.
                      </p>
                    </div>
                    <div className="cloud-actions">
                      <Button
                        disabled={!!busy}
                        busy={busy === "restore"}
                        onClick={() =>
                          run(
                            "restore",
                            async () => {
                              await transportRef.current("data.restore", {
                                package: restore.package,
                              });
                              setRestore(null);
                              await reload();
                            },
                            "데이터를 복원했습니다.",
                          )
                        }
                      >
                        데이터 복원
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!!busy}
                        onClick={() => setRestore(null)}
                      >
                        취소
                      </Button>
                    </div>
                  </div>
                ) : null}
              </section>
            </>
          ) : null}
          {tab === "account" ? (
            <>
              <section className="cloud-section">
                <div className="cloud-section-title">
                  <h2>비밀번호 변경</h2>
                </div>
                <form
                  className="cloud-form cloud-account-form"
                  onSubmit={savePassword}
                >
                  <label
                    className="cloud-field"
                    htmlFor={`${id}-current-password`}
                  >
                    <span>현재 비밀번호</span>
                    <input
                      id={`${id}-current-password`}
                      type="password"
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(event) =>
                        setCurrentPassword(event.target.value)
                      }
                      disabled={!!busy}
                      required
                    />
                  </label>
                  <label className="cloud-field" htmlFor={`${id}-new-password`}>
                    <span>새 비밀번호</span>
                    <input
                      id={`${id}-new-password`}
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      disabled={!!busy}
                      required
                    />
                  </label>
                  <label
                    className="cloud-field"
                    htmlFor={`${id}-password-again`}
                  >
                    <span>새 비밀번호 확인</span>
                    <input
                      id={`${id}-password-again`}
                      type="password"
                      autoComplete="new-password"
                      value={passwordAgain}
                      onChange={(event) => setPasswordAgain(event.target.value)}
                      disabled={!!busy}
                      required
                    />
                  </label>
                  <Button
                    type="submit"
                    disabled={
                      !!busy || !currentPassword || !password || !passwordAgain
                    }
                    busy={busy === "password"}
                  >
                    비밀번호 변경
                  </Button>
                </form>
              </section>
              <section className="cloud-section cloud-logout">
                <div>
                  <h2>로그아웃</h2>
                  <p className="cloud-help">
                    이 기기의 로그인 상태를 종료합니다.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  disabled={!!busy}
                  busy={busy === "logout"}
                  onClick={() =>
                    run("logout", async () => {
                      await onLogout();
                    })
                  }
                >
                  로그아웃
                </Button>
              </section>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
