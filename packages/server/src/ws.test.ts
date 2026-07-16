import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createWsLayer, type WsLayer } from "./ws.js";

// These tests boot a REAL listening http.Server on an ephemeral port and use
// the `ws` client to drive an actual WebSocket upgrade handshake. supertest
// cannot exercise upgrades (it never calls .listen()), and the upgrade
// handshake IS the behavior under test, so real sockets are required.

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (teardown.length > 0) {
    const fn = teardown.pop();
    if (fn) await fn();
  }
});

interface BootedServer {
  host: string;
  port: number;
  server: Server;
  bound: boolean;
}

/**
 * Boot an http.Server on `host:0`, attach the ws layer, and return the chosen
 * port. If the host cannot be bound (e.g. no IPv6 loopback in the sandbox),
 * resolves with `bound: false` instead of throwing so callers can skip.
 */
function bootServer(layer: WsLayer, host = "127.0.0.1"): Promise<BootedServer> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(426);
      res.end();
    });
    layer.handleUpgrade(server);
    teardown.push(
      () =>
        new Promise<void>((done) => {
          server.close(() => done());
        }),
    );

    server.once("error", () => {
      resolve({ host, port: 0, server, bound: false });
    });
    server.listen(0, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ host, port, server, bound: true });
    });
  });
}

function wsUrl(host: string, port: number, path: string): string {
  const authority = host.includes(":") ? `[${host}]` : host;
  return `ws://${authority}:${port}${path}`;
}

function trackClient(ws: WebSocket): WebSocket {
  teardown.push(async () => {
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.terminate();
    }
  });
  return ws;
}

/** Resolve with the first text message; reject on error/open-without-message. */
function firstMessage(
  url: string,
  options?: ConstructorParameters<typeof WebSocket>[2],
): Promise<string> {
  const ws = trackClient(new WebSocket(url, options));
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("no message in 1000ms")),
      1000,
    );
    ws.on("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Resolve with the connection error (rejection). Fails if it connects. */
function expectRejected(
  url: string,
  options?: ConstructorParameters<typeof WebSocket>[2],
): Promise<Error> {
  const ws = trackClient(new WebSocket(url, options));
  return new Promise<Error>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("upgrade neither succeeded nor failed (hang)")),
      1000,
    );
    ws.on("error", (err) => {
      clearTimeout(timer);
      resolve(err);
    });
    ws.on("open", () => {
      clearTimeout(timer);
      reject(new Error("upgrade unexpectedly succeeded"));
    });
  });
}

describe("createWsLayer", () => {
  it("delivers a message to a client on a registered path", async () => {
    const layer = createWsLayer({ pingIntervalMs: 50 });
    layer.registerRoute("/api/ws", (socket) => socket.send("hello"));
    const { port } = await bootServer(layer);

    const message = await firstMessage(wsUrl("127.0.0.1", port, "/api/ws"));
    expect(message).toBe("hello");
  });

  it("passes the upgrade request to the route handler", async () => {
    const layer = createWsLayer({ pingIntervalMs: 50 });
    layer.registerRoute("/api/ws", (socket, req) => {
      const { searchParams } = new URL(req.url ?? "/", "http://localhost");
      socket.send(searchParams.get("path") ?? "");
    });
    const { port } = await bootServer(layer);

    const message = await firstMessage(
      wsUrl("127.0.0.1", port, "/api/ws?path=README.md"),
    );
    expect(message).toBe("README.md");
  });

  it("sends heartbeat pings on the configured interval and keeps the socket open", async () => {
    const layer = createWsLayer({ pingIntervalMs: 30 });
    layer.registerRoute("/api/ws", () => {});
    const { port } = await bootServer(layer);

    const ws = trackClient(new WebSocket(wsUrl("127.0.0.1", port, "/api/ws")));
    const pinged = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no ping in 500ms")),
        500,
      );
      ws.on("ping", () => {
        clearTimeout(timer);
        resolve(true);
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(pinged).toBe(true);
    // Past several intervals with pong replies flowing, the socket is alive.
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("terminates a connection that stops answering pings", async () => {
    const layer = createWsLayer({ pingIntervalMs: 40 });
    let serverSocket: WebSocket | undefined;
    let resolveServerSocket: () => void;
    const serverConnected = new Promise<void>((resolve) => {
      resolveServerSocket = resolve;
    });
    layer.registerRoute("/api/ws", (socket) => {
      serverSocket = socket;
      resolveServerSocket();
    });
    const { port } = await bootServer(layer);

    const ws = trackClient(new WebSocket(wsUrl("127.0.0.1", port, "/api/ws")));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    await serverConnected;

    // Stop reading frames so the client never auto-responds to the ping.
    // The server should notice the missing pong and terminate its side.
    (ws as unknown as { _socket: Socket })._socket.pause();

    const closed = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("dead socket was not terminated in 1500ms")),
        1500,
      );
      serverSocket?.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(closed).toBe(true);
  });

  it("rejects an upgrade to an unregistered path without hanging", async () => {
    const layer = createWsLayer({ pingIntervalMs: 50 });
    layer.registerRoute("/api/ws", (socket) => socket.send("hi"));
    const { port } = await bootServer(layer);

    const error = await expectRejected(wsUrl("127.0.0.1", port, "/api/nope"));
    expect(error.message).toContain("404");
  });

  describe("origin validation (R6 / Decision 8)", () => {
    it("accepts a connection with no Origin header (non-browser client)", async () => {
      const layer = createWsLayer({ pingIntervalMs: 50 });
      layer.registerRoute("/api/ws", (socket) => socket.send("ok"));
      const { port } = await bootServer(layer);

      // The ws client sends no Origin header by default.
      const message = await firstMessage(wsUrl("127.0.0.1", port, "/api/ws"));
      expect(message).toBe("ok");
    });

    it("accepts a same-origin browser connection", async () => {
      const layer = createWsLayer({ pingIntervalMs: 50 });
      layer.registerRoute("/api/ws", (socket) => socket.send("ok"));
      const { port } = await bootServer(layer);

      const message = await firstMessage(wsUrl("127.0.0.1", port, "/api/ws"), {
        headers: { Origin: `http://127.0.0.1:${port}` },
      });
      expect(message).toBe("ok");
    });

    it("rejects a cross-origin browser connection with 403", async () => {
      const layer = createWsLayer({ pingIntervalMs: 50 });
      layer.registerRoute("/api/ws", (socket) => socket.send("ok"));
      const { port } = await bootServer(layer);

      const error = await expectRejected(wsUrl("127.0.0.1", port, "/api/ws"), {
        headers: { Origin: "https://evil.example" },
      });
      expect(error.message).toContain("403");
    });
  });

  it("accepts upgrades on every http.Server the layer is attached to (dual bind host)", async () => {
    const layer = createWsLayer({ pingIntervalMs: 50 });
    layer.registerRoute("/api/ws", (socket) => socket.send("hi"));

    const ipv4 = await bootServer(layer, "127.0.0.1");
    expect(ipv4.bound).toBe(true);
    expect(await firstMessage(wsUrl(ipv4.host, ipv4.port, "/api/ws"))).toBe(
      "hi",
    );

    const ipv6 = await bootServer(layer, "::1");
    if (ipv6.bound) {
      expect(await firstMessage(wsUrl(ipv6.host, ipv6.port, "/api/ws"))).toBe(
        "hi",
      );
    } else {
      // No IPv6 loopback in this environment; the IPv4 assertion above still
      // proves the per-server attachment. createServer() skips unbindable
      // hosts the same way (EADDRNOTAVAIL/EAFNOSUPPORT).
      console.warn("skipping ::1 assertion: host could not be bound");
    }
  });
});
