# 클라우드 운영 안내

## 현재 구성

- 소스 저장소: `322bono/ReStudy`, 사용자 추가 허용으로 공개 전환했으며 무료 Pages를 사용합니다.
- Supabase: `tfjsrdfnrybepxpdfqfz`, Restudy, 서울. 승인된 개인 조직을 사용합니다.
- 7개 Edge Functions: auth-helpers, app, content-jobs, ai-credentials, ai-request, analyze-problem, generate-questions.
- 브라우저 배포에는 Supabase 공개 URL/publishable 키만 포함합니다. DB/Storage/AI 비밀값은 포함하지 않습니다.

## 서버 준비

기존 프로젝트에 처음 적용할 때는 `supabase/migrations/`를 시간순으로 적용합니다. 기존 데이터가 있는 프로젝트에서 초기 SQL을 재실행하거나 DB를 초기화하지 마세요. 이 작업에 사용한 프로젝트에는 보존·복원 수정을 포함해 마이그레이션이 적용되어 있습니다.

각 함수는 요청 본문 안의 소유자 ID를 신뢰하지 않고 서버에서 `auth.getUser()`와 등록된 프로필을 확인합니다. `auth-helpers`의 로그인/최초 계정 생성만 로그인 전에 접근할 수 있으며 요청 제한과 1회용 토큰을 사용합니다. 이 때문에 Gateway JWT 검사는 끄고 함수 본문에서 직접 인증합니다.

**공개 회원가입을 비활성화**해야 합니다. Supabase Dashboard → Authentication → Sign In / Providers에서 새 사용자 가입을 끄세요. 저장소의 `supabase/config.toml`에도 `enable_signup=false`가 지정되어 있습니다. 원격에 설정이 적용됐는지는 대시보드에서 별도로 확인합니다. 프로필이 없는 외부 가입 계정은 RLS에서 앱 자료에 접근할 수 없습니다.

Edge Function Secrets에 `RE_CREDENTIAL_MASTER_KEY`를 **32바이트 무작위 값의 base64**로 등록합니다. 기존 암호화 키가 있다면 덮어쓰지 마세요. 기존 키를 바꾸면 저장된 AI 자격 증명을 해독할 수 없습니다.

올바른 Supabase CLI 계정에 로그인한 뒤 다음 도구로 새 프로젝트의 키를 초기화할 수 있습니다. 이미 키 이름이 있으면 유지합니다. 임시 파일은 무시된 `data/`에만 만들고 전송 후 제거하며 값은 출력하지 않습니다.

```powershell
.\node_modules\.bin\supabase.cmd login
node scripts/init-server-secrets.mjs
```

Supabase 기본 서버 환경의 URL/service-role/anon 키는 Edge Functions에 주입됩니다. 필요한 경우 `RE_SUPABASE_SECRET_KEY`, `RE_SUPABASE_PUBLISHABLE_KEY` 서버 변수로만 대체합니다. 프론트엔드 `.env.local`에는 넣지 않습니다. [공식 Secrets 안내](https://supabase.com/docs/guides/functions/secrets)를 참고하세요.

## 계정과 AI 연결

최초 계정은 서버에서 승인한 `setup_tokens`의 해시·만료·1회용 링크로만 만듭니다. 아이디와 비밀번호는 사용자가 앱 화면에서 직접 정합니다. 기본 비밀번호, 공개 회원가입, 이메일 주소 노출용 로그인 조회 API가 없습니다.

설정 → AI 연결에서 사용자가 NVIDIA/Gemini 키를 입력합니다. 키는 전송 직후 입력란에서 제거되고 AES-GCM으로 서버에 저장됩니다. 무료 사용 확인과 모델 역할을 검토한 뒤 연결을 확인하세요. NVIDIA 모델 목록은 공개 응답일 수 있어 키 검증으로 간주하지 않고 짧은 실제 요청으로 확인합니다. Gemini 모델 목록 인증 확인과 실제 생성 성공은 구분합니다.

유료 사용은 기본 꺼짐입니다. 키/한도/모델 오류로 생성할 수 없으면 남은 작업을 저장하고 외부 JSON 경로를 사용합니다. 가져오기·학습·재풀이는 AI를 호출하지 않습니다.

## GitHub Pages

워크플로는 검사·`/ReStudy/` 빌드·아티팩트 업로드를 수행합니다. main 브랜치 갱신은 검사를 통과한 뒤 자동 배포합니다. 수동 배포는 Actions의 **Run workflow → deploy=true**에서 실행합니다. 저장소 Settings → Pages의 Source는 GitHub Actions로 구성했습니다.

비공개 저장소의 Pages는 GitHub Pro/Team/Enterprise에서 지원됩니다. Free 계정에서는 비공개 소스를 유지한 채 Pages를 사용할 수 없습니다. 사용자는 무료 Pages 사용을 위해 소스 저장소의 공개 전환을 요청했습니다. 유료 플랜에는 가입하지 않습니다. 지원 여부를 확인하기 전에는 외부 배포 성공으로 간주하지 않습니다. [GitHub 공식 안내](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## 보존과 복원

설정 JSON 백업은 같은 계정에서만 복원합니다. 기존 ID는 그대로 두고 누락된 행만 하나의 트랜잭션으로 삽입합니다. 참조 충돌은 전체 롤백합니다. Auth, 프로필, AI 비밀값/작업, 원본 PDF·이미지는 포함하지 않습니다. 원본 Storage 파일이 삭제됐다면 JSON만으로 되살릴 수 없습니다. 사용자 계정/Storage의 별도 백업은 Supabase 운영 정책으로 관리하세요.
