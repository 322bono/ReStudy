import {cpSync,mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
const font='public/fonts/PretendardVariable.woff2',fontHash='9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4';
if(!existsSync(font)){
 const response=await fetch('https://raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard/dist/web/variable/woff2/PretendardVariable.woff2');
 if(!response.ok)throw new Error('Pretendard 초기 준비에 실패했습니다.');
 const bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==fontHash)throw new Error('Pretendard 파일 검증에 실패했습니다.');
 mkdirSync('public/fonts',{recursive:true});writeFileSync(font,bytes);
}
for(const name of ['cmaps','standard_fonts','wasm','iccs']){
  const source=path.resolve('node_modules/pdfjs-dist',name),target=path.resolve('public/pdfjs',name);
  mkdirSync(target,{recursive:true});cpSync(source,target,{recursive:true});
}
cpSync('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs','public/pdfjs/pdf.worker.legacy.min.mjs');
mkdirSync('public/ocr/core',{recursive:true});
cpSync('node_modules/tesseract.js/dist/worker.min.js','public/ocr/worker.min.js');
cpSync('node_modules/tesseract.js-core','public/ocr/core',{recursive:true});
mkdirSync('public/ocr/lang',{recursive:true});
for(const [lang,hash] of Object.entries({eng:'7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',kor:'6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2'})){
 const output=`public/ocr/lang/${lang}.traineddata.gz`;
 if(existsSync(output))continue;
 const response=await fetch(`https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${lang}.traineddata`);
 if(!response.ok)throw new Error(`한국어/영어 OCR 초기 준비에 실패했습니다: ${lang}`);
 const bytes=Buffer.from(await response.arrayBuffer());
 if(createHash('sha256').update(bytes).digest('hex')!==hash)throw new Error(`OCR 언어 파일 검증에 실패했습니다: ${lang}`);
 writeFileSync(output,gzipSync(bytes));
}
