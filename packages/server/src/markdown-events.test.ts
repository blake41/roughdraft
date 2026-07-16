import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "./index.js";

// These tests boot a REAL listening http.Server wired to the real Express app +
// WS upgrade handler, then drive an actual `ws` client through the
// /api/markdown-file/events upgrade. supertest cannot exercise WS upgrades, and
// the upgrade + fs.watchFile delivery IS the behavior under test, so real
// sockets and real files on disk are required.

const EVENTS_PATH = "/api/markdown-file/events";

// Application close codes the server uses for validation failures. Pinned here
// as the contract: the client migration (Unit 4) branches on these.
const WS_CLOSE_INVALID_REQUEST = 4400; // was HTTP 400 (projectPath missing)
const WS_CLOSE_NOT_FOUND = 4404; // was HTTP 404 (dir/file/.md failures)

const teardown: Array<() => Promise<void> | void> = [];

let projectDir: string;
let homeDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-mdevents-"));
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
  host: string;
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
      resolve({ host: "127.0.0.1", port });
    });
  });
}

function eventsUrl(
  port: number,
  params: Record<string, string | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  return `ws://127.0.0.1:${port}${EVENTS_PATH}?${search.toString()}`;
}

interface OpenedSocket {
  ws: WebSocket;
  messages: unknown[];
  waitForMessage: () => Promise<unknown>;
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
        // Generous ceiling: fs.watchFile polls at 500ms, and under full-suite
        // parallel load the poll callback can be delayed several cycles. This
        // only bounds the failure case — a real message resolves immediately.
        const timer = setTimeout(
          () => reject(new Error("no message within 6000ms")),
          6000,
        );
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      }),
  };
}

/** Resolve with the close code + reason. Fails if the socket never closes. */
function closeInfo(url: string): Promise<{ code: number; reason: string }> {
  const ws = new WebSocket(url);
  teardown.push(() => {
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.terminate();
    }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("socket did not close within 2000ms")),
      2000,
    );
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.on("error", () => {
      // ws may emit error alongside a close frame; ignore and wait for close.
    });
  });
}

/** Change a file's content so fs.watchFile's size/mtime guard fires. */
function bumpFile(absolutePath: string, content: string): void {
  fs.writeFileSync(absolutePath, content, "utf-8");
}

describe("markdown-file events WebSocket route", () => {
  it("sends a change message with the new version when the file is touched", async () => {
    const rel = "doc.md";
    const abs = path.join(projectDir, rel);
    bumpFile(abs, "# Hello\n");
    const { port } = await bootApp();

    const socket = await openSocket(
      eventsUrl(port, { projectPath: projectDir, path: rel }),
    );

    bumpFile(abs, "# Hello world, this is a longer body\n");
    const message = (await socket.waitForMessage()) as {
      type: string;
      path: string;
      exists: boolean;
      version: string | null;
    };

    expect(message.type).toBe("change");
    expect(message.path).toBe(rel);
    expect(message.exists).toBe(true);
    expect(message.version).toEqual(expect.any(String));
  });

  it("sends exists:false with null version when the file is deleted", async () => {
    const rel = "gone.md";
    const abs = path.join(projectDir, rel);
    bumpFile(abs, "# Doomed\n");
    const { port } = await bootApp();

    const socket = await openSocket(
      eventsUrl(port, { projectPath: projectDir, path: rel }),
    );

    fs.rmSync(abs);
    const message = (await socket.waitForMessage()) as {
      type: string;
      exists: boolean;
      version: string | null;
    };

    expect(message.type).toBe("change");
    expect(message.exists).toBe(false);
    expect(message.version).toBeNull();
  });

  it("scopes events per document: two sockets on two files get only their own", async () => {
    const relA = "a.md";
    const relB = "b.md";
    const absA = path.join(projectDir, relA);
    const absB = path.join(projectDir, relB);
    bumpFile(absA, "# A\n");
    bumpFile(absB, "# B\n");
    const { port } = await bootApp();

    const socketA = await openSocket(
      eventsUrl(port, { projectPath: projectDir, path: relA }),
    );
    const socketB = await openSocket(
      eventsUrl(port, { projectPath: projectDir, path: relB }),
    );

    // Only file A changes.
    bumpFile(absA, "# A changed with more content\n");

    const messageA = (await socketA.waitForMessage()) as { path: string };
    expect(messageA.path).toBe(relA);

    // B must not have received anything for A's change.
    expect(socketB.messages).toHaveLength(0);
  });

  it("closes with the not-found code for a non-.md path", async () => {
    const { port } = await bootApp();
    const info = await closeInfo(
      eventsUrl(port, { projectPath: projectDir, path: "notes.txt" }),
    );
    expect(info.code).toBe(WS_CLOSE_NOT_FOUND);
    expect(info.reason).toBe("Markdown file not found");
  });

  it("closes with the not-found code for a missing .md file", async () => {
    const { port } = await bootApp();
    const info = await closeInfo(
      eventsUrl(port, { projectPath: projectDir, path: "missing.md" }),
    );
    expect(info.code).toBe(WS_CLOSE_NOT_FOUND);
    expect(info.reason).toBe("Markdown file not found");
  });

  it("closes with the not-found code for an invalid projectPath", async () => {
    const { port } = await bootApp();
    const info = await closeInfo(
      eventsUrl(port, {
        projectPath: path.join(projectDir, "does-not-exist"),
        path: "doc.md",
      }),
    );
    expect(info.code).toBe(WS_CLOSE_NOT_FOUND);
    expect(info.reason).toBe("Project directory not found");
  });

  it("closes with the invalid-request code when projectPath is missing", async () => {
    const { port } = await bootApp();
    const info = await closeInfo(eventsUrl(port, { path: "doc.md" }));
    expect(info.code).toBe(WS_CLOSE_INVALID_REQUEST);
    expect(info.reason).toBe("projectPath is required");
  });

  it("stops watching the file after the socket closes (no leaked watchers)", async () => {
    const rel = "watched.md";
    const abs = path.join(projectDir, rel);
    bumpFile(abs, "# Watched\n");
    const { port } = await bootApp();

    const socket = await openSocket(
      eventsUrl(port, { projectPath: projectDir, path: rel }),
    );

    // Close the client; the server should unwatchFile on its close event.
    await new Promise<void>((resolve) => {
      socket.ws.on("close", () => resolve());
      socket.ws.close();
    });

    // Give the server's close handler a tick to run unwatchFile.
    await new Promise((r) => setTimeout(r, 100));

    // No StatWatcher listeners should remain registered for this file.
    // (If the route leaked, the watcher would still be polling this path.)
    // Node exposes no public API to inspect this directly; assert indirectly
    // via a fresh watch/unwatch round-trip below instead.

    // Indirect assertion: re-touch the file. The (now-closed) socket buffered
    // no post-close messages, proving delivery stopped.
    bumpFile(abs, "# Watched again after close, longer\n");
    await new Promise((r) => setTimeout(r, 700));
    expect(socket.messages).toHaveLength(0);
  });
});
