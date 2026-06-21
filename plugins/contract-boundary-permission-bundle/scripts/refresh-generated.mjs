#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_OUTPUTS = {
  boundaries: ".codex/boundaries.json",
  graph: ".codex/dependency-graph.json",
  rules: ".codex/rules/generated.rules",
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(args.workspace ?? process.cwd());
  const outputs = resolveOutputs(workspace);

  if (args.mode === "write") {
    await writeGeneratedOutputs(workspace, outputs);
    process.stdout.write(`Generated outputs refreshed:\n`);
    for (const outputPath of Object.values(outputs)) {
      process.stdout.write(`- ${toDisplayPath(workspace, outputPath)}\n`);
    }
    return;
  }

  const result = await checkGeneratedOutputs(workspace, outputs);
  if (result.stale.length === 0) {
    process.stdout.write("Generated outputs are fresh.\n");
    return;
  }

  process.stderr.write("Generated outputs are stale:\n");
  for (const item of result.stale) {
    process.stderr.write(`- ${item.reason}: ${toDisplayPath(workspace, item.path)}\n`);
  }
  process.stderr.write(`Run: npm run refresh:generated -- ${toDisplayPath(process.cwd(), workspace)} --write\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const args = {
    mode: null,
    workspace: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--check") {
      setMode(args, "check");
      continue;
    }

    if (arg === "--write") {
      setMode(args, "write");
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (args.workspace) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    args.workspace = arg;
  }

  if (!args.mode) {
    throw new Error("Choose exactly one mode: --check or --write.");
  }

  return args;
}

function setMode(args, mode) {
  if (args.mode && args.mode !== mode) {
    throw new Error("Choose exactly one mode: --check or --write.");
  }
  args.mode = mode;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/refresh-generated.mjs [workspace] (--check | --write)

Regenerates the project-local Codex automation outputs.

Modes:
  --check   Regenerate into a temporary directory and compare with .codex outputs.
  --write   Refresh .codex/boundaries.json, .codex/dependency-graph.json, and .codex/rules/generated.rules.

The script intentionally rebuilds the full JS/TS dependency graph in v1.
It never edits active .codex/config.toml.
`);
}

function resolveOutputs(workspace) {
  return {
    boundaries: path.join(workspace, DEFAULT_OUTPUTS.boundaries),
    graph: path.join(workspace, DEFAULT_OUTPUTS.graph),
    rules: path.join(workspace, DEFAULT_OUTPUTS.rules),
  };
}

async function writeGeneratedOutputs(workspace, outputs) {
  await runNode("scripts/scan-boundaries.mjs", [workspace, "--out", outputs.boundaries]);
  await runNode("src/analyze-js-ts-imports.ts", [workspace, "--out", outputs.graph]);
  await runNode("src/generate-codex-rules.ts", [
    workspace,
    "--graph",
    outputs.graph,
    "--out",
    outputs.rules,
    "--force",
  ]);
}

async function checkGeneratedOutputs(workspace, outputs) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "contract-boundary-refresh-"));
  const tempOutputs = {
    boundaries: path.join(tempRoot, "boundaries.json"),
    graph: path.join(tempRoot, "dependency-graph.json"),
    rules: path.join(tempRoot, "generated.rules"),
  };

  try {
    await runNode("scripts/scan-boundaries.mjs", [workspace, "--out", tempOutputs.boundaries]);
    await runNode("src/analyze-js-ts-imports.ts", [workspace, "--out", tempOutputs.graph]);
    await runNode("src/generate-codex-rules.ts", [
      workspace,
      "--graph",
      tempOutputs.graph,
      "--out",
      tempOutputs.rules,
    ]);

    const stale = [
      ...await compareJsonOutput("boundaries", outputs.boundaries, tempOutputs.boundaries),
      ...await compareJsonOutput("dependency graph", outputs.graph, tempOutputs.graph),
      ...await compareTextOutput("rules", outputs.rules, tempOutputs.rules, normalizeRulesText),
    ];

    return { stale };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function compareJsonOutput(label, currentPath, generatedPath) {
  const [current, generated] = await Promise.all([
    readTextIfExists(currentPath),
    fs.readFile(generatedPath, "utf8"),
  ]);

  if (current === null) {
    return [{ path: currentPath, reason: `${label} missing` }];
  }

  if (canonicalJson(current) === canonicalJson(generated)) {
    return [];
  }

  return [{ path: currentPath, reason: `${label} differs` }];
}

async function compareTextOutput(label, currentPath, generatedPath, normalize) {
  const [current, generated] = await Promise.all([
    readTextIfExists(currentPath),
    fs.readFile(generatedPath, "utf8"),
  ]);

  if (current === null) {
    return [{ path: currentPath, reason: `${label} missing` }];
  }

  if (normalize(current) === normalize(generated)) {
    return [];
  }

  return [{ path: currentPath, reason: `${label} differs` }];
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function canonicalJson(text) {
  return JSON.stringify(sortJson(JSON.parse(text)));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }

  return value;
}

function normalizeRulesText(text) {
  return normalizeLineEndings(text)
    .replace(/^# Source graph:.*$/m, "# Source graph: <generated-check-graph>")
    .trimEnd();
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n");
}

function runNode(scriptPath, args) {
  const command = process.execPath;
  const fullScriptPath = path.join(REPO_ROOT, scriptPath);

  return new Promise((resolve, reject) => {
    const child = spawn(command, [fullScriptPath, ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(formatFailedCommand(command, [fullScriptPath, ...args], code, stdout, stderr)));
    });
  });
}

function formatFailedCommand(command, args, code, stdout, stderr) {
  const lines = [
    `Command failed with exit code ${code}: ${[command, ...args].map(quoteArg).join(" ")}`,
  ];

  if (stdout.trim()) {
    lines.push("", "stdout:", stdout.trimEnd());
  }

  if (stderr.trim()) {
    lines.push("", "stderr:", stderr.trimEnd());
  }

  return lines.join("\n");
}

function quoteArg(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function toDisplayPath(base, target) {
  const relative = path.relative(base, target);
  return normalizePath(relative || ".");
}

function normalizePath(value) {
  return value.replaceAll(path.sep, "/");
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
