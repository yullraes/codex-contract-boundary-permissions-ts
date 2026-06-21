#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";
import {
  DEFAULT_EXCLUDED_DIRS,
  SCHEMA_VERSION,
  findReadmes,
  isInside,
  normalizePath,
  scanBoundaryContracts,
  toWorkspacePath,
} from "./boundary-contracts.mjs";

type ContractScope = "boundary" | "public" | "internal" | string;
type DiagnosticSeverity = "error" | "warning";
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
type Confidence = "high" | "low";
type FileKind = "source" | "test" | "config";

type CliArgs = {
  workspace?: string;
  out?: string;
  pretty: boolean;
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
  contractFiles: string[];
  publicArtifacts?: string[];
  contractScope: ContractScope;
  metadata: Record<string, unknown>;
};

type Contract = {
  name: string | null;
  root: string;
  readme?: string;
  path: string;
  boundary?: string | null;
  contractScope: ContractScope;
  metadata: Record<string, unknown>;
};

type ImportEdge = {
  from: string;
  to: string | null;
  kind: ImportKind;
  specifier: string | null;
  external: boolean;
  resolved: boolean;
  confidence: Confidence;
  fromFileKind: FileKind;
  fromBoundary: string | null;
  toBoundary: string | null;
  location: {
    line: number;
    column: number;
  };
};

type BoundaryEdge = {
  from: string;
  to: string;
  imports: {
    from: string;
    to: string;
    kind: ImportKind;
    fromFileKind: FileKind;
    specifier: string | null;
  }[];
};

type PackageDependency = {
  name: string;
  field: string;
  location: {
    line: number;
    column: number;
  };
};

type PackageManifest = {
  path: string;
  name: string | null;
  boundary: Boundary | null;
  dependencies: PackageDependency[];
};

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const PACKAGE_MANIFEST_FILE = "package.json";
const PACKAGE_DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
const RELATIVE_IMPORT_FALLBACK_EXTENSIONS_BY_KIND: Record<string, string[]> = {
  source: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  component: [".vue", ".svelte", ".astro"],
  style: [".css", ".scss", ".sass", ".less", ".pcss", ".postcss", ".styl"],
  data: [".json", ".jsonc", ".yaml", ".yml", ".toml"],
  document: [".md", ".mdx"],
  image: [".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico"],
  runtime: [".wasm", ".worker.js", ".worker.ts"],
  font: [".woff", ".woff2", ".ttf", ".otf", ".eot"],
};
const RELATIVE_IMPORT_FALLBACK_EXTENSIONS = Object.values(RELATIVE_IMPORT_FALLBACK_EXTENSIONS_BY_KIND).flat();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(args.workspace ?? process.cwd());
  const analysis = await analyzeWorkspace(workspace);
  const json = JSON.stringify(analysis, null, args.pretty ? 2 : 0);

  if (args.out) {
    const outPath = path.resolve(process.cwd(), args.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${json}\n`, "utf8");
  } else {
    process.stdout.write(`${json}\n`);
  }

  if (analysis.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
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

function printHelp(): void {
  process.stdout.write(`Usage: node src/analyze-js-ts-imports.ts [workspace] [--out path] [--pretty]

Analyzes JS/TS source imports, maps files to README frontmatter boundaries,
and emits file edges plus direct boundary dependency edges.

Options:
  --out <path>   Write JSON to a file instead of stdout.
  --pretty       Pretty-print JSON output.
  -h, --help     Show this help.
`);
}

async function analyzeWorkspace(workspace: string) {
  // v1 intentionally rebuilds the full workspace graph. Incremental refresh is deferred because
  // tsconfig path aliases, barrel re-exports, and deleted imports can affect edges outside a small diff.
  const [readmes, sourceFiles, packageManifestPaths] = await Promise.all([
    findReadmes(workspace),
    findSourceFiles(workspace),
    findPackageManifestPaths(workspace),
  ]);
  const boundaryScan = await scanBoundaryContracts(workspace, readmes) as {
    boundaries: Boundary[];
    contracts: Contract[];
    diagnostics: Diagnostic[];
  };
  const tsConfig = readTsConfig(workspace);
  const diagnostics: Diagnostic[] = [...boundaryScan.diagnostics];
  const packageManifests = await readPackageManifests(workspace, packageManifestPaths, boundaryScan.boundaries, diagnostics);
  const files = sourceFiles.map((filePath) => {
    const boundary = findBoundaryForFile(workspace, filePath, boundaryScan.boundaries);

    if (!boundary) {
      diagnostics.push({
        severity: "warning",
        code: "source_file_without_boundary",
        message: "Source file is outside any contract boundary and will not participate in boundary dependency permissions. If this is product/domain code, add a contract_scope: boundary README. If this is generated output or tooling, exclude it from analysis or add an explicit deny rule in .codex/config.toml when agents should not read it.",
        path: toWorkspacePath(workspace, filePath),
      });
    }

    return {
      path: toWorkspacePath(workspace, filePath),
      kind: getFileKind(workspace, filePath),
      boundary: boundary?.name ?? null,
      boundaryRoot: boundary?.root ?? null,
    };
  });

  const edges: ImportEdge[] = [];

  for (const filePath of sourceFiles) {
    const extracted = await extractImportEdges(workspace, filePath, boundaryScan.boundaries, tsConfig.compilerOptions, diagnostics);
    edges.push(...extracted);
  }
  edges.push(...buildWorkspacePackageDependencyEdges(workspace, packageManifests, diagnostics));

  return {
    schemaVersion: SCHEMA_VERSION,
    analyzer: "typescript-compiler-api",
    workspace: normalizePath(workspace),
    tsconfig: tsConfig.path ? toWorkspacePath(workspace, tsConfig.path) : null,
    boundaries: boundaryScan.boundaries,
    files,
    edges,
    boundaryEdges: buildBoundaryEdges(edges),
    diagnostics,
  };
}

async function findSourceFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  await walk(root, (absolutePath, entry) => {
    if (!entry.isFile()) {
      return;
    }

    if (absolutePath.endsWith(".d.ts")) {
      return;
    }

    if (SOURCE_EXTENSIONS.has(path.extname(absolutePath))) {
      results.push(absolutePath);
    }
  });

  results.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
  return results;
}

async function findPackageManifestPaths(root: string): Promise<string[]> {
  const results: string[] = [];

  await walk(root, (absolutePath, entry) => {
    if (entry.isFile() && entry.name === PACKAGE_MANIFEST_FILE) {
      results.push(absolutePath);
    }
  });

  results.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
  return results;
}

async function walk(root: string, onEntry: (absolutePath: string, entry: import("node:fs").Dirent) => void): Promise<void> {
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
          await visit(absolutePath);
        }
        continue;
      }

      onEntry(absolutePath, entry);
    }
  }

  await visit(root);
}

async function extractImportEdges(
  workspace: string,
  filePath: string,
  boundaries: Boundary[],
  compilerOptions: ts.CompilerOptions,
  diagnostics: Diagnostic[],
): Promise<ImportEdge[]> {
  const sourceText = await fs.readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
  const fromFileKind = getFileKind(workspace, filePath);
  const fromBoundary = findBoundaryForFile(workspace, filePath, boundaries);
  const edges: ImportEdge[] = [];

  function addEdge(kind: ImportKind, specifier: string | null, position: number): void {
    const location = sourceFile.getLineAndCharacterOfPosition(position);
    const resolved = specifier ? resolveSpecifier(workspace, filePath, specifier, compilerOptions, diagnostics) : null;

    edges.push({
      from: toWorkspacePath(workspace, filePath),
      to: resolved?.path ?? null,
      kind,
      specifier,
      external: resolved?.external ?? false,
      resolved: Boolean(resolved?.path),
      confidence: specifier ? "high" : "low",
      fromFileKind,
      fromBoundary: fromBoundary?.name ?? null,
      toBoundary: resolved?.path ? findBoundaryForFile(workspace, path.resolve(workspace, resolved.path), boundaries)?.name ?? null : null,
      location: {
        line: location.line + 1,
        column: location.character + 1,
      },
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addEdge(node.importClause?.isTypeOnly ? "type-import" : "import", node.moduleSpecifier.text, node.moduleSpecifier.getStart(sourceFile));
      return;
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addEdge(node.isTypeOnly ? "type-export" : "export", node.moduleSpecifier.text, node.moduleSpecifier.getStart(sourceFile));
      return;
    }

    if (ts.isCallExpression(node)) {
      const firstArg = node.arguments[0];

      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (firstArg && ts.isStringLiteralLike(firstArg)) {
          addEdge("dynamic-import", firstArg.text, firstArg.getStart(sourceFile));
        } else {
          addEdge("dynamic-unknown", null, node.getStart(sourceFile));
        }
        return;
      }

      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        if (firstArg && ts.isStringLiteralLike(firstArg)) {
          addEdge("require", firstArg.text, firstArg.getStart(sourceFile));
        } else {
          addEdge("require-unknown", null, node.getStart(sourceFile));
        }
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return edges;
}

function resolveSpecifier(
  workspace: string,
  containingFile: string,
  specifier: string,
  compilerOptions: ts.CompilerOptions,
  diagnostics: Diagnostic[],
): { path: string | null; external: boolean } {
  const resolved = ts.resolveModuleName(specifier, containingFile, compilerOptions, ts.sys).resolvedModule;

  if (!resolved) {
    const external = !isRelativeSpecifier(specifier);
    if (!external) {
      const fallback = resolveRelativeFileImportFallback(workspace, containingFile, specifier, diagnostics);
      if (fallback) {
        return {
          path: toWorkspacePath(workspace, fallback),
          external: false,
        };
      }
    }

    diagnostics.push({
      severity: external ? "warning" : "error",
      code: external ? "external_module_unresolved" : "relative_module_unresolved",
      message: `Could not resolve import specifier '${specifier}'.`,
      path: toWorkspacePath(workspace, containingFile),
    });
    return { path: null, external };
  }

  const resolvedFileName = path.resolve(resolved.resolvedFileName);

  if (resolved.isExternalLibraryImport || !isInside(workspace, resolvedFileName)) {
    return { path: null, external: true };
  }

  return {
    path: toWorkspacePath(workspace, resolvedFileName),
    external: false,
  };
}

function buildBoundaryEdges(edges: ImportEdge[]): BoundaryEdge[] {
  const byPair = new Map<string, BoundaryEdge>();

  for (const edge of edges) {
    if (!edge.fromBoundary || !edge.toBoundary || edge.fromBoundary === edge.toBoundary || !edge.to) {
      continue;
    }

    const key = `${edge.fromBoundary}\0${edge.toBoundary}`;
    const existing = byPair.get(key) ?? {
      from: edge.fromBoundary,
      to: edge.toBoundary,
      imports: [],
    };

    existing.imports.push({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      fromFileKind: edge.fromFileKind,
      specifier: edge.specifier,
    });
    byPair.set(key, existing);
  }

  return [...byPair.values()].sort((left, right) => {
    const fromCompare = left.from.localeCompare(right.from);
    return fromCompare === 0 ? left.to.localeCompare(right.to) : fromCompare;
  });
}

async function readPackageManifests(
  workspace: string,
  packageManifestPaths: string[],
  boundaries: Boundary[],
  diagnostics: Diagnostic[],
): Promise<PackageManifest[]> {
  const manifests: PackageManifest[] = [];

  for (const manifestPath of packageManifestPaths) {
    const content = await fs.readFile(manifestPath, "utf8");
    let parsed: unknown;

    try {
      parsed = JSON.parse(content);
    } catch (error) {
      diagnostics.push({
        severity: "warning",
        code: "package_manifest_invalid",
        message: `Could not parse package.json for workspace dependency analysis: ${error instanceof Error ? error.message : String(error)}`,
        path: toWorkspacePath(workspace, manifestPath),
      });
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostics.push({
        severity: "warning",
        code: "package_manifest_invalid",
        message: "package.json must contain an object to participate in workspace dependency analysis.",
        path: toWorkspacePath(workspace, manifestPath),
      });
      continue;
    }

    const manifest = parsed as Record<string, unknown>;
    const name = typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : null;

    manifests.push({
      path: manifestPath,
      name,
      boundary: findBoundaryForFile(workspace, manifestPath, boundaries),
      dependencies: extractPackageDependencies(manifest, content),
    });
  }

  return manifests;
}

function extractPackageDependencies(manifest: Record<string, unknown>, content: string): PackageDependency[] {
  const dependencies: PackageDependency[] = [];

  for (const field of PACKAGE_DEPENDENCY_FIELDS) {
    const dependencyTable = manifest[field];
    if (!dependencyTable || typeof dependencyTable !== "object" || Array.isArray(dependencyTable)) {
      continue;
    }

    for (const dependencyName of Object.keys(dependencyTable).sort((left, right) => left.localeCompare(right))) {
      dependencies.push({
        name: dependencyName,
        field,
        location: findJsonPropertyLocation(content, dependencyName),
      });
    }
  }

  return dependencies;
}

function buildWorkspacePackageDependencyEdges(
  workspace: string,
  packageManifests: PackageManifest[],
  diagnostics: Diagnostic[],
): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const packageByName = buildWorkspacePackageNameMap(workspace, packageManifests, diagnostics);

  for (const manifest of packageManifests) {
    if (!manifest.boundary?.name) {
      continue;
    }

    for (const dependency of manifest.dependencies) {
      const target = packageByName.get(dependency.name);

      if (!target?.boundary?.name || target.boundary.name === manifest.boundary.name) {
        continue;
      }

      edges.push({
        from: toWorkspacePath(workspace, manifest.path),
        to: toWorkspacePath(workspace, target.path),
        kind: "workspace-package-dependency",
        specifier: dependency.name,
        external: false,
        resolved: true,
        confidence: "high",
        fromFileKind: "config",
        fromBoundary: manifest.boundary.name,
        toBoundary: target.boundary.name,
        location: dependency.location,
      });
    }
  }

  return edges;
}

function buildWorkspacePackageNameMap(
  workspace: string,
  packageManifests: PackageManifest[],
  diagnostics: Diagnostic[],
): Map<string, PackageManifest> {
  const byName = new Map<string, PackageManifest[]>();

  for (const manifest of packageManifests) {
    if (!manifest.name || !manifest.boundary?.name) {
      continue;
    }

    const matches = byName.get(manifest.name) ?? [];
    matches.push(manifest);
    byName.set(manifest.name, matches);
  }

  const unique = new Map<string, PackageManifest>();

  for (const [packageName, matches] of byName.entries()) {
    if (matches.length === 1) {
      unique.set(packageName, matches[0]);
      continue;
    }

    for (const match of matches) {
      diagnostics.push({
        severity: "warning",
        code: "workspace_package_name_duplicate",
        message: `Workspace package name '${packageName}' is declared by multiple boundary package.json files; manifest dependency edges for this package name are skipped.`,
        path: toWorkspacePath(workspace, match.path),
      });
    }
  }

  return unique;
}

function findJsonPropertyLocation(content: string, propertyName: string): { line: number; column: number } {
  const quotedName = JSON.stringify(propertyName);
  const index = content.indexOf(quotedName);

  if (index === -1) {
    return { line: 1, column: 1 };
  }

  const prefix = content.slice(0, index);
  const lines = prefix.split(/\r?\n/);
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function readTsConfig(workspace: string): { path: string | null; compilerOptions: ts.CompilerOptions } {
  const configPath =
    ts.findConfigFile(workspace, ts.sys.fileExists, "tsconfig.json") ??
    ts.findConfigFile(workspace, ts.sys.fileExists, "jsconfig.json");

  const fallbackOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    moduleResolution: getDefaultModuleResolutionKind(),
    target: ts.ScriptTarget.Latest,
  };

  if (!configPath) {
    return { path: null, compilerOptions: fallbackOptions };
  }

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    return { path: configPath, compilerOptions: fallbackOptions };
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));

  return {
    path: configPath,
    compilerOptions: {
      ...fallbackOptions,
      ...parsed.options,
      allowJs: true,
    },
  };
}

function getDefaultModuleResolutionKind(): ts.ModuleResolutionKind {
  return "Bundler" in ts.ModuleResolutionKind
    ? ts.ModuleResolutionKind.Bundler
    : ts.ModuleResolutionKind.Node10;
}

function getScriptKind(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function getFileKind(workspace: string, filePath: string): FileKind {
  const relativePath = toWorkspacePath(workspace, filePath);
  const basename = path.basename(relativePath).toLowerCase();
  const segments = relativePath.toLowerCase().split("/");

  if (
    segments.includes("__tests__") ||
    segments.includes("test") ||
    segments.includes("tests") ||
    basename.includes(".test.") ||
    basename.includes(".spec.")
  ) {
    return "test";
  }

  if (
    basename.endsWith(".config.ts") ||
    basename.endsWith(".config.js") ||
    basename.endsWith(".config.mjs") ||
    basename.endsWith(".config.cjs")
  ) {
    return "config";
  }

  return "source";
}

function findBoundaryForFile(workspace: string, filePath: string, boundaries: Boundary[]): Boundary | null {
  const absoluteFilePath = path.resolve(filePath);
  const sorted = [...boundaries].sort((left, right) => right.root.length - left.root.length);

  for (const boundary of sorted) {
    const absoluteRoot = path.resolve(workspace, boundary.root);
    if (isInside(absoluteRoot, absoluteFilePath)) {
      return boundary;
    }
  }

  return null;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..";
}

function resolveRelativeFileImportFallback(
  workspace: string,
  containingFile: string,
  specifier: string,
  diagnostics: Diagnostic[],
): string | null {
  const cleanSpecifier = stripImportSuffix(specifier);
  if (!cleanSpecifier) {
    return null;
  }

  const basePath = path.resolve(path.dirname(containingFile), cleanSpecifier);
  const candidates = candidateRelativeImportPaths(basePath);
  const existing = candidates
    .filter((candidate) => fileExists(candidate))
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => isInside(workspace, candidate));

  if (existing.length === 0) {
    return null;
  }

  const unique = [...new Set(existing)];
  if (unique.length > 1) {
    diagnostics.push({
      severity: "warning",
      code: "relative_module_fallback_ambiguous",
      message: `Multiple local files match import specifier '${specifier}'. Using '${toWorkspacePath(workspace, unique[0])}'.`,
      path: toWorkspacePath(workspace, containingFile),
    });
  }

  return unique[0];
}

function candidateRelativeImportPaths(basePath: string): string[] {
  const candidates: string[] = [basePath];
  const extension = path.extname(basePath);

  if (!extension) {
    for (const candidateExtension of RELATIVE_IMPORT_FALLBACK_EXTENSIONS) {
      candidates.push(`${basePath}${candidateExtension}`);
    }
  }

  if (directoryExists(basePath)) {
    for (const candidateExtension of RELATIVE_IMPORT_FALLBACK_EXTENSIONS) {
      candidates.push(path.join(basePath, `index${candidateExtension}`));
    }
  }

  return candidates;
}

function stripImportSuffix(specifier: string): string {
  const queryIndex = specifier.indexOf("?");
  const hashIndex = specifier.indexOf("#");
  const indexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  const endIndex = indexes.length > 0 ? Math.min(...indexes) : specifier.length;
  return specifier.slice(0, endIndex);
}

function fileExists(filePath: string): boolean {
  return ts.sys.fileExists(filePath);
}

function directoryExists(filePath: string): boolean {
  return ts.sys.directoryExists?.(filePath) ?? false;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
