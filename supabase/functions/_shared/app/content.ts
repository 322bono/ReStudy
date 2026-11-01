import {AppError} from '../context.ts';
import {state,type Ctx} from './repository.ts';
const TYPES=['객관식','OX','빈칸','단답형','서술형','플래시카드','문장 가리기','개념 적용형','자료 해석형','조건 판단형','ㄱㄴㄷ 판단형'];
export async function validate(ctx:Ctx,p:any){
 const errors:string[]=[],warnings:string[]=[];const s=await state(ctx,true);
 if(!p||typeof p!=='object'||Array.isArray(p))return {valid:false,errors:['JSON 객체를 가져오세요.'],warnings,counts:{}};
 const concepts=p.concepts||[],items=p.items||[],mappings=p.mappings||[];
 if(![concepts,items,mappings].every(Array.isArray))return {valid:false,errors:['concepts/items/mappings는 배열이어야 합니다.'],warnings,counts:{}};
 if(concepts.length+items.length+mappings.length>10000)throw new AppError('한 번에 콘텐츠 10,000개 이하로 가져오세요.');
 const merged=new Map(s.concepts.map((c:any)=>[c.id,c])),bank=new Map(s.bank.map((i:any)=>[i.id,i]));
 const checkIds=(list:any[],label:string)=>{const seen=new Set();for(const o of list){if(typeof o.id!=='string'||!/^[\p{L}\p{N}_-]{1,100}$/u.test(o.id)||seen.has(o.id))errors.push(`${label} ID 형식 또는 중복: ${String(o.id).slice(0,100)}`);seen.add(o.id)}};
 checkIds(concepts,'개념');checkIds(items,'문항');
 for(const c of concepts){if(![c.subject,c.name,c.definition].every(v=>typeof v==='string'&&v.trim()))errors.push(`개념 ${c.id}: 과목·이름·정의가 필요합니다.`);if(!Array.isArray(c.properties)||!Array.isArray(c.misconceptions))errors.push(`개념 ${c.id}: 성질·오개념 배열이 필요합니다.`);merged.set(c.id,c)}
 const sources=(src:any[],subject:string,label:string)=>{if(!Array.isArray(src)){errors.push(`${label}: 출처 배열을 확인하세요.`);return}for(const v of src){const d=s.materials.find((m:any)=>m.id===v.materialId),pg=s.pages.find((pg:any)=>pg.materialId===v.materialId&&pg.number===v.page);if(!d||!pg||pg.kind==='answers'||d.subject!==subject)errors.push(`${label}: 출처 자료·페이지·과목을 확인하세요.`)}};
 for(const c of merged.values())sources(c.sources||[],c.subject,`개념 ${c.id}`);
 for(const i of items){const c=merged.get(i.conceptId);if(!c)errors.push(`문항 ${i.id}: 연결 개념이 없습니다.`);if(!TYPES.includes(i.type)||!['기본','보통','심화'].includes(i.difficulty)||!Array.isArray(i.modes)||!i.modes.length||i.modes.some((m:string)=>!['quiz','memory','check'].includes(m)))errors.push(`문항 ${i.id}: 유형·난이도·학습 모드를 확인하세요.`);
 if(typeof i.prompt!=='string'||!i.prompt.trim()||typeof i.answer!=='string'||!i.answer.trim()||typeof i.explanation!=='string'||!i.explanation.trim())errors.push(`문항 ${i.id}: 질문·정답·해설이 필요합니다.`);
 if(!Array.isArray(i.choices)||new Set(i.choices).size!==i.choices?.length)errors.push(`문항 ${i.id}: 선택지 배열 또는 중복을 확인하세요.`);
 if(i.type==='객관식'&&(!i.choices?.includes(i.answer)||i.choices.length<2))errors.push(`문항 ${i.id}: 정답은 선택지에 있어야 합니다.`);
 if(i.type==='OX'&&(!['O','X'].includes(i.answer)||!i.choices?.includes('O')||!i.choices?.includes('X')))errors.push(`문항 ${i.id}: O/X 정답과 선택지를 확인하세요.`);
 for(const choice of i.choices||[])if(choice!==i.answer&&!i.choiceFeedback?.[choice]?.explanation&&!i.correction)errors.push(`문항 ${i.id}: 오답 교정 해설이 필요합니다.`);
 if(c)sources(i.sources||[],c.subject,`문항 ${i.id}`);bank.set(i.id,i);}
 for(const i of bank.values())if(!merged.has(i.conceptId))errors.push(`기존 문항 ${i.id}: 개념 참조가 없습니다.`);
 const actual:any[]=[];
 for(const m of mappings){const qs=s.questions.filter((q:any)=>m.questionId?q.id===m.questionId:q.materialId===m.materialId&&q.number===m.number&&(!m.page||q.page===m.page));if(qs.length!==1){errors.push(`원본 ${m.number||m.questionId}: 번호·페이지로 문항 하나를 지정하세요.`);continue}const q=qs[0],doc=s.materials.find((d:any)=>d.id===q.materialId);if(!Array.isArray(m.conceptIds)||m.conceptIds.some((id:string)=>!merged.has(id)||merged.get(id).subject!==doc?.subject))errors.push(`원본 ${q.number}: 개념 ID 또는 과목을 확인하세요.`);actual.push({...m,questionId:q.id});}
 for(const q of s.questions){const m=actual.find(m=>m.questionId===q.id),ids=m?.conceptIds||q.conceptIds,doc=s.materials.find((d:any)=>d.id===q.materialId);if(ids.some((id:string)=>!merged.has(id)||merged.get(id).subject!==doc?.subject))errors.push(`기존 원본 ${q.number}: 개념 과목을 변경하면 연결을 함께 수정해야 합니다.`);}
 if(!items.length)warnings.push('등록 문항이 없으면 개념 학습을 시작할 수 없습니다.');
 return {valid:!errors.length,errors:[...new Set(errors)],warnings,counts:{concepts:concepts.length,items:items.length,mappings:mappings.length},package:{schemaVersion:1,concepts,items,mappings:actual}};
}
export async function importContent(ctx:Ctx,p:any){const checked=await validate(ctx,p);if(!checked.valid)return checked;const {data,error}=await ctx.admin.rpc('import_content_package',{p_user_id:ctx.user.id,p_package:checked.package});if(error)throw new AppError('콘텐츠를 저장하지 못했습니다. 연결 및 과목을 다시 검사하세요.');return {...checked,package:undefined,imported:data};}
