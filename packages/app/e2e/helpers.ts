import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export function createMarkdownProject(label: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `roughdraft-${label}-`));
}

export function removeMarkdownProject(projectDir: string) {
  fs.rmSync(projectDir, { recursive: true, force: true });
}

export function writeProjectFile(
  projectDir: string,
  relativePath: string,
  content: string | Buffer,
) {
  const absolutePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
  return absolutePath;
}

export function readProjectFile(projectDir: string, relativePath: string) {
  return fs.readFileSync(path.join(projectDir, relativePath), "utf8");
}

export async function openMarkdownFile(
  page: Page,
  absolutePath: string,
  editor?: "rich-text" | "code",
) {
  const params = new URLSearchParams({ path: absolutePath });
  if (editor) params.set("editor", editor);

  await page.goto(`/?${params.toString()}`);
}

export function codeEditor(page: Page) {
  return page.getByTestId("markdown-code-editor").locator(".cm-content");
}

export function richTextEditor(page: Page) {
  return page.getByTestId("rich-text-editor").locator(".ProseMirror");
}

export function documentSaveStatus(page: Page) {
  return page.getByTestId("document-save-status");
}

export function fileConflictNotice(page: Page) {
  return page.getByTestId("file-conflict-notice");
}

/**
 * Simulate a broken markdown-file watcher over the WebSocket transport.
 *
 * The pre-migration version of these tests used
 * `page.route("**\/api/markdown-file/events**", (route) => route.abort())`
 * against the SSE `EventSource`, which never delivered a working connection
 * to the app. `page.route()` cannot intercept a WebSocket upgrade, so the
 * WS equivalent is `page.routeWebSocket()`.
 *
 * The naive swap — closing the mocked socket immediately — is NOT
 * equivalent: `openReconnectingSocket` treats a close as "unexpected" and
 * reconnects ~1s later, and the *second* connection's `onOpen({reconnect:
 * true})` triggers the resync-on-reconnect fetch (Decision 6), which would
 * synthesize a `change` event as soon as it observed the external write —
 * exactly the live-notification path these tests need suppressed so the
 * conflict is only ever discovered through the save-time version check.
 *
 * Instead, this accepts the mocked connection (Playwright auto-opens it
 * because the handler never calls `connectToServer()`) and never sends a
 * message and never closes it. The app's watcher socket sits open but
 * silent for the lifetime of the test: no `change` message, no unexpected
 * close, no reconnect, no resync race. That is the faithful WS analogue of
 * the SSE abort's actual effect on the app: the live watch stream never
 * tells the app about the external file change.
 */
export async function blockMarkdownFileWatchSocket(page: Page) {
  await page.routeWebSocket("**/api/markdown-file/events**", () => {
    // Intentionally empty: mock the connection, deliver nothing.
  });
}

export async function appendInCodeEditor(page: Page, text: string) {
  const editor = codeEditor(page);
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+End" : "Control+End",
  );
  await page.keyboard.type(text);
}

export async function selectRichText(page: Page, text: string) {
  await richTextEditor(page).focus();
  await page.evaluate((targetText) => {
    const editor = document.querySelector(".ProseMirror");
    if (!editor) {
      throw new Error("Could not find rich-text editor");
    }

    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
      const index = node.textContent?.indexOf(targetText) ?? -1;

      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + targetText.length);

        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);

        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        return;
      }

      node = walker.nextNode();
    }

    throw new Error(`Could not find text "${targetText}"`);
  }, text);
}

export function logE2eEvent(event: string, data: Record<string, unknown> = {}) {
  const file = process.env.THOUGHTFUL_SLOG_FILE;
  if (!file) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      runId: process.env.THOUGHTFUL_SLOG_RUN_ID ?? "manual",
      source: "packages/app/e2e",
      event,
      data,
    })}\n`,
  );
}
