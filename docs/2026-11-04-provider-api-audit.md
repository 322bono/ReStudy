# 2026-11-04 외부 AI API 명세 대조

현재 코드가 실제로 전송하는 HTTP 요청을 공식 REST 문서와 대조했다. 공급자 호출은 기존 무료 전용 Gemma 4 두 모델만 허용하며 이 검증을 이유로 유료 모델·NVIDIA 추론을 활성화하지 않는다. NVIDIA 공개 모델 목록 조회는 메타데이터 확인이며 키 인증·추론 성공 검사가 아니다.

## Google: 현재 실행되는 요청

| 항목 | 앱의 전송 값 | 확인 |
| --- | --- | --- |
| 메서드·경로 | `POST /v1beta/models/{model}:generateContent` | 공식 Gemma REST 경로 |
| 모델 | `gemma-4-26b-a4b-it`, `gemma-4-31b-it` | 공식 지원 목록과 일치 |
| 인증 | `x-goog-api-key: <서버에서 복호화한 키>` | URL·브라우저에 키를 넣지 않음 |
| 본문 형식 | `Content-Type: application/json`, `Accept: application/json` | JSON 요청·비스트리밍 응답 |
| 사용자 입력 | `contents: [{role: "user", parts: [...]}]` | 배열, parts의 text는 문자열 |
| 시스템 지침 | `systemInstruction.parts[].text` | Gemma 문서에 명시됨 |
| 이미지 | `inlineData: {mimeType, data}` | data는 Data URL 접두어가 없는 Base64 문자열 |
| 추론 | `generationConfig.thinkingConfig.thinkingLevel: "MINIMAL"` | REST enum 및 Gemma의 minimal 모드 |
| 출력 개수 한도 | 정수 `maxOutputTokens`, 앱에서는 최대 8192 | 앱의 보수적 출력 예산이며 모델 최대치라는 의미가 아님 |
| JSON 출력 옵션 | 프롬프트로 요청하고 반환값을 앱에서 검증 | Gemma 전용 문서로 확인되지 않은 네이티브 JSON Schema 옵션은 전송하지 않음 |
| 전체 입력 크기 | 직렬화한 UTF-8 JSON을 20,000,000바이트 이하로 검사 | 텍스트·시스템 지침·Base64·JSON 오버헤드 포함 |

`v1beta`는 현재 공식 generateContent 경로다. 별도 Interactions API의 `Api-Revision` 헤더, `input`, `response_format`, `store` 등의 계약을 이 경로와 섞지 않는다. `restudy.v1`은 모델이 만들어야 하는 **앱의 결과 데이터 계약**으로 프롬프트에 전달한다. API 요청의 최상위 필드는 `contents`, `systemInstruction`, `generationConfig`다.

모델 목록은 `GET /v1beta/models?pageSize=1000`, 다음 페이지는 같은 조건의 `pageToken`으로 확인한다. 연결 검사 `GET /v1beta/models/{model}`은 메타데이터 접근만 검증하며 JSON 생성 성공으로 표시하지 않는다.

## NVIDIA: 보관된 모델 설정 대조

공식 공개 `/v1/models`에 기존 여섯 모델 ID가 있음을 확인했다. 실행은 무료 전용 정책으로 계속 차단한다.

| 모델 | 최신 문서와 대조한 필드 |
| --- | --- |
| Nemotron 3 Super | `reasoning_effort: "none"`, `max_tokens` 상한 32768 |
| Nemotron 3 Ultra | `reasoning_effort: "none"`, `max_tokens` 상한 32768 |
| Nemotron 3.5 Super VL | `reasoning_effort: "none"`, `max_tokens` 상한 131072 |
| Nemotron 3.5 Lightning | `chat_template_kwargs.enable_thinking: false`, 출력 상한 32768 |
| Nemotron 3.5 Bolt E4B | gateway 요청 모델은 **`stg/nvidia/nemotron-3.5-bolt-e4b`**, `enable_thinking: false`, 출력 상한 65536 |
| GPT OSS 20B | `reasoning_effort: "low"`, 출력 상한 4096 |

Super·Ultra·Super VL은 권장되는 최상위 reasoning_effort로 맞췄다. Bolt의 stg 별칭은 공식 문서의 명시적인 예외이므로 지우지 않았다. NVIDIA의 JSON 모드·도구 지원 및 계정 권한을 공통 OpenAI 형식이라는 이유만으로 보장하지 않는다. 이번에는 NVIDIA 실제 추론을 호출하지 않았다.

## 코드 보강과 검증

- 잘못된 작업 종류, 문자열이 아닌/빈/과도한 본문을 HTTP 호출 전 거절한다.
- 배열이 아닌 이미지, 지원하지 않는 MIME, 잘못된 Base64·패딩·Data URL 접두어를 거절한다. 앱의 저장 이미지 형식은 PNG·JPEG·WebP이며 한 요청에 최대 6개다.
- API 키의 빈 값·공백·헤더 제어문자, 잘못된 제한시간을 전송 전에 거절한다. 키의 고정 접두어를 가정하지 않는다.
- 전체 요청 바이트 수를 검사한다. PDF 업로드 자체의 용량 제한과는 별개다.
- 잘못된 본문을 모델·키 사용 불가로 오인하거나 여러 키로 재시도하지 않는다. 검증 실패는 키의 정상 상태를 훼손하지 않는다.
- 호출 내역에는 사전에 정한 한국어 진단 분류만 표시한다. 제공자의 원문 오류, 키, 문제 본문을 로그에 남기지 않는다.
- 회귀 검사는 실제 전송 URL·헤더·직렬화한 JSON을 가로채 두 Gemma 모델의 계약을 검사한다. 유효하지 않은 입력은 HTTP 요청이 0회임을 확인한다. 테스트는 가짜 transport를 사용하며 사용자 DB에 결과를 넣지 않는다.

## 오류를 구분해서 해석

400은 파라미터 오류뿐 아니라 계정 선행 조건 실패일 수도 있다. 429는 호출 한도, 5xx는 제공자 서버 실패다. HTTP 성공 후 `restudy.v1` 검증 실패는 모델이 만든 결과의 문제이며 헤더 오류로 취급하지 않는다. 이번 검증은 실제 모든 키·모델의 생성 성공이나 모든 5xx 해소를 의미하지 않는다.

## 공식 근거

- [Gemma on Gemini API: 모델 ID·시스템 지침·이미지·추론](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api)
- [generateContent REST: 경로·본문·타입](https://aistudio.google.com/api-reference/generate-content/generate-content)
- [이미지 인라인 입력과 전체 20MB 제한](https://aistudio.google.com/docs/image-understanding#inline-image)
- [모델 목록: pageSize와 pageToken](https://aistudio.google.com/api-reference/models/list-models)
- [Google 키 종류·제약 변경](https://aistudio.google.com/docs/api-key)
- [현재 요금: Gemma 4](https://aistudio.google.com/docs/pricing#gemma-4)
- [NVIDIA 공개 모델 목록](https://integrate.api.nvidia.com/v1/models)
- [Super](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b-infer), [Ultra](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-ultra-550b-a55b-infer), [Super VL](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-super-vl-120b-a12b-infer)
- [Bolt gateway 별칭](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-bolt-e4b-infer), [Lightning](https://docs.nvidia.com/nim/large-language-models/2.0.10/get-started/advanced/get-started-nemotron-3.5-lightning.html), [GPT OSS](https://docs.api.nvidia.com/nim/reference/openai-gpt-oss-20b-infer)
