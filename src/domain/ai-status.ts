const messages:Record<string,string>={timeout:'AI 응답을 110초 동안 기다렸지만 대기 시간이 초과됐습니다. 저장된 분할부터 다시 이어갈 수 있습니다.',network_error:'AI 제공자 연결이 끊겼습니다. 저장된 작업에서 다시 시도할 수 있습니다.',provider_error:'AI 제공자 서버에서 오류가 발생했습니다.',rate_limited:'AI 제공자의 사용 한도에 도달했습니다. 표시된 재시도 시각 이후에 다시 진행하세요.',auth_error:'API 키 인증에 실패했습니다. 설정에서 키를 확인하세요.',model_access_denied:'이 키에서 해당 모델을 사용할 권한이 없습니다.',model_unavailable:'해당 모델의 접근 경로를 찾지 못했습니다.',request_invalid:'모델이 요청 형식이나 출력 한도를 거절했습니다.',invalid_response:'AI 응답이 필요한 JSON 구조와 맞지 않아 저장하지 않았습니다.',source_text_too_large:'요청 본문이 모델 한도를 넘습니다. 범위를 줄여 주세요.',billing_confirmation_required:'무료 사용 계정 여부를 설정에서 확인해 주세요.',no_available_provider:'사용 가능한 키·모델이 없습니다. 연결 상태, 선택 모델과 무료 사용 확인을 점검하세요.',all_providers_failed:'이번 실행을 완료하지 못했습니다. 저장된 분할을 이어서 준비할 수 있습니다.',processing_failed:'결과 처리 또는 저장 중 오류가 발생했습니다. 저장된 작업을 다시 이어갈 수 있습니다.'};
messages.free_only_policy='무료 전용 Gemma 4 모델만 호출할 수 있습니다. 설정에서 Google API 연결을 확인하세요.';
messages.source_incomplete='모델이 원본에서 풀이에 필요한 조건을 읽지 못했습니다. 출처 보기에서 지문·보기·그림이 모두 포함됐는지 확인한 뒤 다시 분석해 주세요.';
export const aiFailureText=(code:unknown)=>typeof code==='string'?(messages[code]??'작업을 완료하지 못했습니다. 연결 설정과 최근 시도 내역을 확인하세요.'):'아직 완료된 결과가 없습니다.';
const diagnostics:Record<string,string>={
 credential_header_invalid:'API 키의 빈 값·공백·헤더 형식을 확인해 주세요.',
 prompt_invalid:'전송할 본문은 비어 있지 않은 문자열이어야 하며 모델 분량 제한 안에 있어야 합니다.',
 task_invalid:'지원하는 학습 작업 종류인지 확인해 주세요.',
 images_invalid:'문제 이미지는 저장된 이미지 배열로 최대 6개까지 전달합니다.',
 image_mime_invalid:'이미지 MIME 형식은 PNG·JPEG·WebP여야 합니다.',
 image_base64_invalid:'문제 이미지의 Base64 형식이 올바르지 않습니다. 저장된 원본 이미지를 확인해 주세요.',
 request_size_exceeded:'본문·이미지·Base64를 포함한 요청이 20MB를 넘습니다. 문제 범위를 줄여 주세요.',
 timeout_invalid:'API 요청의 제한시간 값이 올바르지 않습니다.',
 account_precondition:'제공자 계정의 지역·키 제한 등 사용 조건을 확인해 주세요. 유료 모델로 전환하지 않습니다.',
 model_configuration:'제공자가 모델 ID 또는 모델 지원 기능을 거절했습니다.',
 schema_rejected:'제공자가 JSON 스키마 옵션을 거절했습니다.',
 response_format_rejected:'제공자가 응답 형식 옵션을 거절했습니다.',
 thinking_rejected:'제공자가 추론 설정 값을 거절했습니다.',
 output_limit_rejected:'제공자가 출력 토큰 한도를 거절했습니다.',
 store_rejected:'제공자가 저장 옵션을 지원하지 않습니다.',
};
export const aiDiagnosticText=(code:unknown)=>typeof code==='string'?(diagnostics[code]??''):'';
export function apiProgress(jobs:any[],totalParts:number,importedQuestions:number,failure?:any){
 const completed=jobs.filter(j=>j.status==='completed').length,running=jobs.find(j=>j.status==='running'),stopped=jobs.find(j=>['paused','failed','retry_wait'].includes(j.status));
 const state=running?'running':failure||stopped?'paused':completed===totalParts&&totalParts>0?'completed':jobs.length?'waiting':'not_started';
 const error=stopped?.provider_error??stopped?.last_error??failure?.code;
 return{state,completed,totalParts,pending:Math.max(0,totalParts-completed),importedQuestions,message:state==='paused'?(failure?.message??stopped?.detail??aiFailureText(error)):state==='running'?`분할 ${running.part} 응답을 기다리고 있습니다.`:state==='completed'?'저장 완료 · 학습에서 바로 사용할 수 있습니다.':state==='waiting'?'다음 API 분할이 대기 중입니다. 이어서 준비를 누르면 진행합니다.':'API로 준비를 실행하면 진행 상황과 결과가 여기에 표시됩니다.',errorCode:error??null};
}
