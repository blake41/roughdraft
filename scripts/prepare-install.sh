#!/usr/bin/env bash
# npm/pnpm run "postinstall" after installing this package as a dependency, including
# when it's added as a git dependency (`bun add -g --trust github:blake41/roughdraft`) —
# the only way to get unreleased fixes before they're published to npm. bun runs
# "postinstall" too, but does NOT run npm's "prepare" hook for dependencies, so this must
# be "postinstall", not "prepare", despite "prepare" being the more common choice for
# this kind of build-on-install script elsewhere.
#
# A git install has no packages/*/dist/ (gitignored, only shipped in npm tarballs via
# package.json "files"), and bin/roughdraft.mjs imports directly from dist/ with no
# fallback — so without this, a git install produces a CLI that fails on its first
# import.
#
# Guard against recursion: this script itself runs `pnpm install`, which is exactly the
# kind of install that re-triggers "postinstall" on the same package.
if [[ -n "${ROUGHDRAFT_PREPARE_RUNNING:-}" ]]; then
  exit 0
fi
export ROUGHDRAFT_PREPARE_RUNNING=1

set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_tooling
cd "$repo_root"

if setup_ready; then
  exit 0
fi

log "Build artifacts missing (git install) — building before first use..."
pnpm install --frozen-lockfile
pnpm build
touch "$setup_stamp"
log "Build complete."
