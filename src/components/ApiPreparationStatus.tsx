import {Button}from'../../components/ui';
import {aiFailureText}from'../domain/ai-status';
function responseDetail(value:any){if(!value)return'';const reason=['stop','tool_calls','STOP'].includes(value.finish_reason)?'정상 종료':['length','MAX_TOKENS'].includes(value.finish_reason)?'출력 잘림':'종료 상태 확인';const issues=(value.schema?.issues??[]).slice(0,3).map((i:any)=>i.path).filter((s:any)=>typeof s==='string');return `${reason} · 본문 ${Number(value.content_chars)||0}자 · 추론 ${Number(value.reasoning_chars)||0}자${issues.length?` · 형식 확인: ${issues.join(', ')}`:''}`;}
export default function ApiPreparationStatus({job,running=false,error='',elapsed=0,onStop}:{job?:any;running?:boolean;error?:string;elapsed?:number;onStop?:()=>void}){
 if(!running&&!error&&!job?.apiJobs?.length&&job?.apiStatus?.state!=='paused')return null;
 return <section className="panel" aria-live="polite" style={{padding:16,marginBottom:16}}>
  <h2>학습 자료 준비</h2>
  <p role={error?'alert':'status'} className={error?'error':''}>{error||(running&&job?.apiStatus?.state!=='running'?'API 요청을 준비하고 있습니다. 완료된 결과는 보관됩니다.':job?.apiStatus?.message)||'API 요청을 시작하고 있습니다.'}</p>
  <p>저장된 문항 {job?.importedQuestions??0}개 · 암기 카드 {job?.preparedFlashcards??0}개{running?` · 처리 ${job?.apiStatus?.completed??0}/${job?.totalParts??0} · ${elapsed}초`:''}</p>
  {running&&<progress aria-label="API 분할 진행률" max={job?.totalParts||1} value={job?.apiStatus?.completed||0}/>}
  {running&&onStop&&<Button variant="secondary" onClick={onStop}>현재 분할 후 멈추기</Button>}
  <details><summary>작업 내역</summary>{job?.apiBudget&&<p>오늘 {job.apiBudget.used}/{job.apiBudget.limit}회 · 남은 {job.apiBudget.remaining}회</p>}{(job?.apiAttempts??[]).map((a:any,i:number)=><p key={i}>{a.provider} · {a.model} · {Math.round((a.duration_ms??0)/1000)}초 · {a.success?'유효한 응답 수신':aiFailureText(a.error)}{a.response_metadata&&<><br/><small>{responseDetail(a.response_metadata)}</small></>}</p>)}{!job?.apiAttempts?.length&&<p>첫 응답을 기다리고 있습니다.</p>}</details>
  {job?.preparedPreview?.length>0&&<details><summary>저장된 내용 보기</summary>{job.preparedPreview.map((q:any,i:number)=><article key={i} style={{marginTop:16}}><strong>{q.prompt}</strong><ol type="A">{(q.options??[]).map((option:string,j:number)=><li key={j}>{option}</li>)}</ol><p>정답: {q.answer}</p><p>{q.explanation}</p><small>출처 · PDF {(q.source_pages??[]).join(", ")}쪽</small></article>)}</details>}
 </section>;
}
