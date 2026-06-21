#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const workspace = path.resolve(process.cwd(), process.argv[2] ?? "fixtures/dynamic-unknown");
  const analysis = await analyze(workspace);

  assertUnknownEdge(analysis, "dynamic-unknown");
  assertUnknownEdge(analysis, "require-unknown");
  assertNoBoundaryEdges(analysis);
  await assertGeneratorWarnings(workspace, analysis);

  process.stdout.write("Dynamic unknown dependency analysis passed.\n");
}

async function analyze(workspace) {
  const result = await runNode("src/analyze-js-ts-imports.ts", [workspace]);
  return JSON.parse(result.stdout);
}

function assertUnknownEdge(analysis, kind) {
  const matches = analysis.edges.filter((edge) => edge.kind === kind);
  assert(matches.length === 1, `Expected exactly one ${kind} edge, got ${matches.length}.`);

  const edge = matches[0];
  assert(edge.from === "order/src/load-module.ts", `${kind} edge has unexpected from path: ${edge.from}.`);
  assert(edge.to === null, `${kind} edge must not resolve to a target file.`);
  assert(edge.specifier === null, `${kind} edge specifier must be null.`);
  assert(edge.resolved === false, `${kind} edge resolved must be false.`);
  assert(edge.confidence === "low", `${kind} edge confidence must be low.`);
  assert(edge.fromBoundary === "order", `${kind} edge fromBoundary must be order.`);
  assert(edge.toBoundary === null, `${kind} edge toBoundary must be null.`);
}

function assertNoBoundaryEdges(analysis) {
  assert(Array.isArray(analysis.boundaryEdges), "Analysis output must include boundaryEdges.");
  assert(analysis.boundaryEdges.length === 0, `Expected no boundaryEdges, got ${analysis.boundaryEdges.length}.`);
}

async function assertGeneratorWarnings(workspace, analysis) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dynamic-unknown-"));
  const graphPath = path.join(tempRoot, "dependency-graph.json");

  try {
    await fs.writeFile(graphPath, `${JSON.stringify(analysis)}\n`, "utf8");
    const result = await runNode("src/generate-codex-permissions.ts", [workspace, "--graph", graphPath]);
    const warnings = result.stderr.match(/unknown_dynamic_dependency/g) ?? [];
    assert(warnings.length === 2, `Expected two unknown_dynamic_dependency warnings, got ${warnings.length}.`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
