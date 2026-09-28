import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import type { BrainTransport } from "../src/jev/jevBrain.ts";
import { config } from "../src/config.ts";
import type { createBrainHandler } from "./brainHandler.ts";
import { createDuelHost, type DuelHost } from "./duelHost.ts";

type BrainHandler = ReturnType<typeof createBrainHandler>;

// A viewer whose socket has this much unsent data skips steps until it catches up.
const maxBufferedBytes = 1_000_000;
const maxIncomingBytes = 16_000;

export type DuelServerOptions = {
  // Destroy upgrade requests for other paths. Off under Vite, whose HMR socket shares the HTTP server.
  exclusive?: boolean;
  // Accept dev panel edits from viewers (default on).
  tuning?: boolean;
};

// Mounts the Jev vs Jev WebSocket on an HTTP server. Jev calls go straight to the brain handler, in process.
export function attachDuelServer(httpServer: Server, brainHandler: BrainHandler, options: DuelServerOptions = {}): DuelHost {
  const transport: BrainTransport = async (request, signal) => (await brainHandler.handle(request, signal)).body;
  const host = createDuelHost({
    transport,
    jevOnline: () => brainHandler.status().hasApiKey,
    tuning: options.tuning,
  });
  // Steps are repetitive JSON, so compression cuts each viewer's bandwidth several times over.
  const socketServer = new WebSocketServer({ noServer: true, maxPayload: maxIncomingBytes, perMessageDeflate: true });

  httpServer.on("upgrade", (request, socket, head) => {
    if ((request.url ?? "").split("?")[0] !== config.duel.socketPath) {
      if (options.exclusive) socket.destroy();
      return;
    }
    socketServer.handleUpgrade(request, socket, head, (webSocket) => {
      const connection = host.addViewer({
        send: (data) => webSocket.send(data),
        canTakeSteps: () => webSocket.bufferedAmount < maxBufferedBytes,
      });
      webSocket.on("message", (data) => connection.receive(data.toString()));
      webSocket.on("close", () => connection.close());
      webSocket.on("error", () => webSocket.terminate());
    });
  });
  httpServer.on("close", () => host.shutdown());
  return host;
}
