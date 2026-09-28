import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { createBrainHandler } from "./brainHandler.ts";
import { attachDuelServer } from "./duelServer.ts";
import { loadServerEnvironment } from "./env.ts";

const distDirectory = resolve(process.cwd(), "dist");
const port = Number(process.env.PORT ?? 4173);

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

if (!existsSync(distDirectory)) {
  console.error("dist/ not found. Run `pnpm build` first.");
  process.exit(1);
}

const environment = loadServerEnvironment();
const brainHandler = createBrainHandler(environment);

function serveStatic(urlPath: string, response: import("node:http").ServerResponse): void {
  const requestedPath = resolve(distDirectory, "." + decodeURIComponent(urlPath));
  const insideDist = requestedPath === distDirectory || requestedPath.startsWith(distDirectory + sep);
  const isFile = insideDist && existsSync(requestedPath) && statSync(requestedPath).isFile();
  const filePath = isFile ? requestedPath : resolve(distDirectory, "index.html");
  response.setHeader("content-type", contentTypes[extname(filePath)] ?? "application/octet-stream");
  createReadStream(filePath).pipe(response);
}

// The public server: the production client only watches Jev vs Jev, so /api/brain isn't exposed (nobody else can
// spend the key) and viewers can't tune the shared duel. Jev is called in process by the duel host.
const httpServer = createServer((request, response) => {
  serveStatic((request.url ?? "/").split("?")[0] ?? "/", response);
});
const duelHost = attachDuelServer(httpServer, brainHandler, { exclusive: true, tuning: false });
// Save the Jev vs Jev totals on the way out.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    duelHost.shutdown();
    process.exit(0);
  });
}

httpServer.listen(port, () => {
  console.log(`Jevcaster on http://localhost:${port} (Jev ${environment.apiKey ? "enabled" : "disabled: no TYPESAFE_API_KEY"})`);
});
