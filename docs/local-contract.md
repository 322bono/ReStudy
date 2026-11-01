# RE 로컬 전환 계약 · 2026-10-31

사용자 최신 명세를 그대로 구현한다. 생성형 AI·외부 서비스·계정 없이 Vite/React + FastAPI + SQLite/PyMuPDF/OpenCV. 기존 자료·학습 기록은 id를 유지해 data/re-local.sqlite로 1회 복사하고 data/restudy.sqlite는 수정하지 않는다. 모든 앱 데이터와 폰트·라이브러리는 로컬. 사용자 학습 콘텐츠는 시드하지 않는다.

## 공통 타입 및 API
기존 lib/types.ts의 Material, Page, Region, Question, Mistake, SolveSession, StudySession, StudyItem 필드명을 유지한다. 추가 필드:
- Question: page:number(문항 시작 쪽), conceptIds:string[], hasContent:boolean, sharedRegionCount?:number. regions는 공통 지문을 앞에 포함한 모든 원본 영역. 이미지 part 인덱스는 regions와 동일.
- Mistake: correctCount:number, conceptState:'unregistered'|'reviewing'|'understood', conceptAccuracy?:number. reviewCount는 재풀이 수, 이해도는 별도.
- AppState: materials/questions/mistakes/sessions/studies/concepts, bankStats:{conceptId,count,modes:string[]}[], migration:{...}?. name/aiConfigured/model 제거.
- Concept: id,subject,major,minor,name,definition,properties:string[],misconceptions:{id,label,correction}[],sources:Source[]
- BankItem: id,conceptId,type('객관식','OX','빈칸','단답형','서술형','플래시카드','문장 가리기'),prompt,choices:string[],answer,acceptedAnswers:string[],explanation,choiceFeedback:Record<string,{explanation,misconceptionTag:string}>,correction,difficulty('기본','보통','심화'),sources:Source[],modes:('quiz'|'memory'|'check')[],active:boolean
- StudyItem = 세션 당시 BankItem 사본 + id(세션 occurrence UUID),bankItemId,concept:string(개념 이름), result/response/feedback/memory. 서버는 답변/암기 펼치기 전 answer/acceptedAnswers/explanation/choiceFeedback/correction 숨김. requiresSelfGrade?:boolean.
- StudySession: 기존 + originQuestionIds:string[],conceptIds:string[],label:string,understoodConceptIds:string[], feedback?; mode는 quiz/memory/check 유지. 개념 복습은 mode=check 및 originQuestionIds 연결. 완료 후 원본 다시 풀기 버튼 제공.

모든 API /api 아래, 로그인 없음. 에러 {error:string}, GET JSON에는 cache 없음.
- GET state
- POST materials multipart files/subject/kind(기존 종류) ->202 {materials}; 백그라운드 전체 전처리 및 모든 크롭 PNG 저장. GET materials/:id ->{material,pages,questions}, GET /file 및 /page/:n(저장된 PNG). POST /retry 재전처리(관리 작업). PATCH /page-kind {page,kind}. DELETE는 자료를 보관 처리하여 과거 이력 유지.
- POST/PATCH questions(/:id) {materialId,number,unit,regions,confirmed,conceptIds?:[]} -> question. 관리 모드에서만 UI 노출. 수정 시 즉시 크롭 파일 재생성, id/복습 이력 유지. GET questions/:id/image/:index?session=solveId 는 세션 스냅샷 이미지 사용(계산 없음).
- POST mistakes {materialId?,numbers?,questionIds?,cause?} ->{added,ambiguous:number[],missing:number[],reviewSessionId?:string,unregistered:number}. 매핑+문항 있는 새 오답이면 개념 세션 자동 생성. DELETE mistakes/:id는 오답 목록에서 제거하되 이력 보존. GET mistakes/:id ->{mistake,attempts}.
- POST solve {questionIds} -> SolveSession, GET solve/:id, POST /answer {questionId,result,strokes,answerText?}, POST /drawing {questionId,strokes}. 기존 기능 유지. 정답 확인: GET solve/:id/answer-key/:questionId ->{answer,explanation,available}; 준비 데이터가 있을 때만 반환. 기본 문제 화면에는 노출 없음.
- POST lessons {questionId} -> StudySession. 일반 StudyPlayer에서 표시. 미매핑/은행 없음은 409+구체적 안내, 자동 생성 없음.
- POST study {materials:[{id,pages:string}],mode,type,count,difficulty} -> StudySession. 선택 과목은 하나, 출처가 모두 선택 파일/페이지 범위 안에 있는 은행 문항만. 충분한 문항이 없으면 실제 개수로 출제+notice. GET study/:id, POST /answer {itemId,response,memory?,selfGrade?:'correct'|'wrong'}, POST /reveal {itemId}-> {answer,explanation} (암기 또는 자기 채점 항목만). GET study/weak ->{count}, POST study/repeat.
- 객관식/OX/정해진 단답·빈칸은 정규화 비교. 서술형/개념 확인 자유 답변은 제출→저장된 정답 표시→자기 채점. 오답은 choiceFeedback, misconceptionTag, correction을 사용해 표시. 개념 세션은 다른 은행 문항을 재확인 큐에 추가한다. 기본3~5개, 최근 정답·이미 푼 문항보다 미노출·취약 개념 우선. 모든 관련 개념을 순차 처리. 동일 문항밖에 없으면 명시하며 반복, 세션당 개념 재확인 최대3회 후 이해 미확인으로 종료(거짓 이해 완료 금지).

## 콘텐츠 관리 API 및 JSON
일반 메뉴는 4개. 하단 별도 '콘텐츠 관리' 진입 후 관리 화면에서만 문항 영역/개념/은행/가져오기/검사를 보여준다. Viewer manage=true일 때만 수정 도구.

Package={schemaVersion:1,concepts:Concept[],items:BankItem[],mappings:[{questionId?:string,materialId?:string,number?:number,page?:number,conceptIds:string[],answer?:string,explanation?:string}],materials?:[{id,title,hash}],...}. JSON 내부 id는 사용자가 부여하는 안정적 문자열(1~100자, 단순 영문/숫자/한글/_/- 허용), 문서·문제 id는 서버 UUID. 중복 번호를 number만으로 조용히 선택하지 않는다. mapping은 questionId 또는 materialId+number+page로 정확히 찾아야 한다.

- GET content ->{concepts,items,mappings,materials,issues:{errors:string[],warnings:string[]},counts}
- POST content/validate {package:Package} ->{valid,errors:string[],warnings:string[],counts}
- POST content/import {package:Package} ->검증 결과 + imported; 전부 검증 후 트랜잭션 upsert, 기존 시도·세션 스냅샷 유지.
- POST content/import-file multipart file(JSON 또는 본 앱 콘텐츠 SQLite) ->동일
- GET content/export?format=json|sqlite ->다운로드. 개념/은행/매핑과 자료 참조만, 원본 PDF·학습 기록은 포함하지 않음.
- GET content/template ->다운로드 가능한 빈 JSON 형식(시연 학습 내용 없음)
- PUT concepts/:id Concept ->저장, PUT bank-items/:id BankItem ->저장, PATCH questions/:id/mapping {conceptIds,answer?,explanation?} ->저장.
- GET content/check ->{errors,warnings,counts} (참조/정답/선택지/페이지/개념누락/미확인영역 등 검사)

기존자료와 매핑되지 않은 모든 문항에는 '개념 미등록'. 콘텐츠 편집은 학습 기록을 삭제하지 않는다. 세션은 문항/정답/해설 스냅샷으로 유지.

## PDF 처리 모듈 계약
backend/pdf_processing.py 에서:
`preprocess_document(source:Path,output_dir:Path,progress:Callable[[int,str],None]|None=None,kind:str='문제집')->dict`
반환 pages:[{number,width,height,text,kind,items?:[{text,x,y,width,height}],imageFile:str}], questions:[{number,page,unit,text,regions,confidence,confirmed,source:'text'|'ocr'|'manual',sharedRegionCount?:int,cropFiles:string[]}], warnings:string[]. 경로는 절대 로컬 경로(서버만 보관, 클라이언트에 노출하지 않음). output_dir 아래 모든 페이지 PNG와 모든 문항 PNG를 등록 때 생성. 문항 후보 confirmed=false, 근거 없는 자동 확정 금지. 텍스트·도형/이미지 경계·공통 지문과 이어지는 페이지 활용. 해설 페이지 제외. 불확실하면 경고와 관리 확인.
`render_regions(source:Path,regions:list[dict],output_dir:Path)->list[str]` 고해상도 PNG 저장(annotations 제외). 좌표는 회전 반영 페이지의 좌상단 기준 0~1. `ocr_status()->dict` 사용 가능한 로컬 Tesseract/언어 상태. 네트워크 호출 금지.

## 작업과 검증
- root: backend/store.py, content.py, learning.py, main.py, migration, tests, requirements, package/Vite/launcher, 문서와 통합.
- PDF 작업: backend/pdf_processing.py, backend/tests/test_pdf_processing.py만.
- 화면 작업: components/*, lib/types.ts, CSS(새 frontend.css 및 기존 app/globals.css), PDF.js 컴포넌트. package/main/index/Vite/backend는 변경하지 않음.
- pytest 실제 생성 PDF + 가져오기 원자성/이력/선택 규칙/오개념/재풀이 저장/이관.
- TypeScript/Vite 빌드, 브라우저 실제 PDF 업로드→콘텐츠 가져오기→오답→개념 오답 교정→다른 문항 재확인→원본 재풀이→재실행 기록.
- 앱에 학습 시드/원격 의존/AI 경로를 남기지 않는다. 테스트 fixture는 테스트 전용 임시 DB 사용.
