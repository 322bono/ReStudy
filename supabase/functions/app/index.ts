import {readInput,AppError,context,errorResponse,json,preflight} from '../_shared/context.ts';
import {handle} from '../_shared/app/routes.ts';
Deno.serve(async req=>{const early=preflight(req);if(early)return early;try{if(req.method!=='POST')throw new AppError('지원하지 않는 요청입니다.',405);const ctx=await context(req);const input=await readInput(req);return json(await handle(ctx,input),200,req);}catch(error){return errorResponse(error,req)}});
