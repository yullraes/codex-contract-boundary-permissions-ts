#!/usr/bin/env node

const TOOL_DIR = ".codex/tools/contract-boundary-permissions";
const HOOK_SCRIPT = `${TOOL_DIR}/hooks/pre-commit.mjs`;

const hook = `#!/bin/sh
set -eu

root="$(git rev-parse --show-toplevel)"
node "$root/${HOOK_SCRIPT}" --workspace "$root" --tool-root "$root/${TOOL_DIR}"
`;

process.stdout.write(hook);
