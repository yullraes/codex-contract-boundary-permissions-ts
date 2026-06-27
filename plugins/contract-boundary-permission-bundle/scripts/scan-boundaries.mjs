#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { findMarkdownDocuments, scanBoundaryContracts } from "../src/boundary-contracts.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(args.workspace ?? process.cwd());
  const documents = await findMarkdownDocuments(workspace);
  const scan = await scanBoundaryContracts(workspace, documents);
  const json = JSON.stringify(scan, null, args.pretty ? 2 : 0);

  if (args.out) {
    const outPath = path.resolve(process.cwd(), args.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${json}\n`, "utf8");
  } else {
    process.stdout.write(`${json}\n`);
  }

  if (scan.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const args = {
    workspace: undefined,
    out: undefined,
    pretty: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--pretty") {
      args.pretty = true;
      continue;
    }

    if (arg === "--out") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--out requires a file path.");
      }
      args.out = value;
      index += 1;
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

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/scan-boundaries.mjs [workspace] [--out path] [--pretty]

Scans Markdown frontmatter and emits contract boundary metadata.

Contract participation is opt-in:
- Any .md/.mdx document with contract_scope: boundary is a boundary entrypoint.
- contract_scope: public/internal documents participate when linked from boundary contract sections.
- External boundary dependencies are read from body links under External Contracts / Dependencies sections.

Frontmatter:
  ---
  contract_scope: boundary
  name: payment
  ---

Options:
  --out <path>   Write JSON to a file instead of stdout.
  --pretty       Pretty-print JSON output.
  -h, --help     Show this help.
`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
