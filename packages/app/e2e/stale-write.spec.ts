import fs from "node:fs";
import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  blockMarkdownFileWatchSocket,
  codeEditor,
  createMarkdownProject,
  documentSaveStatus,
  fileConflictNotice,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("stale writes", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("stale-write");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("surfaces a save conflict when the file changed externally @smoke", async ({
    page,
  }) => {
    await blockMarkdownFileWatchSocket(page);

    const filePath = writeProjectFile(
      projectDir,
      "conflict.md",
      "# Conflict\n\nOriginal body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original body.");

    fs.writeFileSync(filePath, "# Conflict\n\nExternal body.\n");
    await appendInCodeEditor(page, "\nLocal body.\n");

    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Save conflict",
    );
    await expect(page.getByTestId("file-conflict-action-reload")).toBeVisible();
    await expect(
      page.getByTestId("file-conflict-action-keep-editing"),
    ).toBeVisible();
    expect(readProjectFile(projectDir, "conflict.md")).toBe(
      "# Conflict\n\nExternal body.\n",
    );

    await page.getByTestId("file-conflict-action-keep-editing").click();
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Autosave paused",
    );
    await appendInCodeEditor(page, "\nStill local.\n");
    await expect(codeEditor(page)).toContainText("Local body.");
    await expect(codeEditor(page)).toContainText("Still local.");
    await expect
      .poll(() => readProjectFile(projectDir, "conflict.md"))
      .toBe("# Conflict\n\nExternal body.\n");

    logE2eEvent("stale-write.conflict-surfaced", {
      file: "conflict.md",
    });
  });

  test("overwrite after conflict marks the current draft saved", async ({
    page,
  }) => {
    await blockMarkdownFileWatchSocket(page);

    const filePath = writeProjectFile(
      projectDir,
      "overwrite-conflict.md",
      "# Conflict\n\nOriginal body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original body.");

    fs.writeFileSync(filePath, "# Conflict\n\nExternal body.\n");
    await appendInCodeEditor(page, "\nLocal overwrite body.\n");

    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Save conflict",
    );
    await page.getByTestId("file-conflict-action-overwrite").click();

    await expect
      .poll(() => readProjectFile(projectDir, "overwrite-conflict.md"))
      .toContain("Local overwrite body.");
    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    await expect(documentSaveStatus(page)).not.toHaveAttribute(
      "aria-label",
      "Save failed",
    );
    await expect(documentSaveStatus(page)).not.toHaveAttribute(
      "aria-label",
      "Unsaved changes",
    );

    logE2eEvent("stale-write.overwrite-saved", {
      file: "overwrite-conflict.md",
      size: fs.statSync(filePath).size,
    });
  });

  test("manual save preserves expected-version conflict behavior", async ({
    page,
  }) => {
    await blockMarkdownFileWatchSocket(page);

    const filePath = writeProjectFile(
      projectDir,
      "manual-conflict.md",
      "# Manual Conflict\n\nOriginal body.\n",
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original body.");

    fs.writeFileSync(filePath, "# Manual Conflict\n\nExternal body.\n");
    await appendInCodeEditor(page, "\nLocal body.\n");
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+S" : "Control+S",
    );

    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Save conflict",
    );
    await expect(fileConflictNotice(page)).toContainText(
      "This file changed on disk while you have unsaved edits.",
    );
    expect(readProjectFile(projectDir, "manual-conflict.md")).toBe(
      "# Manual Conflict\n\nExternal body.\n",
    );

    logE2eEvent("stale-write.manual-conflict", {
      file: "manual-conflict.md",
    });
  });

  test("rejects autosave after external content changes with stable metadata", async ({
    page,
  }) => {
    const fixedTimestamp = new Date("2026-01-01T00:00:00.000Z");
    const filePath = writeProjectFile(
      projectDir,
      "metadata-conflict.md",
      "# Original\n",
    );
    fs.utimesSync(filePath, fixedTimestamp, fixedTimestamp);

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Original");

    fs.writeFileSync(filePath, "# External\n");
    fs.utimesSync(filePath, fixedTimestamp, fixedTimestamp);
    await appendInCodeEditor(page, "\nLocal body.\n");

    await expect(documentSaveStatus(page)).toHaveAttribute(
      "aria-label",
      "Save conflict",
    );
    expect(readProjectFile(projectDir, "metadata-conflict.md")).toBe(
      "# External\n",
    );

    logE2eEvent("stale-write.metadata-conflict-surfaced", {
      file: "metadata-conflict.md",
    });
  });

  test("keeps explanatory conflict choices visible while scrolled in a long document", async ({
    page,
  }) => {
    await blockMarkdownFileWatchSocket(page);

    const longBody = Array.from(
      { length: 120 },
      (_, index) => `Paragraph ${index + 1}: local review text.`,
    ).join("\n\n");
    const filePath = writeProjectFile(
      projectDir,
      "long-conflict.md",
      `# Long conflict\n\n${longBody}\n`,
    );

    await openMarkdownFile(page, filePath, "code");
    await expect(codeEditor(page)).toContainText("Paragraph 1");

    await codeEditor(page).click();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+End" : "Control+End",
    );
    fs.writeFileSync(
      filePath,
      "# Long conflict\n\nExternal body from another editor.\n",
    );
    await page.keyboard.type("\nLocal draft at the bottom.\n");

    const conflictNotice = fileConflictNotice(page);
    await expect(conflictNotice).toBeVisible();
    await expect(conflictNotice).toHaveCSS("position", "fixed");
    await expect(conflictNotice).toContainText(
      "This file changed on disk while you have unsaved edits.",
    );
    await expect(conflictNotice).toContainText(
      "Autosave is paused so your draft will not overwrite those changes.",
    );
    await expect(page.getByTestId("file-conflict-action-reload")).toBeVisible();
    await expect(
      page.getByTestId("file-conflict-action-keep-editing"),
    ).toBeVisible();
    await expect(
      page.getByTestId("file-conflict-action-overwrite"),
    ).toBeVisible();
  });

  test("keeps conflict banner and save status stack from overlapping", async ({
    page,
  }) => {
    await blockMarkdownFileWatchSocket(page);

    const filePath = writeProjectFile(
      projectDir,
      "layout-conflict.md",
      "# Layout conflict\n\nOriginal body.\n",
    );

    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
    ]) {
      fs.writeFileSync(filePath, "# Layout conflict\n\nOriginal body.\n");
      await page.setViewportSize(viewport);
      await openMarkdownFile(page, filePath, "code");
      await expect(codeEditor(page)).toContainText("Original body.");

      fs.writeFileSync(filePath, "# Layout conflict\n\nExternal body.\n");
      await appendInCodeEditor(page, `\nLocal body ${viewport.width}.\n`);

      const conflictNotice = fileConflictNotice(page);
      const statusStack = page.getByTestId("document-status-stack");
      await expect(conflictNotice).toBeVisible();
      await expect(statusStack).toBeVisible();

      const conflictBox = await conflictNotice.boundingBox();
      const stackBox = await statusStack.boundingBox();
      expect(conflictBox).not.toBeNull();
      expect(stackBox).not.toBeNull();

      if (!conflictBox || !stackBox) {
        throw new Error("Expected conflict and status stack bounds");
      }

      const intersects =
        conflictBox.x < stackBox.x + stackBox.width &&
        conflictBox.x + conflictBox.width > stackBox.x &&
        conflictBox.y < stackBox.y + stackBox.height &&
        conflictBox.y + conflictBox.height > stackBox.y;

      expect(intersects).toBe(false);
      await page.getByTestId("file-conflict-action-reload").click();
      await expect(conflictNotice).toBeHidden();
    }
  });
});
