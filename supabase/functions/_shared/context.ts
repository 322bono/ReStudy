import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import {accessColumns,accountAccess,type AccessContext} from './access.ts';

const allowed=()=>new Set((Deno.env.get('RE_ALLOWED_ORIGINS')||'https://322bono.github.io,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173').split(',').map(s=>s.trim()));
export function headers(req?:Request){const origin=req?.headers.get('origin')||'';return {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(allowed().has(origin)?{'Access-Control-Allow-Origin':origin,'Vary':'Origin'}:{}),'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS'};}
export function json(value:unknown,status=200,req?:Request){return new Response(JSON.stringify(value),{status,headers:headers(req)});}
export function preflight(req:Request){const origin=req.headers.get('origin');if(origin&&!allowed().has(origin))return json({error:'허용되지 않은 접속 주소입니다.'},403,req);if(req.method==='OPTIONS')return new Response('ok',{headers:headers(req)});return null;}
export class AppError extends Error{constructor(message:string,public status=400){super(message)}}
const featureMessages = {
 ai: '관리자가 AI 기능을 허용하지 않았습니다.',
 personalKeys: '관리자가 개인 API 키 등록·변경을 허용하지 않았습니다.',
 mistakes: '관리자가 오답 노트 사용을 허용하지 않았습니다.',
 study: '관리자가 학습 기능 사용을 허용하지 않았습니다.',
};
export function requireFeature(ctx: AccessContext, feature: keyof typeof featureMessages) {
 if (ctx.access?.[feature] === false) throw new AppError(featureMessages[feature], 403);
}
export async function readInput(req:Request,max=22*1024*1024){
 if(Number(req.headers.get('content-length'))>max)throw new AppError('입력 파일이 허용 크기를 넘습니다.',413);
 const reader=req.body?.getReader();if(!reader)throw new AppError('입력 내용이 없습니다.');let bytes=0;const chunks:Uint8Array[]=[];
 for(;;){const{done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>max){await reader.cancel();throw new AppError('입력 파일이 허용 크기를 넘습니다.',413)}chunks.push(value)}
 const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer))}catch{throw new AppError('올바른 UTF-8 JSON을 입력하세요.')}
}
export function adminClient(){const url=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||Deno.env.get('RE_SUPABASE_SECRET_KEY');if(!url||!key)throw new AppError('서버 연결 설정이 준비되지 않았습니다.',503);return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});}
export async function context(req:Request){
 const token=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'');if(!token)throw new AppError('로그인이 필요합니다.',401);
 const admin=adminClient();const {data:{user},error}=await admin.auth.getUser(token);if(error||!user)throw new AppError('다시 로그인해 주세요.',401);
 const {data:profile,error:profileError}=await admin.from('profiles').select(`id,restudy_account_access(${accessColumns})`).eq('user_id',user.id).maybeSingle();
 if(profileError)throw new AppError('계정 권한을 확인하지 못했습니다.',503);
 if(!profile)throw new AppError('등록된 계정으로 로그인해 주세요.',403);
 const permission=profile.restudy_account_access;
 const access=accountAccess(Array.isArray(permission)?permission[0]:permission);
 if(!access.active)throw new AppError('사용이 중지된 계정입니다. 관리자에게 문의해 주세요.',403);
 const key=Deno.env.get('SUPABASE_ANON_KEY')||Deno.env.get('RE_SUPABASE_PUBLISHABLE_KEY');if(!key)throw new AppError('서버 공개 연결 설정이 없습니다.',503);
 const db=createClient(Deno.env.get('SUPABASE_URL')!,key,{auth:{persistSession:false,autoRefreshToken:false},global:{headers:{Authorization:`Bearer ${token}`}}});
 return {user,db,admin,access};
}
export function errorResponse(error:unknown,req:Request){const domain=error instanceof Error&&(error as any).kind==='learning';return json({error:error instanceof AppError||domain?(error as Error).message:'요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'},error instanceof AppError?error.status:domain?400:500,req);}
export async function sha256(value:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
