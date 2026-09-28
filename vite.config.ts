import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { readServerEnvironment } from "./server/env.ts";

type BrainHandlerModule = typeof import("./server/brainHandler.ts");
type DuelServerModule = typeof import("./server/duelServer.ts");

// Mounts POST /api/brain and the Jev vs Jev WebSocket on the dev server. The key is read without a VITE_ prefix,
// so it is never exposed to client code.
// The handler is imported at runtime (not statically) so Vite doesn't treat src/config.ts as a
// config dependency and restart the dev server on every tuning edit. Restart manually after
// editing server/ code.
function brainProxyPlugin(): Plugin {
  return {
    name: "jevcaster-brain-proxy",
    async configureServer(server) {
      const environment = readServerEnvironment(loadEnv(server.config.mode, process.cwd(), ""));
      const handlerUrl = pathToFileURL(resolve(process.cwd(), "server/brainHandler.ts")).href;
      const { createBrainHandler } = (await import(handlerUrl)) as BrainHandlerModule;
      const brainHandler = createBrainHandler(environment);
      server.middlewares.use((request, response, next) => {
        void brainHandler.middleware(request, response, next);
      });
      if (server.httpServer) {
        const duelUrl = pathToFileURL(resolve(process.cwd(), "server/duelServer.ts")).href;
        const { attachDuelServer } = (await import(duelUrl)) as DuelServerModule;
        attachDuelServer(server.httpServer as import("node:http").Server, brainHandler);
      }
      if (!environment.apiKey) server.config.logger.warn("[brain] TYPESAFE_API_KEY not set: /api/brain answers no_api_key, the game uses the heuristic brain.");
    },
  };
}

export default defineConfig({
  plugins: [brainProxyPlugin()],
});
