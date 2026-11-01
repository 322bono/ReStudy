# RE:STUDY 작업 지침 · 2026-11-01

최신 사용자 명세는 docs/2026-11-01-ai-cloud-spec.md입니다. 이전 로컬 전용 요구사항을 대체하며 React/Vite + Supabase Auth/PostgreSQL/Storage/Edge Functions + NVIDIA NIM/Gemini를 사용합니다. 기존 로컬 버전은 feat/local-prepared-content 브랜치 3a50476에 보존했습니다.

- GitHub 저장소는 322bono/ReStudy입니다. 사용자 최신 추가 요청에 따라 무료 Pages 사용을 위해 공개 전환했습니다. PDF·학습 기록·비밀값은 저장소에 포함하지 않습니다. 추가 호스팅 서비스를 사용하지 않습니다.
- AI 키는 서버 AES-GCM 암호화, 마스터 키는 Supabase Secrets. 브라우저 저장·로그·소스에 비밀값 금지. 유료 AI는 기본 차단합니다.
- AI 생성 콘텐츠는 구조 검증 후 검토 상태로 저장합니다. 시연 데이터·가짜 성공을 사용자 DB에 넣지 않습니다.
- PDF 문항 추출과 문제–개념 매핑은 별개입니다. 추출 후보는 관리 화면에서 검토하고, 모든 크롭은 등록·수정 시 저장합니다. 학습 중에는 저장된 이미지만 조회합니다.
- 현재 API/데이터 계약 및 구현 계획: docs/superpowers/plans/2026-11-01-ai-cloud.md. docs/local-contract.md는 보존된 로컬 버전 전용입니다.
- 기존 문제·문항·콘텐츠 ID와 학습 이력을 보존합니다. 활성 세션은 문항/정답/해설/원본 이미지 스냅샷을 사용합니다.
- 데이터는 data/에 보관합니다. 테스트는 임시 폴더 또는 test-results/만 사용합니다. 사용자 DB를 테스트 시드로 덮어쓰지 않습니다.
- 실행: start.bat. 개발: npm run backend + npm run dev. 확인: npm test, npm run typecheck, npm run build.
- Python 실행은 .venv/Scripts/python.exe를 우선합니다. 네트워크 의존성은 초기 패키지 설치에만 필요합니다.
- 주 메뉴는 4개이며, 콘텐츠 관리 도구는 별도 관리 모드에 둡니다. 한국어 UI와 로컬 Pretendard를 사용합니다.
