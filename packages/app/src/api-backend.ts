import { openReconnectingSocket } from "./reconnecting-socket";
import {
  type BackendInfo,
  type CompleteReviewOptions,
  type CompleteReviewResult,
  type MarkdownFileChangeEvent,
  MarkdownFileConflictError,
  type Page,
  type ReviewWatchStatus,
  type StorageBackend,
  type StoredAsset,
} from "./storage";

export class ApiBackend implements StorageBackend {
  info: BackendInfo;
  canManageProjects = true;

  constructor(info: BackendInfo) {
    this.info = info;
  }

  private updateProjectInfo(projectPath?: string): void {
    this.info = {
      ...this.info,
      detail: projectPath || "Markdown file on disk",
      projectPath,
    };
  }

  private buildUrl(route: string, params?: Record<string, string>): string {
    const url = new URL(route, window.location.origin);
    const projectPath = this.info.projectPath?.trim();

    if (projectPath) {
      url.searchParams.set("projectPath", projectPath);
    }

    Object.entries(params ?? {}).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    return `${url.pathname}${url.search}`;
  }

  async getMarkdownFile(relativePath: string): Promise<Page> {
    const res = await fetch(
      this.buildUrl("/api/markdown-file", {
        path: relativePath,
      }),
    );
    if (!res.ok) {
      throw new Error(
        `Failed to get markdown file ${relativePath}: ${res.status}`,
      );
    }
    return res.json();
  }

  async saveMarkdownFile(
    relativePath: string,
    content: string,
    expectedVersion?: string,
  ): Promise<Page> {
    const res = await fetch(
      this.buildUrl("/api/markdown-file", { path: relativePath }),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          expectedVersion,
          projectPath: this.info.projectPath,
        }),
      },
    );
    if (res.status === 409) {
      const payload = (await res.json()) as { current?: Page };
      if (payload.current) {
        throw new MarkdownFileConflictError(payload.current);
      }
    }
    if (!res.ok) {
      throw new Error(
        `Failed to save markdown file ${relativePath}: ${res.status}`,
      );
    }
    return res.json();
  }

  watchMarkdownFile(
    relativePath: string,
    onChange: (event: MarkdownFileChangeEvent) => void,
  ): () => void {
    // Version last delivered to the consumer. `undefined` means we have not yet
    // observed any version over this watcher; a real version can be `string`
    // (file present) or `null` (file absent).
    let lastVersion: string | null | undefined;

    return openReconnectingSocket({
      url: this.buildUrl("/api/markdown-file/events", { path: relativePath }),
      onMessage: (data) => {
        try {
          const event = JSON.parse(data) as MarkdownFileChangeEvent;
          lastVersion = event.version;
          onChange(event);
        } catch (error) {
          // Mirror the SSE handler: log and keep the watcher running.
          console.error("Failed to read markdown file change event:", error);
        }
      },
      onOpen: ({ reconnect }) => {
        // Decision 6: resync only AFTER a reconnect (never on the first open).
        // Changes that landed while the socket was down would otherwise be
        // missed, so refetch the current state and synthesize a change if it
        // moved. Perform the fetch directly (rather than via
        // `getMarkdownFile`) so a 404 can be distinguished from other
        // failures: a 404 means the file was deleted during the gap and must
        // be surfaced as `exists: false`, whereas other failures (network
        // errors, 5xx) are transient and should just be logged.
        if (!reconnect) return;
        const baseline = lastVersion;
        void (async () => {
          try {
            const res = await fetch(
              this.buildUrl("/api/markdown-file", { path: relativePath }),
            );
            let exists: boolean;
            let version: string | null;
            if (res.status === 404) {
              exists = false;
              version = null;
            } else if (!res.ok) {
              throw new Error(
                `Failed to get markdown file ${relativePath}: ${res.status}`,
              );
            } else {
              const page = (await res.json()) as Page;
              exists = true;
              version = page.version ?? null;
            }

            // A live `change` message may have updated `lastVersion` while
            // this fetch was in flight. That message is authoritative and
            // strictly newer than whatever this resync observed, so if
            // `lastVersion` has moved on from `baseline`, discard this
            // (possibly stale, out-of-order) result instead of clobbering it.
            if (lastVersion !== baseline) return;

            if (version !== lastVersion) {
              lastVersion = version;
              onChange({ path: relativePath, exists, version });
            }
          } catch (error) {
            console.error(
              "Failed to resync markdown file after reconnect:",
              error,
            );
          }
        })();
      },
    });
  }

  async completeReview(
    relativePath: string,
    options: CompleteReviewOptions = {},
  ): Promise<CompleteReviewResult> {
    const overallComment = options.overallComment?.trim();
    const res = await fetch(
      this.buildUrl("/api/review-events", { path: relativePath }),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: this.info.projectPath,
          path: relativePath,
          ...(overallComment ? { overallComment } : {}),
        }),
      },
    );

    if (!res.ok) {
      throw new Error(
        `Failed to complete review ${relativePath}: ${res.status}`,
      );
    }

    const payload = (await res.json()) as { delivered?: unknown };
    return { delivered: payload.delivered === true };
  }

  async getReviewWatchStatus(relativePath: string): Promise<ReviewWatchStatus> {
    const res = await fetch(
      this.buildUrl("/api/review-events/status", { path: relativePath }),
    );

    if (!res.ok) {
      throw new Error(
        `Failed to get review watch status ${relativePath}: ${res.status}`,
      );
    }

    const payload = (await res.json()) as {
      watching?: unknown;
      watcherCount?: unknown;
    };
    return {
      watching: payload.watching === true,
      watcherCount:
        typeof payload.watcherCount === "number" ? payload.watcherCount : 0,
    };
  }

  async saveAsset(file: File): Promise<StoredAsset> {
    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (byte === undefined) continue;
      binary += String.fromCharCode(byte);
    }

    const res = await fetch(this.buildUrl("/api/assets"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64: btoa(binary),
        projectPath: this.info.projectPath,
      }),
    });

    if (!res.ok) throw new Error(`Failed to save asset: ${res.status}`);
    return res.json();
  }

  resolveFileUrl(path: string): string | null {
    const normalized = path.replace(/^\.?\//, "");
    return this.buildUrl("/api/files", { path: normalized });
  }

  async openProject(path: string): Promise<void> {
    this.updateProjectInfo(path);
  }
}
