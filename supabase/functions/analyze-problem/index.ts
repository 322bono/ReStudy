import { handleAI } from "../_shared/ai/handlers.ts";
Deno.serve((req: Request) => handleAI(req, "analyze"));
