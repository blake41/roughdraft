import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";

/**
 * Handler invoked once per accepted WebSocket connection on a registered path.
 * The `req` is the original HTTP upgrade request, so route handlers can read
 * the query string, headers, etc.
 */
export type WsConnectionHandler = (
  socket: WebSocket,
  req: IncomingMessage,
) => void;

export interface CreateWsLayerOptions {
  /**
   * Interval between heartbeat pings, in milliseconds. A connection that has
   * not answered the previous ping with a pong by the next tick is terminated.
   * Injectable so tests don't have to wait the 15s production default.
   */
  pingIntervalMs?: number;
}

export interface WsLayer {
  /**
   * Attach the shared upgrade handler to an http.Server. Call this for every
   * server instance (one per bind host) so no bind host silently loses WS.
   */
  handleUpgrade(server: Server): void;
  /**
   * Register a connection handler for an exact URL pathname (e.g.
   * "/api/markdown-file/events"). Upgrades to unregistered paths are rejected.
   */
  registerRoute(pathname: string, onConnection: WsConnectionHandler): void;
}

const DEFAULT_PING_INTERVAL_MS = 15_000;

/**
 * Write a minimal HTTP response and destroy the socket. Used to reject an
 * upgrade before the WebSocket handshake completes (unknown path, bad origin).
 */
function rejectUpgrade(
  socket: Duplex,
  statusCode: number,
  statusText: string,
): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n",
  );
  socket.destroy();
}

/**
 * Origin validation (plan R6 / Decision 8). WebSocket connections are not
 * subject to CORS, so without this any web page could open a socket to the
 * local server. Accept when:
 *   - the Origin header is absent (non-browser client), or
 *   - the Origin's host matches the request's Host header (same-origin).
 * Reject everything else.
 */
function isOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;

  const host = req.headers.host;
  if (host === undefined) return false;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createWsLayer(options: CreateWsLayerOptions = {}): WsLayer {
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const routes = new Map<string, WsConnectionHandler>();
  // Single shared server in noServer mode: it performs the handshake but never
  // owns an http.Server, so the same instance serves every bind host.
  const wss = new WebSocketServer({ noServer: true });

  function startHeartbeat(socket: WebSocket): void {
    // Per-connection liveness flag reset by each pong. If a full interval
    // elapses without a pong, the peer is gone — terminate it.
    let awaitingPong = false;

    const interval = setInterval(() => {
      if (awaitingPong) {
        socket.terminate();
        return;
      }
      awaitingPong = true;
      socket.ping();
    }, pingIntervalMs);

    socket.on("pong", () => {
      awaitingPong = false;
    });
    socket.on("close", () => {
      clearInterval(interval);
    });
  }

  function registerRoute(
    pathname: string,
    onConnection: WsConnectionHandler,
  ): void {
    routes.set(pathname, onConnection);
  }

  function handleUpgrade(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      let pathname: string;
      try {
        // req.url is path-only ("/api/...?x=1"); base is required but unused.
        pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      } catch {
        rejectUpgrade(socket, 400, "Bad Request");
        return;
      }

      const onConnection = routes.get(pathname);
      if (onConnection === undefined) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }

      if (!isOriginAllowed(req)) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        startHeartbeat(ws);
        onConnection(ws, req);
      });
    });
  }

  return { handleUpgrade, registerRoute };
}
