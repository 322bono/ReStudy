# AI 모델·요청 형식 확인 · 2026-11-02

공식 문서와 공개 메타데이터를 확인한 카탈로그입니다. 목록에 있다는 사실은 특정 키의 접근 권한, 무료 잔여량, 한국어 품질이나 생성 성공을 증명하지 않습니다. 신규 모델도 실제 생성과 로컬 계약 검증을 통과하기 전에는 생성 검증 완료로 표시하지 않습니다.

## NVIDIA

[현재 공개 `/v1/models`](https://integrate.api.nvidia.com/v1/models)와 각 모델의 공식 요청 문서를 대조했습니다. 실제 호출은 계속 NVIDIA의 `/v1/chat/completions`를 사용합니다. 이 공개 목록 조회에는 키를 보내지 않습니다.

| 카탈로그 ID | 실제 요청 ID·요청 설정 | 확인 자료 |
| --- | --- | --- |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | 같은 ID. `chat_template_kwargs.enable_thinking=false`; 출력 상한 32,768 | [요청](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-lightning-30b-a3b-infer), [추론·출력 예산 및 비활성화 예제](https://docs.nvidia.com/nim/large-language-models/2.0.10/get-started/advanced/get-started-nemotron-3.5-lightning.html) |
| `nvidia/nemotron-3-super-120b-a12b` | 같은 ID. 공식 템플릿의 `enable_thinking=false`; 출력 상한 32,768 | [요청](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b-infer), [추론 비활성화 예제](https://docs.nvidia.com/nim/large-language-models/2.0.4/turbo/get-started-nemotron-3-super-120b-a12b.html) |
| `nvidia/nemotron-3-ultra-550b-a55b` | 같은 ID. `chat_template_kwargs.enable_thinking=false`; 출력 상한 32,768 | [요청](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-ultra-550b-a55b-infer), [추론 끄기 예제](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/modelcard) |
| `openai/gpt-oss-20b` | 같은 ID. `reasoning_effort=low`; `none`을 보내지 않음. 호스팅 출력 상한 4,096 | [요청](https://docs.api.nvidia.com/nim/reference/openai-gpt-oss-20b-infer) |
| `nvidia/nemotron-3.5-bolt-e4b` | **독립 게이트웨이 요청은 `stg/nvidia/nemotron-3.5-bolt-e4b`**. `enable_thinking=false`. 공개 목록·사용자 선택은 원래 ID 유지 | [게이트웨이 별칭·출력 상한 65,536·템플릿 설정](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-bolt-e4b-infer), [호스팅 본문 범위 64K](https://build.nvidia.com/nvidia/nemotron-3.5-bolt-e4b/modelcard) |
| `nvidia/nemotron-3.5-super-vl-120b-a12b` | 같은 ID. `enable_thinking=false`. 이미지 입력은 표준 `image_url` 데이터 URI. 호스팅 출력 상한 131,072 | [요청](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-super-vl-120b-a12b-infer), [모델 카드](https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b/modelcard) |
| `meta/llama-3.3-70b-instruct` | 기존 저장 선택 보존용. 현재 공개 목록에 없으므로 새 기본 풀에 추가하지 않음 | [기존 요청 문서](https://docs.api.nvidia.com/nim/reference/meta-llama-3_3-70b-instruct-infer) |

Lightning의 공식 문서는 추론과 최종 답이 같은 `max_tokens`를 소비하며, 기본 추론이 예산을 먼저 소진하면 최종 답 없이 `finish_reason=length`가 반환될 수 있음을 설명합니다. 따라서 이 앱의 짧은 구조화 생성에는 모델별로 문서화된 추론 끄기 설정을 보냅니다. GPT OSS에는 Nemotron용 템플릿 설정을 섞지 않습니다.

NVIDIA 공개 목록의 `google/gemma-4-31b-it`, `deepseek-ai/deepseek-v4.1-flash`, `nvidia/nemotron-nano-3-30b-a3b` 등은 이름만 보고 자동 허용하지 않습니다. Gemma의 [별도 역할·요청 형식](https://docs.api.nvidia.com/nim/reference/google-gemma-4-31b-it-infer), DeepSeek의 [별도 추론·대규모 출력 권장](https://docs.api.nvidia.com/nim/reference/nvidia-deepseek-v4_1-flash), Nano의 문서/호스팅 ID 차이는 별도로 검증해야 합니다. 이번 변경은 공식 요청 형식까지 확인한 Bolt와 Super VL을 추가합니다.

## Gemini API

| ID | 요청·추론 설정 |
| --- | --- |
| `gemini-3.8-flash` | 네이티브 `:generateContent`, `thinkingLevel=LOW` |
| `gemini-3.6-flash` | 같은 요청 형식, `thinkingLevel=LOW` |
| `gemini-3.5-flash-lite` | 같은 요청 형식, `thinkingLevel=LOW` |
| `gemma-4-26b-a4b-it` | 네이티브 `:generateContent`, **`thinkingLevel=MINIMAL`** |
| `gemma-4-31b-it` | 네이티브 `:generateContent`, **`thinkingLevel=MINIMAL`** |

기존 Gemini 세 모델과 Gemma 4는 [공식 요금표](https://ai.google.dev/gemini-api/docs/pricing)에 무료 입력·출력 티어가 있습니다. Gemma의 정확한 ID, 시스템 지시·이미지 형식, 추론의 `MINIMAL/HIGH` 전용 설정은 [공식 Gemma API 안내](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api)에 근거합니다. Gemini 4 Argon과 Pro 계열을 무료 모델로 추가하지 않습니다.

`restudy.v1`에는 검증된 JSON MIME 모드와 프롬프트의 출력 계약을 사용하고, 응답 전체를 로컬 스키마로 검증합니다. 다른 기존 작업의 구조화 스키마 설정은 유지합니다. `store=false`를 보내며 키는 헤더로만 전송합니다. [공식 REST 요청 형식](https://ai.google.dev/api/generate-content)과 [추론 수준](https://ai.google.dev/gemini-api/docs/thinking)을 확인했습니다.

## 검증·운영 경계

- 새 모델은 서버가 해당 키에 반환한 정확한 ID와 문서화한 카탈로그의 교집합에만 나타납니다. 모델 목록 새로고침은 기본 전체 선택 풀을 확장하고, 사용자가 직접 고른 풀은 보존합니다.
- NVIDIA 무료 여부는 공개 목록이 아니라 사용자의 무료 전용 계정 확인에 의존합니다. Gemini도 무료 모델이라는 이유로 유료 계정의 과금 가능성을 무시하지 않습니다. 유료 허용은 계속 기본 차단합니다.
- NVIDIA 연결 확인은 추론을 끈 최소 JSON 생성에서 `stop`과 `{"ok":true}`를 확인합니다. 과거 4토큰 확인은 새 구조화 생성 검증으로 취급하지 않습니다.
- 오류 진단에는 종료 사유의 허용 목록, 출력·추론 길이, 토큰 수, 배열 개수, 스키마 필드 경로·오류 코드만 저장합니다. 응답 본문, 추론 원문, 자료 내용, 키·헤더는 저장하거나 로그로 내보내지 않습니다.
- 로컬 회귀 테스트는 요청 형식·검증·보안 경계를 확인합니다. 특정 계정에서의 실제 모델 성공과 응답 품질은 배포 후 별도의 실제 최소 생성·콘텐츠 준비로 확인해야 합니다.
