import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cli=path.join(root,'node_modules','.bin',process.platform==='win32'?'supabase.cmd':'supabase');
const project='tfjsrdfnrybepxpdfqfz';
const run=(args,options={})=>spawnSync(cli,args,{cwd:root,encoding:'utf8',shell:process.platform==='win32',...options});
const listed=run(['secrets','list','--project-ref',project,'--output','json']);
if(listed.status!==0){console.error('먼저 Supabase CLI에서 올바른 계정으로 로그인하세요.');process.exit(1)}
let names;try{names=JSON.parse(listed.stdout)}catch{console.error('서버 비밀값 목록을 확인하지 못했습니다.');process.exit(1)}
if(!Array.isArray(names)){console.error('서버 비밀값 목록 형식이 다릅니다.');process.exit(1)}
if(names.some(v=>v.name==='RE_CREDENTIAL_MASTER_KEY')){console.log('기존 서버 마스터 키를 유지합니다.');process.exit(0)}
const folder=path.join(root,'data');mkdirSync(folder,{recursive:true});
const file=path.join(folder,`.server-secret-${randomBytes(8).toString('hex')}.env`);
try{
 writeFileSync(file,`RE_CREDENTIAL_MASTER_KEY=${randomBytes(32).toString('base64')}\n`,{flag:'wx',mode:0o600});
 const saved=run(['secrets','set','--project-ref',project,'--env-file',file],{stdio:['ignore','pipe','pipe']});
 if(saved.status!==0){console.error('서버 키를 등록하지 못했습니다. 계정 권한을 확인하세요.');process.exitCode=1}else console.log('서버 암호화 키를 등록했습니다. 값은 출력하거나 보관하지 않습니다.');
}finally{unlinkSync(file)}
