#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

type Access = "read" | "write" | "deny";
type DiagnosticSeverity = "error" | "warning";
type FileKind = "source" | "test" | "config";
type ImportKind =
  | "import"
  | "type-import"
  | "export"
  | "type-export"
  | "dynamic-import"
  | "require"
  | "dynamic-unknown"
  | "require-unknown"
  | "workspace-package-dependency";

type CliArgs = {
  workspace?: string;
  graph?: string;
  config?: string;
  defaultBoundary?: string;
  allowGraphErrors: boolean;
  allowRootBoundary: boolean;
  strictDynamic: boolean;
  json: boolean;
};

type Diagnostic = {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  path: string;
};

type Boundary = {
  name: string | null;
  root: string;
  readme: string;
  contractFiles?: string[];
  publicArtifacts?: string[];
  contractScope: string;
  metadata?: Record<string, unknown>;
};

type BoundaryEdge = {
  from: string;
  to: string;
  imports?: {
    from: string;
    to: string;
    kind: ImportKind;
    fromFileKind?: FileKind;
    specifier: string | null;
  }[];
};

type ImportEdge = {
  from: string;
  to: string | null;
  kind: ImportKind;
  fromFileKind?: FileKind;
  fromBoundary: string | null;
  toBoundary: string | null;
  confidence?: "high" | "low";
};

type GraphFile = {
  path: string;
  kind: FileKind;
  boundary: string | null;
  boundaryRoot: string | null;
};

type DependencyGraph = {
  schemaVersion?: string;
  analyzer?: string;
  workspace?: string;
  boundaries: Boundary[];
  files?: GraphFile[];
  edges?: ImportEdge[];
  boundaryEdges: BoundaryEdge[];
  diagnostics?: Diagnostic[];
};

type ExpectedProfile = {
  name: string;
  boundary: Boundary;
  dependencies: Boundary[];
};

type TomlTable = Record<string, unknown>;

const ACCESS_PRECEDENCE: Record<Access, number> = {
  read: 1,
  write: 2,
  deny: 3,
};

const SENSITIVE_DENY_GLOBS = [
  "**/*.env",
  "**/.env.*",
  "**/*secret*",
  "**/*token*",
  "**/*credential*",
];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(args.workspace ?? process.cwd());
  const graphPath = path.resolve(process.cwd(), args.graph ?? path.join(workspace, ".codex", "dependency-graph.json"));
  const configPath = path.resolve(process.cwd(), args.config ?? path.join(workspace, ".codex", "config.toml"));
  const graph = await readGraph(graphPath);
  const config = await readConfig(configPath);
  const diagnostics = [
    ...validateGraph(graph, args),
    ...validateConfig(graph, config, args),
  ];
  const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ok: !hasErrors,
      graph: toDisplayPath(workspace, graphPath),
      config: toDisplayPath(workspace, configPath),
      diagnostics,
      limitation: "This validates one config.toml file semantically. It does not prove the final Codex runtime effective configuration.",
    }, null, 2)}\n`);
  } else {
    for (const diagnostic of diagnostics) {
      const write = diagnostic.severity === "error" ? process.stderr.write.bind(process.stderr) : process.stdout.write.bind(process.stdout);
      write(formatDiagnostic(diagnostic));
    }

    if (!hasErrors) {
      process.stdout.write(`Permission config validation passed for ${toDisplayPath(workspace, configPath)}.\n`);
      process.stdout.write("Note: this validates the target config.toml file, not the final Codex runtime effective config.\n");
    }
  }

  if (hasErrors) {
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    workspace: undefined,
    graph: undefined,
    config: undefined,
    defaultBoundary: undefined,
    allowGraphErrors: false,
    allowRootBoundary: false,
    strictDynamic: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--graph") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--graph requires a file path.");
      }
      args.graph = value;
      index += 1;
      continue;
    }

    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--config requires a file path.");
      }
      args.config = value;
      index += 1;
      continue;
    }

    if (arg === "--default-boundary") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--default-boundary requires a boundary name.");
      }
      args.defaultBoundary = value;
      index += 1;
      continue;
    }

    if (arg === "--allow-graph-errors") {
      args.allowGraphErrors = true;
      continue;
    }

    if (arg === "--allow-root-boundary") {
      args.allowRootBoundary = true;
      continue;
    }

    if (arg === "--strict-dynamic") {
      args.strictDynamic = true;
      continue;
    }

    if (arg === "--json") {
      args.json = true;
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

function printHelp(): void {
  process.stdout.write(`Usage: node src/validate-codex-permissions.ts [workspace] [--graph path] [--config path]

Semantically validates that a Codex config.toml contains graph-derived
boundary permission profiles.

Options:
  --graph <path>              Dependency graph JSON. Defaults to <workspace>/.codex/dependency-graph.json.
  --config <path>             Codex config TOML. Defaults to <workspace>/.codex/config.toml.
  --default-boundary <name>   Require default_permissions to match this boundary's generated profile.
  --allow-graph-errors        Do not fail on graph diagnostics that are errors.
  --allow-root-boundary       Allow a boundary whose root is ".".
  --strict-dynamic            Treat unknown dynamic dependency warnings as errors.
  --json                      Emit JSON diagnostics.
  -h, --help                  Show this help.
`);
}

async function readGraph(graphPath: string): Promise<DependencyGraph> {
  const content = await fs.readFile(graphPath, "utf8");
  return JSON.parse(content) as DependencyGraph;
}

async function readConfig(configPath: string): Promise<TomlTable> {
  const content = await fs.readFile(configPath, "utf8");
  return parseTomlConfig(content);
}

function parseTomlConfig(content: string): TomlTable {
  const root: TomlTable = {};
  let currentTable = root;

  for (const logicalLine of collectTomlLogicalLines(content)) {
    const lineNumber = logicalLine.lineNumber;
    const line = logicalLine.text;

    if (!line) {
      continue;
    }

    if (line.startsWith("[[")) {
      if (!line.endsWith("]]")) {
        throw new Error(`Invalid TOML array table header on line ${lineNumber}.`);
      }
      currentTable = pushArrayTable(root, parseTomlDottedKey(line.slice(2, -2), lineNumber));
      continue;
    }

    if (line.startsWith("[")) {
      if (!line.endsWith("]")) {
        throw new Error(`Invalid TOML table header on line ${lineNumber}.`);
      }
      currentTable = ensureTomlTable(root, parseTomlDottedKey(line.slice(1, -1), lineNumber));
      continue;
    }

    const equalsIndex = findTopLevelCharacter(line, "=");
    if (equalsIndex === -1) {
      throw new Error(`Invalid TOML key/value pair on line ${lineNumber}.`);
    }

    const keyPath = parseTomlDottedKey(line.slice(0, equalsIndex), lineNumber);
    const value = parseTomlValue(line.slice(equalsIndex + 1).trim(), lineNumber);
    setTomlValue(currentTable, keyPath, value, lineNumber);
  }

  return root;
}

function collectTomlLogicalLines(content: string): { text: string; lineNumber: number }[] {
  const logicalLines: { text: string; lineNumber: number }[] = [];
  const physicalLines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  let current = "";
  let startLine = 1;

  for (let index = 0; index < physicalLines.length; index += 1) {
    const line = stripTomlComment(physicalLines[index]).trim();

    if (!current && !line) {
      continue;
    }

    if (!current) {
      startLine = index + 1;
      current = line;
    } else {
      current = `${current} ${line}`.trim();
    }

    if (isCompleteTomlLogicalLine(current, startLine)) {
      logicalLines.push({ text: current, lineNumber: startLine });
      current = "";
    }
  }

  if (current) {
    throw new Error(`Incomplete TOML expression starting on line ${startLine}.`);
  }

  return logicalLines;
}

function isCompleteTomlLogicalLine(line: string, lineNumber: number): boolean {
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quote === "\"") {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (quote === "'") {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "[") {
      squareDepth += 1;
      continue;
    }

    if (char === "]") {
      squareDepth -= 1;
      if (squareDepth < 0) {
        throw new Error(`Invalid TOML bracket nesting on line ${lineNumber}.`);
      }
      continue;
    }

    if (char === "{") {
      curlyDepth += 1;
      continue;
    }

    if (char === "}") {
      curlyDepth -= 1;
      if (curlyDepth < 0) {
        throw new Error(`Invalid TOML brace nesting on line ${lineNumber}.`);
      }
    }
  }

  return !quote && squareDepth === 0 && curlyDepth === 0;
}

function stripTomlComment(line: string): string {
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quote === "\"") {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (quote === "'") {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "#") {
      return line.slice(0, index);
    }
  }

  return line;
}

function parseTomlDottedKey(rawKey: string, lineNumber: number): string[] {
  const parts = splitTopLevel(rawKey, ".", lineNumber)
    .map((part) => parseTomlKeySegment(part.trim(), lineNumber));

  if (parts.length === 0 || parts.some((part) => part === "")) {
    throw new Error(`Invalid TOML key on line ${lineNumber}.`);
  }

  return parts;
}

function parseTomlKeySegment(rawSegment: string, lineNumber: number): string {
  if (!rawSegment) {
    throw new Error(`Invalid TOML key segment on line ${lineNumber}.`);
  }

  if (isQuotedTomlString(rawSegment)) {
    return parseTomlString(rawSegment, lineNumber);
  }

  return rawSegment;
}

function parseTomlValue(rawValue: string, lineNumber: number): unknown {
  const value = rawValue.trim();

  if (isQuotedTomlString(value)) {
    return parseTomlString(value, lineNumber);
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (/^[+-]?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || /^[+-]?\d+[eE][+-]?\d+$/.test(value)) {
    return Number.parseFloat(value);
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    return parseTomlArray(value, lineNumber);
  }

  if (value.startsWith("{") && value.endsWith("}")) {
    return parseTomlInlineTable(value, lineNumber);
  }

  return value;
}

function isQuotedTomlString(value: string): boolean {
  return (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  );
}

function parseTomlString(value: string, lineNumber: number): string {
  if (value.startsWith("\"")) {
    try {
      return JSON.parse(value) as string;
    } catch (error) {
      throw new Error(`Invalid TOML basic string on line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return value.slice(1, -1);
}

function parseTomlArray(value: string, lineNumber: number): unknown[] {
  const inner = value.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  return splitTopLevel(inner, ",", lineNumber)
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => parseTomlValue(item, lineNumber));
}

function parseTomlInlineTable(value: string, lineNumber: number): TomlTable {
  const table: TomlTable = {};
  const inner = value.slice(1, -1).trim();

  if (!inner) {
    return table;
  }

  for (const item of splitTopLevel(inner, ",", lineNumber)) {
    const equalsIndex = findTopLevelCharacter(item, "=");
    if (equalsIndex === -1) {
      throw new Error(`Invalid TOML inline table item on line ${lineNumber}.`);
    }

    setTomlValue(
      table,
      parseTomlDottedKey(item.slice(0, equalsIndex), lineNumber),
      parseTomlValue(item.slice(equalsIndex + 1), lineNumber),
      lineNumber,
    );
  }

  return table;
}

function splitTopLevel(value: string, delimiter: string, lineNumber: number): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (quote === "\"") {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (quote === "'") {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "[") {
      squareDepth += 1;
      continue;
    }

    if (char === "]") {
      squareDepth -= 1;
      if (squareDepth < 0) {
        throw new Error(`Invalid TOML bracket nesting on line ${lineNumber}.`);
      }
      continue;
    }

    if (char === "{") {
      curlyDepth += 1;
      continue;
    }

    if (char === "}") {
      curlyDepth -= 1;
      if (curlyDepth < 0) {
        throw new Error(`Invalid TOML brace nesting on line ${lineNumber}.`);
      }
      continue;
    }

    if (char === delimiter && squareDepth === 0 && curlyDepth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  if (quote || squareDepth !== 0 || curlyDepth !== 0) {
    throw new Error(`Invalid TOML nesting on line ${lineNumber}.`);
  }

  parts.push(value.slice(start));
  return parts;
}

function findTopLevelCharacter(value: string, target: string): number {
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (quote === "\"") {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (quote === "'") {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "[") {
      squareDepth += 1;
      continue;
    }

    if (char === "]") {
      squareDepth -= 1;
      continue;
    }

    if (char === "{") {
      curlyDepth += 1;
      continue;
    }

    if (char === "}") {
      curlyDepth -= 1;
      continue;
    }

    if (char === target && squareDepth === 0 && curlyDepth === 0) {
      return index;
    }
  }

  return -1;
}

function ensureTomlTable(root: TomlTable, pathParts: string[]): TomlTable {
  let current = root;

  for (const part of pathParts) {
    const existing = current[part];

    if (Array.isArray(existing)) {
      const last = existing.at(-1);
      if (!last || typeof last !== "object" || Array.isArray(last)) {
        throw new Error(`TOML path '${pathParts.join(".")}' does not point to a table.`);
      }
      current = last as TomlTable;
      continue;
    }

    if (existing === undefined) {
      const next: TomlTable = {};
      current[part] = next;
      current = next;
      continue;
    }

    if (!existing || typeof existing !== "object") {
      throw new Error(`TOML path '${pathParts.join(".")}' does not point to a table.`);
    }

    current = existing as TomlTable;
  }

  return current;
}

function pushArrayTable(root: TomlTable, pathParts: string[]): TomlTable {
  const parent = ensureTomlTable(root, pathParts.slice(0, -1));
  const key = pathParts.at(-1);
  if (!key) {
    throw new Error("Invalid TOML array table path.");
  }

  const existing = parent[key];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error(`TOML path '${pathParts.join(".")}' is not an array table.`);
  }

  const array = Array.isArray(existing) ? existing : [];
  const next: TomlTable = {};
  array.push(next);
  parent[key] = array;
  return next;
}

function setTomlValue(table: TomlTable, pathParts: string[], value: unknown, lineNumber: number): void {
  const parent = ensureTomlTable(table, pathParts.slice(0, -1));
  const key = pathParts.at(-1);
  if (!key) {
    throw new Error(`Invalid TOML key on line ${lineNumber}.`);
  }

  parent[key] = value;
}

function validateGraph(graph: DependencyGraph, args: CliArgs): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (!args.allowGraphErrors) {
    diagnostics.push(...(graph.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === "error"));
  }

  if (!Array.isArray(graph.boundaries) || graph.boundaries.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "no_boundaries",
      message: "Dependency graph does not contain any boundaries.",
      path: ".",
    });
  }

  if (!Array.isArray(graph.boundaryEdges)) {
    diagnostics.push({
      severity: "error",
      code: "missing_boundary_edges",
      message: "Dependency graph is missing boundaryEdges.",
      path: ".",
    });
  }

  const names = new Set<string>();
  for (const boundary of graph.boundaries ?? []) {
    if (!boundary.name) {
      diagnostics.push({
        severity: "error",
        code: "boundary_name_missing",
        message: "Boundary is missing a name.",
        path: boundary.readme ?? ".",
      });
      continue;
    }

    if (names.has(boundary.name)) {
      diagnostics.push({
        severity: "error",
        code: "duplicate_boundary_name",
        message: `Boundary name '${boundary.name}' is declared more than once.`,
        path: boundary.readme,
      });
    }
    names.add(boundary.name);

    if (!isSafeWorkspaceRelativePath(boundary.root) || !isSafeWorkspaceRelativePath(boundary.readme)) {
      diagnostics.push({
        severity: "error",
        code: "unsafe_boundary_path",
        message: "Boundary root/readme must be workspace-relative paths without parent traversal.",
        path: boundary.readme ?? ".",
      });
    }

    if (boundary.root === "." && !args.allowRootBoundary) {
      diagnostics.push({
        severity: "error",
        code: "root_boundary_not_allowed",
        message: "Root boundary would grant write access to the whole workspace.",
        path: boundary.readme,
      });
    }

    if (Array.isArray(boundary.contractFiles)) {
      const contractFiles = boundary.contractFiles;
      if (!contractFiles.includes(boundary.readme)) {
        diagnostics.push({
          severity: "error",
          code: "boundary_readme_missing_from_contract_files",
          message: "Boundary contractFiles must include the boundary README.",
          path: boundary.readme,
        });
      }

      for (const contractFile of contractFiles) {
        if (!isSafeWorkspaceRelativePath(contractFile) || !isSameOrChildPath(boundary.root, contractFile)) {
          diagnostics.push({
            severity: "error",
            code: "contract_file_outside_boundary",
            message: "Boundary contractFiles must stay inside the boundary root.",
            path: contractFile,
          });
        }
      }
    }

    for (const publicArtifact of publicArtifactsForBoundary(boundary)) {
      if (!isSafeWorkspaceRelativePath(publicArtifact) || !isSameOrChildPath(boundary.root, publicArtifact)) {
        diagnostics.push({
          severity: "error",
          code: "public_artifact_outside_boundary",
          message: "Boundary publicArtifacts must stay inside the boundary root.",
          path: publicArtifact,
        });
      }
    }
  }

  for (const edge of graph.boundaryEdges ?? []) {
    if (!names.has(edge.from)) {
      diagnostics.push({
        severity: "error",
        code: "unknown_boundary_edge_from",
        message: `Boundary edge references unknown source boundary '${edge.from}'.`,
        path: ".",
      });
    }

    if (!names.has(edge.to)) {
      diagnostics.push({
        severity: "error",
        code: "unknown_boundary_edge_to",
        message: `Boundary edge references unknown target boundary '${edge.to}'.`,
        path: ".",
      });
    }
  }

  for (const edge of graph.edges ?? []) {
    if ((edge.kind === "dynamic-unknown" || edge.kind === "require-unknown") && edge.fromBoundary) {
      diagnostics.push({
        severity: args.strictDynamic ? "error" : "warning",
        code: "unknown_dynamic_dependency",
        message: `Unknown dynamic dependency in boundary '${edge.fromBoundary}' may make generated permissions incomplete.`,
        path: edge.from,
      });
    }
  }

  return diagnostics;
}

function validateConfig(graph: DependencyGraph, config: TomlTable, args: CliArgs): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const expectedProfiles = buildExpectedProfiles(graph);
  const permissions = asTable(config.permissions);

  if (!permissions) {
    return [{
      severity: "error",
      code: "permissions_table_missing",
      message: "config.toml does not define a [permissions] table.",
      path: "config.toml",
    }];
  }

  if (config.sandbox_mode === "danger-full-access") {
    diagnostics.push({
      severity: "error",
      code: "danger_full_access_sandbox",
      message: 'sandbox_mode = "danger-full-access" makes generated boundary permissions unenforceable.',
      path: "sandbox_mode",
    });
  }

  if (config.default_permissions === ":danger-full-access") {
    diagnostics.push({
      severity: "error",
      code: "danger_full_access_default_permissions",
      message: 'default_permissions = ":danger-full-access" bypasses generated boundary permissions.',
      path: "default_permissions",
    });
  }

  if (args.defaultBoundary) {
    const expectedDefault = expectedProfiles.find((profile) => safeName(profile.boundary) === args.defaultBoundary);
    if (!expectedDefault) {
      diagnostics.push({
        severity: "error",
        code: "default_boundary_unknown",
        message: `--default-boundary '${args.defaultBoundary}' is not present in the dependency graph.`,
        path: "default_permissions",
      });
    } else if (config.default_permissions !== expectedDefault.name) {
      diagnostics.push({
        severity: "error",
        code: "default_permissions_mismatch",
        message: `default_permissions must be '${expectedDefault.name}' for boundary '${args.defaultBoundary}'.`,
        path: "default_permissions",
      });
    }
  } else if (
    typeof config.default_permissions === "string" &&
    !expectedProfiles.some((profile) => profile.name === config.default_permissions) &&
    config.default_permissions !== ":read-only" &&
    config.default_permissions !== ":workspace"
  ) {
    diagnostics.push({
      severity: "warning",
      code: "default_permissions_not_generated",
      message: "default_permissions does not select a generated boundary profile.",
      path: "default_permissions",
    });
  }

  for (const expected of expectedProfiles) {
    diagnostics.push(...validateProfile(expected, expectedProfiles, permissions, graph));
  }

  return diagnostics;
}

function validateProfile(
  expected: ExpectedProfile,
  allProfiles: ExpectedProfile[],
  permissions: TomlTable,
  graph: DependencyGraph,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const profilePath = `permissions.${expected.name}`;
  const profile = asTable(permissions[expected.name]);

  if (!profile) {
    return [{
      severity: "error",
      code: "profile_missing",
      message: `Missing generated profile '${expected.name}'.`,
      path: profilePath,
    }];
  }

  if (typeof profile.extends === "string") {
    diagnostics.push({
      severity: "error",
      code: "profile_extends_unsupported",
      message: `Generated profile '${expected.name}' must not use extends; v1 validator cannot prove inherited permissions are safe.`,
      path: `${profilePath}.extends`,
    });
  }

  const filesystem = asTable(profile.filesystem);
  if (!filesystem) {
    return [{
      severity: "error",
      code: "profile_filesystem_missing",
      message: `Profile '${expected.name}' is missing a filesystem table.`,
      path: `${profilePath}.filesystem`,
    }];
  }

  const workspaceRoots = asAccessTable(filesystem[":workspace_roots"]);
  if (!workspaceRoots) {
    return [{
      severity: "error",
      code: "workspace_roots_missing",
      message: `Profile '${expected.name}' is missing filesystem.":workspace_roots".`,
      path: `${profilePath}.filesystem.":workspace_roots"`,
    }];
  }

  diagnostics.push(...validateAccessValues(expected.name, workspaceRoots));
  diagnostics.push(...validateCoreAccess(expected, allProfiles, workspaceRoots, graph));
  diagnostics.push(...validateExternalReopens(expected, allProfiles, workspaceRoots));
  diagnostics.push(...validateSensitiveDeny(expected.name, workspaceRoots));

  return diagnostics;
}

function validateCoreAccess(
  expected: ExpectedProfile,
  allProfiles: ExpectedProfile[],
  entries: Map<string, Access>,
  graph: DependencyGraph,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const ownerName = safeName(expected.boundary);
  const dependencyNames = new Set(expected.dependencies.map((boundary) => safeName(boundary)));

  expectAccess(diagnostics, expected.name, entries, ".", "read", "workspace_root_not_read", "Workspace root must be read, not write or deny.");
  expectNotWrite(diagnostics, expected.name, entries, ".codex", "codex_writable", ".codex must not be writable from a boundary profile.");
  expectAccess(diagnostics, expected.name, entries, expected.boundary.root, "write", "owner_boundary_not_write", `Owner boundary '${ownerName}' must be writable.`);

  for (const profile of allProfiles) {
    const boundary = profile.boundary;
    const boundaryName = safeName(boundary);

    if (boundaryName === ownerName) {
      continue;
    }

    expectAccess(
      diagnostics,
      expected.name,
      entries,
      boundary.root,
      "deny",
      "external_boundary_not_denied",
      `External boundary '${boundaryName}' must be denied by default.`,
    );

    const isDependency = dependencyNames.has(boundaryName);
    const expectedReadableAccess: Access = isDependency ? "read" : "deny";
    const readableFiles = new Set(readableFilesForBoundary(boundary));

    for (const readableFile of readableFiles) {
      expectAccess(
        diagnostics,
        expected.name,
        entries,
        readableFile,
        expectedReadableAccess,
        isDependency ? "dependency_public_file_not_read" : "non_dependency_public_file_not_denied",
        isDependency
          ? `Direct dependency boundary '${boundaryName}' public file '${readableFile}' must be readable.`
          : `Non-dependency boundary '${boundaryName}' public file '${readableFile}' must stay denied.`,
      );
    }

    for (const file of graph.files ?? []) {
      if (file.boundary !== boundaryName || readableFiles.has(file.path)) {
        continue;
      }

      expectAccess(
        diagnostics,
        expected.name,
        entries,
        file.path,
        "deny",
        "external_source_file_not_denied",
        `External boundary file '${file.path}' must stay denied.`,
      );
    }
  }

  return diagnostics;
}

function validateExternalReopens(
  expected: ExpectedProfile,
  allProfiles: ExpectedProfile[],
  entries: Map<string, Access>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const ownerName = safeName(expected.boundary);
  const allowedReadPaths = new Set(expected.dependencies.flatMap((boundary) => readableFilesForBoundary(boundary)));

  for (const [entryPath, access] of entries) {
    if (entryPath.includes("*") || access === "deny") {
      continue;
    }

    for (const profile of allProfiles) {
      const boundary = profile.boundary;
      const boundaryName = safeName(boundary);

      if (boundaryName === ownerName) {
        continue;
      }

      if (!isSameOrChildPath(boundary.root, entryPath)) {
        continue;
      }

      if (allowedReadPaths.has(entryPath) && access === "read") {
        continue;
      }

      diagnostics.push({
        severity: "error",
        code: "external_boundary_reopened",
        message: `Profile '${expected.name}' reopens '${entryPath}' inside external boundary '${boundaryName}'. Only direct dependency contract files and public artifacts may be read.`,
        path: `permissions.${expected.name}.filesystem.":workspace_roots".${entryPath}`,
      });
    }
  }

  return diagnostics;
}

function validateSensitiveDeny(profileName: string, entries: Map<string, Access>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const pattern of SENSITIVE_DENY_GLOBS) {
    if (entries.get(pattern) !== "deny") {
      diagnostics.push({
        severity: "error",
        code: "sensitive_glob_not_denied",
        message: `Profile '${profileName}' must deny sensitive glob '${pattern}'.`,
        path: `permissions.${profileName}.filesystem.":workspace_roots".${pattern}`,
      });
    }
  }

  return diagnostics;
}

function validateAccessValues(profileName: string, entries: Map<string, Access>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const [entryPath, access] of entries) {
    if (access !== "read" && access !== "write" && access !== "deny") {
      diagnostics.push({
        severity: "error",
        code: "invalid_access_value",
        message: `Profile '${profileName}' has invalid access '${String(access)}' for '${entryPath}'.`,
        path: `permissions.${profileName}.filesystem.":workspace_roots".${entryPath}`,
      });
    }
  }

  return diagnostics;
}

function expectAccess(
  diagnostics: Diagnostic[],
  profileName: string,
  entries: Map<string, Access>,
  targetPath: string,
  expected: Access,
  code: string,
  message: string,
): void {
  const actual = effectiveAccess(entries, targetPath);
  if (actual !== expected) {
    diagnostics.push({
      severity: "error",
      code,
      message: `${message} Expected ${expected}, got ${actual ?? "none"}.`,
      path: `permissions.${profileName}.filesystem.":workspace_roots".${targetPath}`,
    });
  }
}

function expectNotWrite(
  diagnostics: Diagnostic[],
  profileName: string,
  entries: Map<string, Access>,
  targetPath: string,
  code: string,
  message: string,
): void {
  const actual = effectiveAccess(entries, targetPath);
  if (actual === "write") {
    diagnostics.push({
      severity: "error",
      code,
      message,
      path: `permissions.${profileName}.filesystem.":workspace_roots".${targetPath}`,
    });
  }
}

function effectiveAccess(entries: Map<string, Access>, targetPath: string): Access | null {
  const target = normalizePath(targetPath);
  let best: { specificity: number; access: Access } | null = null;

  for (const [entryPath, access] of entries) {
    if (entryPath.includes("*")) {
      continue;
    }

    if (!pathRuleMatches(entryPath, target)) {
      continue;
    }

    const specificity = pathSpecificity(entryPath);
    if (
      !best ||
      specificity > best.specificity ||
      (specificity === best.specificity && ACCESS_PRECEDENCE[access] > ACCESS_PRECEDENCE[best.access])
    ) {
      best = { specificity, access };
    }
  }

  return best?.access ?? null;
}

function pathRuleMatches(rulePath: string, targetPath: string): boolean {
  const rule = normalizePath(rulePath);
  const target = normalizePath(targetPath);

  if (rule === ".") {
    return true;
  }

  return target === rule || target.startsWith(`${rule}/`);
}

function pathSpecificity(rulePath: string): number {
  const rule = normalizePath(rulePath);
  if (rule === ".") {
    return 0;
  }

  return rule.split("/").length;
}

function buildExpectedProfiles(graph: DependencyGraph): ExpectedProfile[] {
  const boundaries = [...graph.boundaries].sort((left, right) => safeName(left).localeCompare(safeName(right)));
  const byName = new Map(boundaries.map((boundary) => [safeName(boundary), boundary]));
  const depsByBoundary = new Map<string, Set<string>>();

  for (const boundary of boundaries) {
    depsByBoundary.set(safeName(boundary), new Set());
  }

  for (const edge of graph.boundaryEdges ?? []) {
    if (edge.from === edge.to) {
      continue;
    }

    depsByBoundary.get(edge.from)?.add(edge.to);
  }

  const usedProfileNames = new Map<string, number>();

  return boundaries.map((boundary) => {
    const boundaryName = safeName(boundary);
    const profileName = uniqueProfileName(`agent-${slugify(boundaryName)}`, usedProfileNames);
    const dependencies = [...(depsByBoundary.get(boundaryName) ?? [])]
      .map((name) => byName.get(name))
      .filter((item): item is Boundary => Boolean(item))
      .sort((left, right) => safeName(left).localeCompare(safeName(right)));

    return {
      name: profileName,
      boundary,
      dependencies,
    };
  });
}

function contractFilesForBoundary(boundary: Boundary): string[] {
  const files = Array.isArray(boundary.contractFiles) && boundary.contractFiles.length > 0
    ? boundary.contractFiles
    : [boundary.readme];
  return [...new Set(files)];
}

function publicArtifactsForBoundary(boundary: Boundary): string[] {
  return Array.isArray(boundary.publicArtifacts) ? [...new Set(boundary.publicArtifacts)] : [];
}

function readableFilesForBoundary(boundary: Boundary): string[] {
  return [...new Set([...contractFilesForBoundary(boundary), ...publicArtifactsForBoundary(boundary)])];
}

function asTable(value: unknown): TomlTable | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as TomlTable;
}

function asAccessTable(value: unknown): Map<string, Access> | null {
  const table = asTable(value);
  if (!table) {
    return null;
  }

  const entries = new Map<string, Access>();
  for (const [key, access] of Object.entries(table)) {
    entries.set(key, access as Access);
  }

  return entries;
}

function safeName(boundary: Boundary): string {
  if (!boundary.name) {
    throw new Error(`Boundary at ${boundary.readme} is missing a name.`);
  }

  return boundary.name;
}

function uniqueProfileName(baseName: string, used: Map<string, number>): string {
  const count = used.get(baseName) ?? 0;
  used.set(baseName, count + 1);

  if (count === 0) {
    return baseName;
  }

  return `${baseName}-${count + 1}`;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "boundary";
}

function isSafeWorkspaceRelativePath(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  if (value === ".") {
    return true;
  }

  const normalized = normalizePath(value);
  return !path.isAbsolute(value) && !normalized.startsWith("../") && !normalized.includes("/../") && normalized !== "..";
}

function isSameOrChildPath(parent: string, child: string): boolean {
  const relative = path.posix.relative(normalizePath(parent), normalizePath(child));
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative));
}

function toDisplayPath(workspace: string, target: string): string {
  const relative = path.relative(workspace, target);
  return relative ? normalizePath(relative) : ".";
}

function normalizePath(value: string): string {
  return value.replaceAll(path.sep, "/");
}

function formatDiagnostic(diagnostic: Diagnostic): string {
  return `[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message} (${diagnostic.path})\n`;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
