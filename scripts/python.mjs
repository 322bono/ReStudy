import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const local=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const result=spawnSync(existsSync(local)?local:'python',process.argv.slice(2),{cwd:root,stdio:'inherit'});
if(result.error){process.stderr.write('Python 실행 환경을 찾지 못했습니다. start.bat로 초기 설치를 진행해 주세요.\n');process.exit(1);}
process.exit(result.status??1);
