import {adminClient,AppError,context,errorResponse,json,preflight,sha256} from '../_shared/context.ts';

Deno.serve(async req=>{
 const early=preflight(req);if(early)return early;
 try{
  if(req.method!=='POST')throw new AppError('지원하지 않는 요청입니다.',405);
  const body=await req.json();const admin=adminClient();
  const username=String(body.username||'').trim().toLowerCase();
  if(body.action==='bootstrap'){
   if(!/^[a-z0-9_-]{3,32}$/.test(username)||typeof body.password!=='string'||body.password.length<12||body.password.length>256)throw new AppError('아이디는 영문·숫자 3~32자, 비밀번호는 12자 이상 입력하세요.');
   const hash=await sha256(String(body.token||'')),lease=crypto.randomUUID();
   const {data:claimed,error}=await admin.rpc('claim_setup_token',{p_hash:hash,p_lease:lease});if(error||!claimed)throw new AppError('초기 설정 링크가 만료됐거나 이미 사용됐습니다.',403);
   const {count}=await admin.from('login_aliases').select('*',{head:true,count:'exact'});if(count)throw new AppError('이미 관리자 계정이 준비됐습니다.',409);
   const email=`${crypto.randomUUID()}@accounts.restudy.invalid`;
   const {data,error:createError}=await admin.auth.admin.createUser({email,password:body.password,email_confirm:true});if(createError||!data.user)throw new AppError('계정을 만들지 못했습니다. 비밀번호 조건을 확인하고 잠시 후 다시 시도하세요.');
   const id=data.user.id;
   const profile=await admin.from('profiles').insert({id,user_id:id,username,data:{ai_settings:{mode:'round_robin',allow_paid:false,daily_limit:20,max_attempts:3,max_questions:20}}});
   const alias=await admin.from('login_aliases').insert({username,user_id:id,email});
   if(profile.error||alias.error){await admin.auth.admin.deleteUser(id);throw new AppError('계정 설정을 저장하지 못했습니다. 잠시 후 다시 시도하세요.',500);}
   await admin.from('setup_tokens').update({consumed_at:new Date().toISOString(),lease_until:null,lease_token:null}).eq('token_hash',hash).eq('lease_token',lease);
   return json({ready:true},200,req);
  }
  if(body.action==='password'){
   const {user}=await context(req);const {data:alias}=await admin.from('login_aliases').select('email').eq('user_id',user.id).single();
   if(!alias||typeof body.currentPassword!=='string'||typeof body.password!=='string'||body.password.length<12)throw new AppError('현재 비밀번호와 12자 이상의 새 비밀번호를 입력하세요.');
   const {error}=await admin.auth.signInWithPassword({email:alias.email,password:body.currentPassword});if(error)throw new AppError('현재 비밀번호를 확인해 주세요.');
   const {error:updateError}=await admin.auth.admin.updateUserById(user.id,{password:body.password});if(updateError)throw new AppError('비밀번호를 변경하지 못했습니다.');
   await admin.auth.admin.signOut(req.headers.get('authorization')!.replace(/^Bearer\s+/i,''),'global');return json({updated:true,signInAgain:true},200,req);
  }
  if(body.action!=='login')throw new AppError('지원하지 않는 요청입니다.');
  const fingerprint=await sha256((req.headers.get('x-forwarded-for')?.split(',')[0]||'unknown')+'|'+username.slice(0,64));
  const {data:allowed,error:limitError}=await admin.rpc('begin_login_attempt',{p_fingerprint:fingerprint});if(limitError||!allowed)throw new AppError('로그인 시도가 많습니다. 잠시 후 다시 시도하세요.',429);
  const {data:alias}=await admin.from('login_aliases').select('email').eq('username',username).maybeSingle();
  // Unknown aliases also perform Auth work and return the exact same message.
  const {data,error}=await admin.auth.signInWithPassword({email:alias?.email||'unavailable@accounts.restudy.invalid',password:String(body.password||'').slice(0,256)});
  if(error||!alias||!data.session)throw new AppError('아이디 또는 비밀번호를 확인해 주세요.',401);
  return json({session:data.session,user:{id:data.user.id,username}},200,req);
 }catch(error){return errorResponse(error,req)}
});
