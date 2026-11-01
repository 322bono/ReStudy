import {readInput,AppError,context,errorResponse,json,preflight} from '../_shared/context.ts';
import {handleStandard} from '../_shared/standard/service.ts';
Deno.serve(async req=>{const early=preflight(req);if(early)return early;try{if(req.method!=='POST')throw new AppError('지원하지 않는 요청입니다.',405);return json(await handleStandard(await context(req),await readInput(req)),200,req)}catch(error){return errorResponse(error,req)}});
