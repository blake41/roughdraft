import fs from "node:fs";
import { expect, test } from "@playwright/test";
import {
  createMarkdownProject,
  fileConflictNotice,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

/**
 * The file watcher polls with `fs.watchFile({ interval: 500 })`, so an
 * external write needs a little over that to reach the app, plus the
 * round-trip of the refetch it triggers. There is no user-visible signal for
 * "App absorbed the external refresh" (the editor deliberately keeps showing
 * the user's draft), so these tests wait rather than poll on the DOM.
 */
const WATCH_SETTLE_MS = 1_500;

const commentEditor = (page: import("@playwright/test").Page) =>
  page.getByTestId(/^comment-rail-c[0-9a-z]+-editor$/);

const commentSaveButton = (page: import("@playwright/test").Page) =>
  page.getByTestId(/^comment-rail-c[0-9a-z]+-action-save$/);

function commentIdsInFile(markdown: string): string[] {
  return [...markdown.matchAll(/\{id="(c[0-9a-z]+)"/g)]
    .map((match) => match[1] as string)
    .concat(
      [...markdown.matchAll(/^ {2}(c[0-9a-z]+):$/gm)].map(
        (match) => match[1] as string,
      ),
    );
}

test.describe("comment saves racing an external file write", () => {
  let projectDir: string;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("comment-external-write");
  });

  test.afterEach(() => {
    removeMarkdownProject(projectDir);
  });

  test("does not silently clobber an agent's edit made while a comment draft is open", async ({
    page,
  }) => {
    // NOTE: the watcher is deliberately NOT blocked here. This test needs the
    // live file-watch path, because the bug it pins is precisely that App
    // advances its known document version on the watcher event while the
    // editor defers accepting the new content.
    const filePath = writeProjectFile(
      projectDir,
      "race.md",
      [
        "# Race",
        "",
        "First paragraph has review target text.",
        "",
        "Second paragraph is owned by the agent.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("review target text");

    // The user opens a comment on the FIRST paragraph and types a draft, but
    // does not save it yet.
    await selectRichText(page, "review target text");
    await page.getByTestId("selection-menu-action-comment").click();
    await commentEditor(page).fill("Please cite this claim.");

    // The agent rewrites the SECOND paragraph on disk — a region the user has
    // not touched.
    fs.writeFileSync(
      filePath,
      [
        "# Race",
        "",
        "First paragraph has review target text.",
        "",
        "Second paragraph was rewritten by the agent.",
        "",
      ].join("\n"),
    );
    await page.waitForTimeout(WATCH_SETTLE_MS);

    // The user commits the comment. Before the fix this sent the STALE editor
    // markdown under the FRESH disk version, so the optimistic-concurrency
    // check passed and the agent's paragraph was silently overwritten.
    await commentSaveButton(page).click();

    // OBSERVED POST-FIX OUTCOME: a 409 with a visible conflict banner.
    //
    // Layer 1 pins the save to the version the editor content actually
    // reflects, and the agent's write bumped the file version even though it
    // touched an unrelated paragraph. So the server correctly rejects the
    // save. This is the acceptable outcome documented in the fix spec: 409
    // plus a visible conflict beats 200 plus silent data loss. Resolving the
    // disjoint-region case into a successful merge would need the server-side
    // 3-way merge (layer 2), which is deliberately out of scope here.
    await expect(fileConflictNotice(page)).toBeVisible();

    // Autosave is debounced 500ms. Without this settle the disk assertions
    // below can race AHEAD of the save and pass spuriously by reading the
    // file before it is written — that is how an earlier draft of this test
    // passed against the pre-fix code that actually did clobber the file.
    await page.waitForTimeout(2_000);

    // The load-bearing assertion: the agent's edit survived.
    await expect
      .poll(() => readProjectFile(projectDir, "race.md"))
      .toContain("Second paragraph was rewritten by the agent.");
    expect(readProjectFile(projectDir, "race.md")).not.toContain(
      "Second paragraph is owned by the agent.",
    );
    expect(readProjectFile(projectDir, "race.md")).not.toContain(
      "Please cite this claim.",
    );

    // OBSERVED, not asserted: the comment rail editor is torn down when the
    // conflict banner appears, so the typed draft is not retained through the
    // conflict. That is a pre-existing rough edge in the conflict UI rather
    // than something this fix introduces or is meant to address, so it is
    // recorded here instead of being pinned as intended behavior.

    logE2eEvent("comment-external-write.agent-edit-preserved", {
      file: "race.md",
      outcome: "409-conflict",
    });
  });

  test("allocates distinct comment ids for two writers working from the same snapshot", async ({
    page,
  }) => {
    // This is the layer-3 pin. Both allocations below start from the IDENTICAL
    // on-disk snapshot (one existing comment, `c1`), which is exactly the
    // situation two concurrent writers are in. The old "current max + 1"
    // allocator is a pure function of that snapshot, so both writers produced
    // `c2` and one comment overwrote the other. Random ids cannot collide.
    const original = [
      "# Ids",
      "",
      'Existing {==anchor==}{>>Prior note<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"} here.',
      "",
      "Fresh review target text lives here.",
      "",
    ].join("\n");

    const filePath = writeProjectFile(projectDir, "ids.md", original);

    const addCommentAndReadId = async (body: string) => {
      await openMarkdownFile(page, filePath);
      await expect(richTextEditor(page)).toContainText("Fresh review target");

      await selectRichText(page, "Fresh review target text");
      await page.getByTestId("selection-menu-action-comment").click();
      await commentEditor(page).fill(body);
      await commentSaveButton(page).click();

      await expect
        .poll(() => readProjectFile(projectDir, "ids.md"))
        .toContain(body);

      const saved = readProjectFile(projectDir, "ids.md");
      const ids = commentIdsInFile(saved);
      const allocated = ids.filter((id) => id !== "c1");
      expect(allocated).toHaveLength(1);
      return allocated[0] as string;
    };

    const firstWriterId = await addCommentAndReadId("First writer note.");

    // Reset the file to the exact starting snapshot, so the second allocation
    // sees precisely what the first one saw.
    fs.writeFileSync(filePath, original);
    await page.waitForTimeout(WATCH_SETTLE_MS);

    const secondWriterId = await addCommentAndReadId("Second writer note.");

    expect(firstWriterId).not.toBe(secondWriterId);
    expect(firstWriterId).toMatch(/^c[0-9a-z]+$/);
    expect(secondWriterId).toMatch(/^c[0-9a-z]+$/);
    // Neither may reuse the id already present in the snapshot.
    expect([firstWriterId, secondWriterId]).not.toContain("c1");

    logE2eEvent("comment-external-write.distinct-ids", {
      file: "ids.md",
      firstWriterId,
      secondWriterId,
    });
  });

  test("keeps an agent-authored comment and a user comment as distinct entries", async ({
    page,
  }) => {
    // The agent's write adds its OWN newly allocated comment while the user is
    // composing one. After the user reloads from disk (the conflict the first
    // test documents), both comments must coexist with distinct ids — under
    // the old allocator the user's comment reused the agent's id.
    const filePath = writeProjectFile(
      projectDir,
      "both.md",
      [
        "# Both",
        "",
        'Existing {==anchor==}{>>Prior note<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"} here.',
        "",
        "User review target text lives here.",
        "",
      ].join("\n"),
    );

    await openMarkdownFile(page, filePath);
    await expect(richTextEditor(page)).toContainText("User review target");

    await selectRichText(page, "User review target text");
    await page.getByTestId("selection-menu-action-comment").click();
    await commentEditor(page).fill("User comment on paragraph one.");

    // The agent appends its own comment, using the id the OLD max+1 allocator
    // would have handed the browser. If the browser still allocated that way,
    // the user's comment below would reuse "c2" and collide.
    fs.writeFileSync(
      filePath,
      [
        "# Both",
        "",
        'Existing {==anchor==}{>>Prior note<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"} here.',
        "",
        'User review target text {==lives==}{>>Agent note<<}{id="c2" by="AI" at="2026-04-23T18:05:00.000Z"} here.',
        "",
      ].join("\n"),
    );
    await page.waitForTimeout(WATCH_SETTLE_MS);

    await commentSaveButton(page).click();
    await expect(fileConflictNotice(page)).toBeVisible();

    // Take the agent's version, then re-apply the user's comment on top.
    await page.getByTestId("file-conflict-action-reload").click();
    await expect(fileConflictNotice(page)).toBeHidden();
    // Comment bodies render in the review rail, not in the document body.
    await expect(page.getByTestId("document-review-rail")).toContainText(
      "Agent note",
    );

    await selectRichText(page, "User review target text");
    await page.getByTestId("selection-menu-action-comment").click();
    await commentEditor(page).fill("User comment after reload.");
    await commentSaveButton(page).click();

    await expect
      .poll(() => readProjectFile(projectDir, "both.md"))
      .toContain("User comment after reload.");

    const saved = readProjectFile(projectDir, "both.md");
    expect(saved).toContain("Agent note");
    expect(saved).toContain("Prior note");

    const ids = commentIdsInFile(saved);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("c1");
    expect(ids).toContain("c2");

    const userCommentId = ids.find((id) => id !== "c1" && id !== "c2");
    expect(userCommentId).toMatch(/^c[0-9a-z]+$/);

    logE2eEvent("comment-external-write.distinct-agent-and-user-ids", {
      file: "both.md",
      ids,
    });
  });
});
