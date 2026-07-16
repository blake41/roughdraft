import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiBackend } from "./api-backend";
import type { MarkdownFileChangeEvent } from "./storage";

/**
 * Minimal stand-in for the browser WebSocket. Tests drive the lifecycle by
 * calling the `emit*` helpers; the utility under test wires the `on*` handlers.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset() {
    FakeWebSocket.instances = [];
  }
  static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("no FakeWebSocket has been constructed");
    return socket;
  }

  url: string;
  readyState = 0;
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  emitOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  emitMessage(data: unknown) {
    this.onmessage?.({ data });
  }
  emitClose() {
    this.readyState = 3;
    this.onclose?.();
  }
  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    this.onclose?.();
  }
}

function makeBackend(): ApiBackend {
  return new ApiBackend({
    kind: "local-files",
    label: "Local files",
    detail: "/work",
    projectPath: "/work",
  });
}

/** Wait for the resync fetch chain (fetch → json → compare) to settle. */
async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe("ApiBackend.watchMarkdownFile (WebSocket transport)", () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("connects to the file-events endpoint over ws:// with the path in the query", () => {
    const backend = makeBackend();
    backend.watchMarkdownFile("notes.md", () => {});

    const wsUrl = new URL(FakeWebSocket.latest().url);
    expect(wsUrl.protocol).toBe("ws:");
    expect(wsUrl.pathname).toBe("/api/markdown-file/events");
    expect(wsUrl.searchParams.get("path")).toBe("notes.md");
  });

  it("delivers a parsed change message to the onChange callback", () => {
    const backend = makeBackend();
    const events: MarkdownFileChangeEvent[] = [];
    backend.watchMarkdownFile("notes.md", (event) => events.push(event));

    const socket = FakeWebSocket.latest();
    socket.emitOpen();
    socket.emitMessage(
      JSON.stringify({
        type: "change",
        path: "notes.md",
        exists: true,
        version: "v2",
      }),
    );

    expect(events).toEqual([
      { type: "change", path: "notes.md", exists: true, version: "v2" },
    ]);
  });

  it("logs and keeps running when a message is malformed JSON", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const backend = makeBackend();
    const events: MarkdownFileChangeEvent[] = [];
    backend.watchMarkdownFile("notes.md", (event) => events.push(event));

    const socket = FakeWebSocket.latest();
    socket.emitOpen();
    socket.emitMessage("not json {");
    // The watcher survives: a subsequent valid message is still delivered.
    socket.emitMessage(
      JSON.stringify({ path: "notes.md", exists: true, version: "v3" }),
    );

    expect(errorSpy).toHaveBeenCalled();
    expect(events).toEqual([{ path: "notes.md", exists: true, version: "v3" }]);
  });

  it("stops watching (closes the socket) when the returned disposer is called", () => {
    vi.useFakeTimers();
    const backend = makeBackend();
    const stop = backend.watchMarkdownFile("notes.md", () => {});

    const socket = FakeWebSocket.latest();
    socket.emitOpen();
    stop();

    expect(socket.closeCalls).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(FakeWebSocket.instances).toHaveLength(1); // no reconnect
  });

  it("emits a synthetic change on reconnect when the version advanced during the gap", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: "notes.md",
        title: "Notes",
        content: "hi",
        version: "v9",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const backend = makeBackend();
    const events: MarkdownFileChangeEvent[] = [];
    backend.watchMarkdownFile("notes.md", (event) => events.push(event));

    // First open establishes baseline "v5" via a live change message.
    FakeWebSocket.latest().emitOpen();
    FakeWebSocket.latest().emitMessage(
      JSON.stringify({
        type: "change",
        path: "notes.md",
        exists: true,
        version: "v5",
      }),
    );
    events.length = 0; // ignore the live change; we only assert on the resync

    // Drop, reconnect; file changed to "v9" while we were gone.
    FakeWebSocket.latest().emitClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.latest().emitOpen();
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ path: "notes.md", exists: true, version: "v9" }]);
  });

  it("emits nothing on reconnect when the version is unchanged", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: "notes.md",
        title: "Notes",
        content: "hi",
        version: "v5",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const backend = makeBackend();
    const events: MarkdownFileChangeEvent[] = [];
    backend.watchMarkdownFile("notes.md", (event) => events.push(event));

    FakeWebSocket.latest().emitOpen();
    FakeWebSocket.latest().emitMessage(
      JSON.stringify({
        type: "change",
        path: "notes.md",
        exists: true,
        version: "v5",
      }),
    );
    events.length = 0;

    FakeWebSocket.latest().emitClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.latest().emitOpen();
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it("emits exists:false when the resync fetch 404s (file deleted during the gap)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "not found" }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const backend = makeBackend();
    const events: MarkdownFileChangeEvent[] = [];
    backend.watchMarkdownFile("notes.md", (event) => events.push(event));

    // Baseline "v5" via a live change message.
    FakeWebSocket.latest().emitOpen();
    FakeWebSocket.latest().emitMessage(
      JSON.stringify({
        type: "change",
        path: "notes.md",
        exists: true,
        version: "v5",
      }),
    );
    events.length = 0;

    // Drop, reconnect; the file was deleted while we were gone.
    FakeWebSocket.latest().emitClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.latest().emitOpen();
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { path: "notes.md", exists: false, version: null },
    ]);

    // Watcher keeps running: a subsequent live message is still delivered.
    FakeWebSocket.latest().emitMessage(
      JSON.stringify({
        type: "change",
        path: "notes.md",
        exists: true,
        version: "v6",
      }),
    );
    expect(events).toEqual([
      { path: "notes.md", exists: false, version: null },
      { type: "change", path: "notes.md", exists: true, version: "v6" },
    ]);
  });

  it("logs and keeps the watcher running when the resync fetch fails for a non-404 reason", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const backend = makeBackend();
    const events: MarkdownFileChangeEvent[] = [];
    backend.watchMarkdownFile("notes.md", (event) => events.push(event));

    FakeWebSocket.latest().emitOpen();
    FakeWebSocket.latest().emitMessage(
      JSON.stringify({
        type: "change",
        path: "notes.md",
        exists: true,
        version: "v5",
      }),
    );
    events.length = 0;

    FakeWebSocket.latest().emitClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.latest().emitOpen();
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to resync markdown file after reconnect:",
      expect.any(TypeError),
    );
    expect(events).toEqual([]);

    // Watcher keeps running: a subsequent live message is still delivered.
    FakeWebSocket.latest().emitMessage(
      JSON.stringify({
        type: "change",
        path: "notes.md",
        exists: true,
        version: "v6",
      }),
    );
    expect(events).toEqual([
      { type: "change", path: "notes.md", exists: true, version: "v6" },
    ]);
  });

  it("ignores a stale resync fetch that resolves after a newer live change already reported the same version", async () => {
    vi.useFakeTimers();
    let resolveFetch: ((value: unknown) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const backend = makeBackend();
    const events: MarkdownFileChangeEvent[] = [];
    backend.watchMarkdownFile("notes.md", (event) => events.push(event));

    // Baseline "v5" via a live change message.
    FakeWebSocket.latest().emitOpen();
    FakeWebSocket.latest().emitMessage(
      JSON.stringify({
        type: "change",
        path: "notes.md",
        exists: true,
        version: "v5",
      }),
    );
    events.length = 0;

    // Drop, reconnect; the resync fetch is issued but deliberately left
    // pending so we can inject a live message before it resolves.
    FakeWebSocket.latest().emitClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.latest().emitOpen();
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A live change delivers "v6" before the resync fetch (which was issued
    // against the pre-update baseline "v5") resolves.
    FakeWebSocket.latest().emitMessage(
      JSON.stringify({
        type: "change",
        path: "notes.md",
        exists: true,
        version: "v6",
      }),
    );
    expect(events).toEqual([
      { type: "change", path: "notes.md", exists: true, version: "v6" },
    ]);

    // The resync fetch resolves late, observing the same "v6" the live
    // channel already reported.
    resolveFetch?.({
      ok: true,
      json: async () => ({
        id: "notes.md",
        title: "Notes",
        content: "hi",
        version: "v6",
      }),
    });
    await flushMicrotasks();

    // No duplicate synthetic change for a version already delivered live.
    expect(events).toEqual([
      { type: "change", path: "notes.md", exists: true, version: "v6" },
    ]);
  });

  it("does not fetch or resync on the first open", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: "notes.md",
        title: "Notes",
        content: "hi",
        version: "v1",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const backend = makeBackend();
    const events: MarkdownFileChangeEvent[] = [];
    backend.watchMarkdownFile("notes.md", (event) => events.push(event));

    FakeWebSocket.latest().emitOpen();
    await flushMicrotasks();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
