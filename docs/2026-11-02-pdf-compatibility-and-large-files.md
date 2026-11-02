# PDF 호환성·큰 원본 저장 변경 · 2026-11-02

브라우저 PDF 준비와 원본 뷰어는 PDF.js 6.4.299의 `legacy` API와 같은 빌드의 worker를 사용한다. Mozilla가 Safari 18+에 안내하는 빌드다. 기존 modern 빌드는 최신 `Uint8Array.toHex`, Map/Iterator 기능을 전제로 하므로 지원되지 않는 브라우저에서 함수 호출 오류가 발생할 수 있다. 실제 PDF를 생성해 이전 `openPdf`가 `a.toHex is not a function`으로 실패하고, 변경 후 본문 추출까지 완료하는 회귀 테스트를 추가했다. macOS/iPadOS Safari 자체에서 실행한 결과와는 구분한다.

Tesseract 7의 `blocks: true` 출력은 비텍스트 블록에 `paragraphs`가 없을 수 있다. 기존 단어 추출의 무조건적인 중첩 `flatMap` 호출을 제거했다. 선택적인 배열은 빈 배열로 처리하고, 잘못된 컬렉션 형태는 명시적인 OCR 형식 오류로 거절한다. 유한하지 않거나 뒤집힌 좌표는 저장하지 않는다. OCR 실패를 정상 완료 체크포인트로 기록하지 않는다.

교과서는 문항 추출과 별도로 준비한다. 유효한 PDF 본문 텍스트를 우선 사용하고, 본문이 없는 스캔에 OCR을 적용한다. 숫자 전용 OCR, 문항 경계 감지, 자동 후보 은퇴는 실행하지 않는다. 기존 문항 ID·수동 크롭·정답·학습 이력은 보존한다. 저장된 페이지에 `preparationPurpose`를 기록하며, 이전 교과서 체크포인트는 새 방식으로 한 번 정리한다.

앱의 단일 파일·선택 파일 합계 50MB 거절 조건을 제거했다. Supabase Free의 객체당 최대 50MB 제한은 플랫폼 제한이므로 상향한다고 가정하지 않는다. 50,000,000바이트보다 큰 원본은 최대 5MiB의 비공개 객체로 나누어 저장한다. `documents.data.originalStorage`와 필요한 경우 `pdfStorage`에 버전, MIME, 전체 바이트 수, 순서가 있는 각 부분의 경로·바이트 수·SHA-256을 보관한다. 모든 부분 저장이 성공한 뒤 문서를 등록한다. 원본·처리용 경로는 기존 필드를 유지하며, 분할 메타데이터가 없는 기존 파일은 그대로 읽는다.

분할 원본을 읽을 때 모든 경로가 현재 계정과 문서에 속하고 순서가 맞는지 먼저 검증한다. 내려받은 부분마다 길이와 SHA-256을 검증하고 전체 Blob으로 복원한다. 브라우저 분석, 원본 뷰어·원본 링크, 외부 AI용 선택 페이지 PDF 내보내기가 같은 복원 경로를 사용한다. 뷰어의 객체 URL은 계정별로 캐시하고 로그아웃 시 폐기하며, 로그아웃 중 끝난 다운로드는 뷰어에 노출하지 않는다.

분할 객체도 기존 `study-files` 비공개 버킷과 사용자 폴더 RLS를 사용한다. MIME을 명시하므로 현재 허용 MIME과 호환된다. 새 테이블·정책·버킷 크기 변경이나 데이터 이전은 필요 없다. 총 저장 공간·전송량·브라우저 메모리와 기존 파일당 500쪽, 한 번에 10개 조건은 남는다. 무제한 저장이나 무제한 크기 처리를 보장하지 않는다. 업로드 중 실패한 부분은 문서 완료로 표시하지 않는다. 사용자 파일을 자동 삭제하지 않는다.

검증은 임시 생성 PDF·바이트 배열과 테스트 DB/Storage 대역으로 수행한다. 51MiB 이상 원본의 전체 바이트 동등성, 손상·누락·순서 변경·다른 계정 경로 거절, 계정별 URL 분리와 로그아웃 폐기, 교과서에서 불필요한 문항 추출이 없는 것을 검증한다. 실제 사용자 DB에 테스트 자료를 추가하거나 원격 설정을 변경하지 않았다.

근거: [Mozilla 브라우저 지원 안내](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#legacy-build), [Tesseract 7 API](https://github.com/naptha/tesseract.js/blob/v7.0.0/docs/api.md), [Supabase 객체 크기 제한](https://supabase.com/docs/guides/storage/uploads/file-limits), [Supabase 표준 업로드](https://supabase.com/docs/guides/storage/uploads/standard-uploads).
