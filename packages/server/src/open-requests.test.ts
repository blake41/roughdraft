import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "./index.js";

// These tests boot a REAL listening http.Server wired to the real Express app +
// WS upgrade handler. The open-request feature is a cross-route contract: a
// browser tab registers as an open-request listener over the WS route, and the
// CLI's POST /api/open-request (still HTTP) delivers a navigation to the
// most-recently-registered listener whose `path` matches. supertest cannot
// exercise the WS upgrade, and the registration/delivery handoff across the two
// routes IS the behavior under test, so a real listening server + real `ws`
// client are required. POST is issued with global fetch against the same server.

const OPEN_REQUESTS_PATH = "/api/open-requests";

const teardown: Array<() => Promise<void> | void> = [];

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-openreq-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-home-"));
});

afterEach(async () => {
  while (teardown.length > 0) {
    const fn = teardown.pop();
    if (fn) await fn();
  }
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

interface BootedApp {
  origin: string;
  port: number;
}

/** Boot the real app on an ephemeral port with the WS upgrade handler attached. */
function bootApp(): Promise<BootedApp> {
  const { app, handleUpgrade } = createApp({
    homeDir,
    staticDirPath: projectDir,
  });
  const server: Server = createServer(app);
  handleUpgrade(server);
  teardown.push(
    () =>
      new Promise<void>((done) => {
        server.close(() => done());
      }),
  );
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, port });
    });
  });
}

function openRequestsUrl(port: number, listenerPath?: string): string {
  const search = new URLSearchParams();
  if (listenerPath !== undefined) search.set("path", listenerPath);
  const query = search.toString();
  return `ws://127.0.0.1:${port}${OPEN_REQUESTS_PATH}${
    query ? `?${query}` : ""
  }`;
}

interface OpenedSocket {
  ws: WebSocket;
  messages: unknown[];
  waitForMessage: () => Promise<unknown>;
  closeAndWait: () => Promise<void>;
}

/** Open a socket, wait for the handshake, and buffer parsed JSON messages. */
async function openSocket(url: string): Promise<OpenedSocket> {
  const ws = new WebSocket(url);
  teardown.push(() => {
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.terminate();
    }
  });
  const messages: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  ws.on("message", (data) => {
    const parsed = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else messages.push(parsed);
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  return {
    ws,
    messages,
    waitForMessage: () =>
      new Promise((resolve, reject) => {
        const buffered = messages.shift();
        if (buffered !== undefined) {
          resolve(buffered);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("no message within 4000ms")),
          4000,
        );
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      }),
    closeAndWait: () =>
      new Promise<void>((resolve) => {
        ws.on("close", () => resolve());
        ws.close();
      }),
  };
}

interface PostResult {
  status: number;
  body: { delivered?: boolean; error?: string };
}

async function postOpenRequest(
  origin: string,
  payload: Record<string, unknown>,
): Promise<PostResult> {
  const response = await fetch(`${origin}/api/open-request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

describe("open-requests WebSocket route", () => {
  it("delivers a POST open-request to the registered listener for that path", async () => {
    const target = path.join(projectDir, "draft.md");
    const url = "http://127.0.0.1/?path=/tmp/draft.md";
    const { origin, port } = await bootApp();

    const socket = await openSocket(openRequestsUrl(port, target));

    // First message on connect is the registration ack.
    const connected = (await socket.waitForMessage()) as {
      type: string;
      id: number;
    };
    expect(connected.type).toBe("connected");
    expect(connected.id).toEqual(expect.any(Number));

    const post = await postOpenRequest(origin, { path: target, url });
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ delivered: true });

    const delivered = (await socket.waitForMessage()) as {
      type: string;
      path: string;
      url: string;
    };
    expect(delivered).toEqual({ type: "open-request", path: target, url });
  });

  it("delivers to the most-recently-registered listener when two share a path", async () => {
    const target = path.join(projectDir, "shared.md");
    const url = "http://127.0.0.1/?path=/tmp/shared.md";
    const { origin, port } = await bootApp();

    const first = await openSocket(openRequestsUrl(port, target));
    await first.waitForMessage(); // connected ack
    const second = await openSocket(openRequestsUrl(port, target));
    await second.waitForMessage(); // connected ack

    const post = await postOpenRequest(origin, { path: target, url });
    expect(post.body).toEqual({ delivered: true });

    const delivered = (await second.waitForMessage()) as { type: string };
    expect(delivered).toEqual({ type: "open-request", path: target, url });

    // The earlier listener must not have received the navigation.
    expect(first.messages).toHaveLength(0);
  });

  it("returns delivered:false after the matching listener disconnects", async () => {
    const target = path.join(projectDir, "gone.md");
    const url = "http://127.0.0.1/?path=/tmp/gone.md";
    const { origin, port } = await bootApp();

    const socket = await openSocket(openRequestsUrl(port, target));
    await socket.waitForMessage(); // connected ack

    // Close the client and wait for the server to observe the close and remove
    // it from the registry before the POST runs its lookup.
    await socket.closeAndWait();
    await new Promise((r) => setTimeout(r, 150));

    const post = await postOpenRequest(origin, { path: target, url });
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ delivered: false });
  });

  it("rejects a POST open-request missing path or url with 400", async () => {
    const { origin } = await bootApp();

    const missingUrl = await postOpenRequest(origin, {
      path: path.join(projectDir, "x.md"),
    });
    expect(missingUrl.status).toBe(400);
    expect(missingUrl.body).toEqual({ error: "path and url are required" });

    const missingPath = await postOpenRequest(origin, {
      url: "http://127.0.0.1/?path=/tmp/x.md",
    });
    expect(missingPath.status).toBe(400);
  });
});
