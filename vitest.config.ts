import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export default defineConfig({
  resolve: {
    alias: {
      "npm:@supabase/supabase-js@2.118.0":
        require.resolve("@supabase/supabase-js"),
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
