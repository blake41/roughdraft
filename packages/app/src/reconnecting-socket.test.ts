import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  openReconnectingSocket,
  toAbsoluteWebSocketUrl,
} from "./reconnecting-socket";

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

  // --- test drivers (simulate the browser firing events) ---
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

  // --- API the utility calls ---
  close() {
    this.closeCalls += 1;
    // The real WebSocket fires a close event after close() is invoked.
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("toAbsoluteWebSocketUrl", () => {
  it("maps http origins to a ws:// absolute URL preserving path and query", () => {
    const host = window.location.host; // jsdom default host (e.g. localhost:3000)
    const result = toAbsoluteWebSocketUrl(
      "/api/markdown-file/events?path=a.md",
    );
    expect(result).toBe(`ws://${host}/api/markdown-file/events?path=a.md`);
  });

  it("maps https origins to wss://", () => {
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      value: { protocol: "https:", host: "docs.example.com" },
      configurable: true,
    });
    try {
      expect(toAbsoluteWebSocketUrl("/api/x?path=b.md")).toBe(
        "wss://docs.example.com/api/x?path=b.md",
      );
    } finally {
      Object.defineProperty(window, "location", {
        value: originalLocation,
        configurable: true,
      });
    }
  });

  it("normalizes a path that lacks a leading slash", () => {
    const host = window.location.host;
    expect(toAbsoluteWebSocketUrl("api/x")).toBe(`ws://${host}/api/x`);
  });
});

describe("openReconnectingSocket", () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("delivers each message payload to onMessage", () => {
    const received: string[] = [];
    openReconnectingSocket({
      url: "/api/markdown-file/events?path=a.md",
      onMessage: (data) => received.push(data),
    });

    const socket = FakeWebSocket.latest();
    socket.emitOpen();
    socket.emitMessage('{"type":"change","path":"a.md"}');
    socket.emitMessage('{"type":"change","path":"a.md","version":"v2"}');

    expect(received).toEqual([
      '{"type":"change","path":"a.md"}',
      '{"type":"change","path":"a.md","version":"v2"}',
    ]);
  });

  it("builds an absolute ws:// URL from the relative path", () => {
    openReconnectingSocket({
      url: "/api/markdown-file/events?path=a.md",
      onMessage: () => {},
    });
    expect(FakeWebSocket.latest().url).toBe(
      `ws://${window.location.host}/api/markdown-file/events?path=a.md`,
    );
  });

  it("calls onOpen with reconnect=false on the first open and reconnect=true afterwards", () => {
    vi.useFakeTimers();
    const opens: boolean[] = [];
    openReconnectingSocket({
      url: "/api/x",
      onMessage: () => {},
      onOpen: ({ reconnect }) => opens.push(reconnect),
    });

    FakeWebSocket.latest().emitOpen();
    FakeWebSocket.latest().emitClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.latest().emitOpen();

    expect(opens).toEqual([false, true]);
  });

  it("reconnects roughly 1s after an unexpected close", () => {
    vi.useFakeTimers();
    openReconnectingSocket({ url: "/api/x", onMessage: () => {} });

    const first = FakeWebSocket.latest();
    first.emitOpen();
    first.emitClose();

    // No new socket before the retry delay elapses.
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // A fresh socket is created once the ~1s retry fires.
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("does not reconnect after an intentional close()", () => {
    vi.useFakeTimers();
    const close = openReconnectingSocket({
      url: "/api/x",
      onMessage: () => {},
    });

    FakeWebSocket.latest().emitOpen();
    close();

    expect(FakeWebSocket.latest().closeCalls).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("does not reconnect if close() is called during the retry backoff window", () => {
    vi.useFakeTimers();
    const close = openReconnectingSocket({
      url: "/api/x",
      onMessage: () => {},
    });

    const first = FakeWebSocket.latest();
    first.emitOpen();
    first.emitClose(); // schedules a reconnect timer
    close(); // must cancel it

    vi.advanceTimersByTime(5000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
