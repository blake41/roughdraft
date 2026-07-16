/**
 * Small purpose-built reconnecting WebSocket helper (no external dependency).
 *
 * Replaces the browser's native `EventSource` auto-reconnect for the WS
 * endpoints. Behavior parity with the SSE `retry: 1000` directive: after an
 * unexpected close the socket is re-opened ~1s later. Intentional teardown via
 * the returned `close()` never reconnects.
 */

export interface ReconnectingSocketOptions {
  /** Relative path (e.g. "/api/markdown-file/events?path=a.md"). */
  url: string;
  /** Called with the raw string payload of every message. */
  onMessage: (data: string) => void;
  /**
   * Called after every successful open. `reconnect` is `false` for the very
   * first open and `true` for every re-open after an unexpected drop, so
   * consumers can resync only when they actually missed a window.
   */
  onOpen?: (info: { reconnect: boolean }) => void;
  /** Delay before re-opening after an unexpected close. Defaults to 1000ms. */
  reconnectDelayMs?: number;
}

/**
 * Build an absolute `ws://` / `wss://` URL from a relative path, deriving the
 * scheme from the page protocol (`https:` → `wss:`, otherwise `ws:`). The
 * `WebSocket` constructor requires an absolute URL, unlike `fetch`/`EventSource`
 * which accept relative ones.
 */
export function toAbsoluteWebSocketUrl(relativePath: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const path = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  return `${protocol}//${host}${path}`;
}

/**
 * Open a WebSocket that transparently reconnects after unexpected closes.
 * Returns a `close()` that tears the socket down for good (no reconnect).
 */
export function openReconnectingSocket(
  options: ReconnectingSocketOptions,
): () => void {
  const { url, onMessage, onOpen, reconnectDelayMs = 1000 } = options;
  const absoluteUrl = toAbsoluteWebSocketUrl(url);

  let intentionallyClosed = false;
  let hasOpened = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = () => {
    if (intentionallyClosed || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  };

  const connect = () => {
    if (intentionallyClosed) return;

    const ws = new WebSocket(absoluteUrl);
    socket = ws;

    ws.onopen = () => {
      const reconnect = hasOpened;
      hasOpened = true;
      onOpen?.({ reconnect });
    };

    ws.onmessage = (event: MessageEvent) => {
      const { data } = event;
      onMessage(typeof data === "string" ? data : String(data));
    };

    ws.onclose = () => {
      if (intentionallyClosed) return;
      scheduleReconnect();
    };

    // `error` is always followed by `close`, so reconnection is driven from
    // `onclose` alone; this handler only exists to swallow the default logging.
    ws.onerror = () => {};
  };

  connect();

  return () => {
    intentionallyClosed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close();
  };
}
