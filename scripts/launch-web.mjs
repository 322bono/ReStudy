import {spawnSync,spawn}from'node:child_process';
import{existsSync}from'node:fs';
import{fileURLToPath}from'node:url';
import path from'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),npm=process.platform==='win32'?'npm.cmd':'npm';
function run(args){const result=spawnSync(npm,args,{cwd:root,stdio:'inherit',shell:process.platform==='win32'});if(result.status!==0)process.exit(result.status||1)}
let running=false;try{const response=await fetch('http://127.0.0.1:3000/',{signal:AbortSignal.timeout(1500)});running=(await response.text()).includes('data-restudy-version="3"')}catch{}
if(!running){if(!existsSync(path.join(root,'node_modules/vite')))run(['ci']);run(['run','build']);const args=['run','start','--',...(process.env.RE_NO_BROWSER==='1'?[]:['--open'])];const child=spawn(npm,args,{cwd:root,stdio:'inherit',shell:process.platform==='win32'});child.on('exit',code=>process.exit(code||0));}else console.log('RE:STUDY가 실행 중입니다: http://localhost:3000');
