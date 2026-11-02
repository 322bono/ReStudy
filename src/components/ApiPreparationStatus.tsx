import {Button}from'../../components/ui';
import {aiFailureText}from'../domain/ai-status';
export default function ApiPreparationStatus({job,running=false,error='',elapsed=0,onStop}:{job?:any;running?:boolean;error?:string;elapsed?:number;onStop?:()=>void}){
 if(!running&&!error&&!job?.apiJobs?.length&&job?.apiStatus?.state!=='paused')return null;
 return <section className="panel" aria-live="polite" style={{padding:16,marginBottom:16}}>
  <h2>API 준비 결과</h2>
  <p role={error?'alert':'status'} className={error?'error':''}>{error||(running&&job?.apiStatus?.state!=='running'?'API 요청을 준비하고 있습니다. 완료된 결과는 보관됩니다.':job?.apiStatus?.message)||'API 요청을 시작하고 있습니다.'}</p>
  <p>저장된 결과 {job?.apiStatus?.completed??0}/{job?.totalParts??0}분할 · 응답 보관 {job?.preparedQuestions??0}문항 · 은행 등록 {job?.importedQuestions??0}문항{running?` · 경과 ${elapsed}초`:''}</p>
  {running&&<progress aria-label="API 분할 진행률" max={job?.totalParts||1} value={job?.apiStatus?.completed||0}/>}
  {running&&onStop&&<Button variant="secondary" onClick={onStop}>현재 분할 후 멈추기</Button>}
  <details><summary>최근 시도와 오류</summary>{(job?.apiAttempts??[]).map((a:any,i:number)=><p key={i}>{a.provider} · {a.model} · {Math.round((a.duration_ms??0)/1000)}초 · {a.success?'유효한 응답 수신':aiFailureText(a.error)}</p>)}{!job?.apiAttempts?.length&&<p>아직 모델 호출 이력이 없습니다. 원본·요청 범위를 확인하거나 첫 응답을 기다리는 단계입니다.</p>}</details>
  {job?.preparedPreview?.length>0&&<details><summary>최근 보관한 결과 보기 · 검토 전</summary>{job.preparedPreview.map((q:any,i:number)=><article key={i} style={{marginTop:16}}><strong>{q.part}분할 · {q.prompt}</strong><ol type="A">{(q.options??[]).map((option:string,j:number)=><li key={j}>{option}</li>)}</ol><p>정답: {q.answer}</p><p>{q.explanation}</p><small>출처 · PDF {(q.source_pages??[]).join(", ")}쪽</small></article>)}</details>}
 </section>;
}
