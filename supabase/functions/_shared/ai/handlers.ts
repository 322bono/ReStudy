import { AppError, context, json, preflight } from "../context.ts";
import { AiError, credentialAction } from "./credentials.ts";
import { jobAction } from "./service.ts";
import {runStandard}from'../standard/ai.ts';

const messages: Record<string, string> = {
  credential_changed: "다른 화면에서 키가 변경됐습니다. 설정을 새로 불러와 주세요.",credential_id_required:"작업할 API 키를 선택해 주세요.",credential_duplicate:"이미 등록된 키입니다. 기존 키의 모델 목록을 갱신해 주세요.",credential_limit:"제공자별로 최대 20개 키를 등록할 수 있습니다.",invalid_quota_group:"한도 그룹은 영문·숫자·밑줄·마침표·콜론·하이픈으로 64자까지 입력하세요.",no_compatible_models:"현재 키에서 앱이 지원하는 모델을 찾지 못했습니다. 키 권한과 제공자의 모델 목록을 확인해 주세요.",connection_failed:"AI 연결을 확인하지 못했습니다. 기존 키는 보존했습니다.",
  request_invalid: "모델의 요청 형식 또는 출력 한도가 맞지 않습니다. 모델을 변경하거나 문항 수를 줄여 주세요.", model_access_denied: "이 키는 해당 모델에 접근할 권한이 없습니다. 키 권한과 모델 목록을 확인해 주세요.",
  invalid_request: "요청한 범위와 설정을 확인해 주세요.", json_required: "요청 형식을 확인해 주세요.", invalid_json: "요청 내용을 읽지 못했습니다.", request_too_large: "요청 범위를 줄여 주세요.", invalid_provider: "AI 제공자를 확인해 주세요.", invalid_model: "지원하는 모델을 선택해 주세요.", invalid_credential: "입력한 API 키를 확인해 주세요.", credential_not_found: "먼저 API 키를 등록해 주세요.", encryption_not_configured: "서버의 키 암호화 설정이 필요합니다.", billing_confirmation_required: "NVIDIA 연결 확인에는 짧은 요청이 필요합니다. 무료 전용 계정임을 확인하거나 유료 사용을 명시적으로 활성화해 주세요.", auth_error: "AI 키 인증에 실패했습니다. 키와 계정 권한을 확인해 주세요.", rate_limited: "AI 제공자의 호출 한도에 도달했습니다. 잠시 후 다시 확인해 주세요.", network_error: "AI 제공자에 연결하지 못했습니다. 잠시 후 다시 확인해 주세요.", model_unavailable: "모델 또는 계정의 접근 경로를 찾지 못했습니다. 현재 모델 목록과 키의 유효성을 확인해 주세요.", check_rate_limited: "연결 확인을 잠시 후 다시 시도해 주세요.", source_not_found: "접근할 수 있는 원본 자료를 찾지 못했습니다.", source_text_missing: "선택한 범위에 처리된 본문이 없습니다. 자료 인식 결과를 확인해 주세요.", source_text_too_large: "원문 분량이 큽니다. 범위를 더 작게 나누어 주세요.", source_citations_missing: "개념에 연결된 원본 자료의 출처를 먼저 등록해 주세요.", saved_crop_missing: "저장된 문제 이미지가 없습니다. 크롭을 먼저 저장해 주세요.", saved_crop_too_large: "문제 이미지가 큽니다. 범위를 더 작게 나누어 주세요.", invalid_saved_crop: "저장된 문제 이미지의 경로를 확인하지 못했습니다.", job_not_found: "저장된 AI 작업을 찾지 못했습니다.", mixed_subjects: "같은 과목의 자료만 함께 선택해 주세요.", material_not_ready: "자료 인식을 마친 후 다시 시도해 주세요.", invalid_page_range: "페이지 범위를 확인해 주세요. 예: 1-5, 8", material_page_limit_exceeded: "한 번에 60쪽까지 선택할 수 있습니다. 범위를 나누어 주세요.", material_request_too_broad: "선택한 범위가 넓습니다. 범위를 줄이거나 생성 개수를 늘려 주세요.", page_not_prepared: "아직 인식되지 않은 쪽이 있습니다. 자료 처리를 먼저 완료해 주세요.", question_limit_exceeded: "설정한 문제 생성 개수 한도를 넘었습니다.",
};

export async function handleAI(req: Request, kind: "credentials" | "request" | "analyze" | "generate"): Promise<Response> {
  const cors = preflight(req); if (cors) return cors;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, req);
  try {
    const ctx = await context(req);
    if (!req.headers.get("content-type")?.includes("application/json")) throw new AiError("json_required", 415);
    const text = await req.text();
    if (text.length > 32768) throw new AiError("request_too_large", 413);
    let body: any; try { body = JSON.parse(text); } catch { throw new AiError("invalid_json"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AiError("invalid_request");
    const master = Deno.env.get("RE_CREDENTIAL_MASTER_KEY") ?? "";
    let result;
    if(kind==='credentials')result=await credentialAction(body,ctx,master);
    else if(body.action==='run_standard')result=await runStandard(ctx,body.standardJobId,body.part,master);
    else if(['resume','status'].includes(body.action))result=await jobAction(body,ctx,master);
    else throw new AppError('자료 상세에서 restudy.v1 작업을 준비한 뒤 분석을 시작하세요.');
    return json(result, 200, req);
  } catch (error) {
    if (error instanceof Response) return error;
    // No raw exception messages, upstream response bodies or credentials in logs/responses.
    if (error instanceof AiError) return json({ error: messages[error.code] ?? "AI 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.", code: error.code }, error.status, req);
    if (error instanceof AppError) return json({ error: error.message }, error.status, req);
    return json({ error: "ai_request_failed" }, 500, req);
  }
}
