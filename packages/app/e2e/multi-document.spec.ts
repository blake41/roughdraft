import fs from "node:fs";
import { expect, test } from "@playwright/test";
import {
  codeEditor,
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

// Regression test for the original bug this migration exists to fix: Chrome
// caps concurrent HTTP/1.1 connections at 6 per host:port, shared across ALL
// tabs on that origin. Each tab held 2 permanent SSE connections (file-watch
// + open-requests), so the pool saturated at 3 open documents -- the 4th
// tab's connections (and everything else queued behind the same host:port)
// would starve. WebSocket connections do not count against that pool.
//
// This must open every document in ONE browser context (one origin, one
// connection pool) to actually exercise the limit -- separate contexts would
// each get their own pool and never reproduce the bug.
const DOCUMENT_COUNT = 7;

test.describe("multiple documents open simultaneously", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("multi-document");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("7 tabs in one browser context all load their content and receive their own file-change event", async ({
    page,
    context,
  }) => {
    const filePaths = Array.from({ length: DOCUMENT_COUNT }, (_, index) =>
      writeProjectFile(
        projectDir,
        `doc-${index}.md`,
        `# Document ${index}\n\nOriginal body ${index}.\n`,
      ),
    );

    // Reuse the fixture's `page` as tab 0 and open 6 more via
    // `context.newPage()` so all 7 tabs share the same browser context (same
    // origin, same HTTP/1.1 connection pool).
    const extraPages = await Promise.all(
      Array.from({ length: DOCUMENT_COUNT - 1 }, () => context.newPage()),
    );
    const pages = [page, ...extraPages];

    await Promise.all(
      pages.map((tabPage, index) =>
        openMarkdownFile(tabPage, filePaths[index], "code"),
      ),
    );

    // R1: every tab loads its own content. Under SSE this is where the bug
    // manifests -- tabs past the connection-pool ceiling never finish
    // loading (or queue behind other tabs' requests) because the browser is
    // still holding 6 slots open for earlier tabs' EventSource streams.
    await Promise.all(
      pages.map((tabPage, index) =>
        expect(codeEditor(tabPage)).toContainText(`Original body ${index}.`),
      ),
    );

    // R2: each tab's live file-watch stream still delivers ITS OWN file's
    // change, scoped correctly, with no cross-wiring and no starvation.
    // None of these documents are dirty in the editor, so the app's watcher
    // auto-reloads on a live change event (App.tsx) -- the editor picking up
    // the external content, with no manual reload, is the observable proof
    // that this tab's own WS connection is open and delivering.
    for (const [index, filePath] of filePaths.entries()) {
      fs.writeFileSync(
        filePath,
        `# Document ${index}\n\nExternal body ${index}.\n`,
      );
    }

    await Promise.all(
      pages.map((tabPage, index) =>
        expect(codeEditor(tabPage)).toContainText(`External body ${index}.`),
      ),
    );

    logE2eEvent("multi-document.all-tabs-loaded-and-updated", {
      documentCount: DOCUMENT_COUNT,
    });
  });
});
