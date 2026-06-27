#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_EXCLUDED_DIRS = new Set([
  ".codex",
  ".git",
  ".idea",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "fixtures",
  "node_modules",
  "out",
]);

const REQUIRED_PRIMITIVES = [
  "scripts/scan-boundaries.mjs",
  "scripts/refresh-generated.mjs",
  "src/validate-codex-permissions.ts",
];
const TOOL_DIR_NAME = "contract-boundary-permissions";
const HOOK_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(args.workspace ?? await findGitRoot(process.cwd()) ?? process.cwd());
  const codexDir = path.join(workspace, ".codex");
  const graphPath = path.resolve(args.graph ?? path.join(codexDir, "dependency-graph.json"));
  const configPath = path.resolve(args.config ?? path.join(codexDir, "config.toml"));
  const hasGraph = await fileExists(graphPath);
  const hasConfig = await fileExists(configPath);
  const hasBoundary = await hasBoundaryContractDocument(workspace);

  if (!hasBoundary && !hasGraph && !hasConfig) {
    process.stdout.write("Contract-boundary permission pre-commit hook: no boundary workspace detected; skipping.\n");
    return;
  }

  const toolRoot = await findToolRoot(workspace, args.toolRoot);
  const failures = [];

  if (!toolRoot) {
    failures.push(formatFailure({
      title: "Missing script primitives",
      detail: `Could not find required files: ${REQUIRED_PRIMITIVES.join(", ")}.`,
      recovery: "Install or check out the contract-boundary permission automation scripts for this workspace.",
    }));
    return fail(failures);
  }

  const workspaceArg = toDisplayPath(toolRoot, workspace);

  const scan = await runNodeTool(toolRoot, "scripts/scan-boundaries.mjs", [workspaceArg, "--pretty"]);
  if (scan.code !== 0) {
    failures.push(formatFailure({
      title: "Contract document scan failed",
      detail: commandOutput(scan),
      recovery: `Fix contract document/frontmatter diagnostics, then run: npm run scan:boundaries -- ${quoteIfNeeded(workspaceArg)} --pretty`,
    }));
  }

  if (!hasGraph || !hasConfig) {
    failures.push(formatFailure({
      title: "Permission setup required",
      detail: [
        hasGraph ? null : `Missing ${toDisplayPath(workspace, graphPath)}.`,
        hasConfig ? null : `Missing ${toDisplayPath(workspace, configPath)}.`,
      ].filter(Boolean).join("\n"),
      recovery: [
        `Run: npm run refresh:generated -- ${quoteIfNeeded(workspaceArg)} --write`,
        "Generate permission candidates, merge them into .codex/config.toml, then validate permissions.",
      ].join("\n"),
    }));
    return fail(failures);
  }

  const freshness = await runNodeTool(toolRoot, "scripts/refresh-generated.mjs", [workspaceArg, "--check"]);
  if (freshness.code !== 0) {
    failures.push(formatFailure({
      title: "Generated outputs are stale",
      detail: commandOutput(freshness),
      recovery: `Run: npm run refresh:generated -- ${quoteIfNeeded(workspaceArg)} --write`,
    }));
  }

  const validation = await runNodeTool(toolRoot, "src/validate-codex-permissions.ts", [
    workspaceArg,
    "--graph",
    toDisplayPath(toolRoot, graphPath),
    "--config",
    toDisplayPath(toolRoot, configPath),
  ]);
  if (validation.code !== 0) {
    failures.push(formatFailure({
      title: "Active permission config validation failed",
      detail: commandOutput(validation),
      recovery: "Merge the generated permission profiles into .codex/config.toml without loosening external boundary access, then rerun validation.",
    }));
  }

  if (failures.length > 0) {
    return fail(failures);
  }

  process.stdout.write("Contract-boundary permission pre-commit hook checks passed.\n");
}

function parseArgs(argv) {
  const args = { workspace: null, graph: null, config: null, toolRoot: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--workspace") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--workspace requires a path.");
      }
      args.workspace = value;
      index += 1;
      continue;
    }

    if (arg === "--graph") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--graph requires a path.");
      }
      args.graph = value;
      index += 1;
      continue;
    }

    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--config requires a path.");
      }
      args.config = value;
      index += 1;
      continue;
    }

    if (arg === "--tool-root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--tool-root requires a path.");
      }
      args.toolRoot = value;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: node pre-commit.mjs [--workspace path] [--graph path] [--config path] [--tool-root path]\n");
      process.exit(0);
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return args;
}

async function findGitRoot(startDirectory) {
  let current = path.resolve(startDirectory);

  while (true) {
    if (await fileExists(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function findToolRoot(workspace, explicitToolRoot) {
  const hookToolRoot = await findAncestorToolRoot(HOOK_DIRECTORY);
  const candidates = [
    explicitToolRoot ? path.resolve(explicitToolRoot) : null,
    path.join(workspace, ".codex", "tools", TOOL_DIR_NAME),
    workspace,
    await findGitRoot(process.cwd()),
    hookToolRoot,
  ].filter(Boolean);

  for (const candidate of uniquePaths(candidates)) {
    if (await hasRequiredPrimitives(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function findAncestorToolRoot(startDirectory) {
  let current = path.resolve(startDirectory);

  while (true) {
    if (await hasRequiredPrimitives(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  const unique = [];

  for (const candidate of paths) {
    const normalized = path.resolve(candidate);
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(normalized);
  }

  return unique;
}

async function hasRequiredPrimitives(candidate) {
  for (const primitive of REQUIRED_PRIMITIVES) {
    if (!await fileExists(path.join(candidate, primitive))) {
      return false;
    }
  }

  return true;
}

async function hasBoundaryContractDocument(workspace) {
  let found = false;

  async function visit(directory) {
    if (found) {
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found) {
        return;
      }

      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
          await visit(absolutePath);
        }
        continue;
      }

      if (entry.isFile() && isMarkdownDocument(entry.name) && await documentDeclaresBoundary(absolutePath)) {
        found = true;
        return;
      }
    }
  }

  await visit(workspace);
  return found;
}

function isMarkdownDocument(fileName) {
  return fileName.endsWith(".md") || fileName.endsWith(".mdx");
}

async function documentDeclaresBoundary(readmePath) {
  const content = await fs.readFile(readmePath, "utf8");
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);

  if (lines[0]?.trim() !== "---") {
    return false;
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (line === "---") {
      return false;
    }

    if (/^contract_scope:\s*boundary\s*$/.test(line)) {
      return true;
    }
  }

  return false;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runNodeTool(toolRoot, scriptPath, args) {
  const script = path.join(toolRoot, scriptPath);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: toolRoot,
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
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: `${stderr}${error.message}\n`, args: [scriptPath, ...args], cwd: toolRoot });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr, args: [scriptPath, ...args], cwd: toolRoot });
    });
  });
}

function commandOutput(result) {
  const output = [
    result.stdout.trimEnd(),
    result.stderr.trimEnd(),
  ].filter(Boolean).join("\n\n");

  return output || `Command failed: node ${result.args.join(" ")}`;
}

function formatFailure({ title, detail, recovery }) {
  return [
    `## ${title}`,
    detail.trim(),
    "",
    "Recovery:",
    recovery.trim(),
  ].join("\n");
}

function fail(failures) {
  process.stderr.write("Contract-boundary permission pre-commit hook failed.\n\n");
  process.stderr.write(failures.join("\n\n---\n\n"));
  process.stderr.write("\n");
  process.exitCode = 1;
}

function toDisplayPath(base, target) {
  const relative = path.relative(base, target);
  return normalizePath(relative || ".");
}

function normalizePath(value) {
  return value.replaceAll(path.sep, "/");
}

function quoteIfNeeded(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});


