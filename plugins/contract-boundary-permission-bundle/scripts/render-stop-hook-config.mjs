#!/usr/bin/env node

const TOOL_DIR = ".codex/tools/contract-boundary-permissions";
const HOOK_SCRIPT = `${TOOL_DIR}/hooks/stop-checks.mjs`;

const config = {
  hooks: {
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: [
              `node "$(git rev-parse --show-toplevel)/${HOOK_SCRIPT}"`,
              `--workspace "$(git rev-parse --show-toplevel)"`,
              `--tool-root "$(git rev-parse --show-toplevel)/${TOOL_DIR}"`,
            ].join(" "),
            commandWindows: [
              "powershell -NoProfile -ExecutionPolicy Bypass -Command",
              `"${[
                "$root = git rev-parse --show-toplevel",
                `node (Join-Path $root '${HOOK_SCRIPT}') --workspace $root --tool-root (Join-Path $root '${TOOL_DIR}')`,
              ].join("; ")}"`,
            ].join(" "),
            timeout: 120,
            statusMessage: "Checking contract-boundary permissions",
          },
        ],
      },
    ],
  },
};

process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
