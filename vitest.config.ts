import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // D1 and DO bindings available in tests via env.DB and env.GAME_ROOM
        },
      },
    },
  },
});
