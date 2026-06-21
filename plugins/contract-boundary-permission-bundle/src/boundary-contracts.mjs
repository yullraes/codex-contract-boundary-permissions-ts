import { promises as fs } from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = "0.1.0";
export const README_FILE = "README.md";
export const CONTRACT_DOC_EXTENSIONS = new Set([".md", ".mdx"]);
export const PUBLIC_ARTIFACTS_KEY = "public_artifacts";
export const DEFAULT_EXCLUDED_DIRS = new Set([
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

export async function findReadmes(root) {
  const results = [];

  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
          await visit(absolutePath);
        }
        continue;
      }

      if (entry.isFile() && entry.name === README_FILE) {
        results.push(absolutePath);
      }
    }
  }

  await visit(root);
  results.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
  return results;
}

export async function scanBoundaryContracts(workspace, readmes) {
  const contracts = [];
  const boundaries = [];
  const diagnostics = [];

  for (const readmePath of readmes) {
    const content = await fs.readFile(readmePath, "utf8");
    const frontmatter = parseFrontmatter(content);
    const contractScope = frontmatter?.contract_scope ?? null;
    const relativeReadme = toWorkspacePath(workspace, readmePath);
    const rootPath = path.dirname(readmePath);
    const relativeRoot = toWorkspacePath(workspace, rootPath);

    if (!frontmatter || !contractScope) {
      continue;
    }

    const contract = {
      contractScope,
      name: typeof frontmatter.name === "string" ? frontmatter.name : null,
      root: relativeRoot,
      readme: relativeReadme,
      path: relativeReadme,
      metadata: frontmatter,
    };
    contracts.push(contract);

    if (contractScope === "boundary") {
      if (!contract.name) {
        diagnostics.push({
          severity: "error",
          code: "boundary_name_missing",
          message: "Boundary README must declare a non-empty name.",
          path: relativeReadme,
        });
      }

      const linked = await collectLinkedContractDocs({
        workspace,
        boundaryRoot: rootPath,
        readmePath,
        readmeContent: content,
        boundaryName: contract.name,
        diagnostics,
      });
      const publicArtifacts = await collectPublicArtifacts({
        workspace,
        boundaryRoot: rootPath,
        readmePath,
        frontmatter,
        diagnostics,
      });
      contracts.push(...linked.contracts);

      boundaries.push({
        name: contract.name,
        root: relativeRoot,
        readme: relativeReadme,
        contractFiles: [relativeReadme, ...linked.publicFiles],
        publicArtifacts,
        contractScope,
        metadata: frontmatter,
      });
      continue;
    }

    if (contractScope !== "internal") {
      diagnostics.push({
        severity: "warning",
        code: "unknown_contract_scope",
        message: `Unknown contract_scope '${contractScope}'. Expected 'boundary' or 'internal'.`,
        path: relativeReadme,
      });
    }
  }

  diagnostics.push(...findDuplicateBoundaryNames(boundaries));

  if (boundaries.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "no_boundaries_found",
      message: "No README.md files declared contract_scope: boundary.",
      path: ".",
    });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    workspace: normalizePath(workspace),
    boundaries,
    contracts,
    diagnostics,
  };
}

async function collectLinkedContractDocs({
  workspace,
  boundaryRoot,
  readmePath,
  readmeContent,
  boundaryName,
  diagnostics,
}) {
  const publicFiles = [];
  const contracts = [];
  const seen = new Set([toWorkspacePath(workspace, readmePath)]);
  const targets = extractMarkdownLinkTargets(readmeContent);

  for (const target of targets) {
    if (!isLocalMarkdownTarget(target)) {
      continue;
    }

    const targetPath = path.resolve(path.dirname(readmePath), stripMarkdownTargetSuffix(target));
    const relativeTarget = toWorkspacePath(workspace, targetPath);

    if (seen.has(relativeTarget)) {
      continue;
    }
    seen.add(relativeTarget);

    if (!isInside(boundaryRoot, targetPath)) {
      diagnostics.push({
        severity: "error",
        code: "contract_doc_outside_boundary",
        message: "Boundary README links to a contract document outside its boundary root.",
        path: relativeTarget,
      });
      continue;
    }

    let targetContent;
    try {
      targetContent = await fs.readFile(targetPath, "utf8");
    } catch {
      diagnostics.push({
        severity: "error",
        code: "contract_doc_missing",
        message: "Boundary README links to a missing contract document.",
        path: relativeTarget,
      });
      continue;
    }

    const frontmatter = parseFrontmatter(targetContent);
    const contractScope = frontmatter?.contract_scope ?? null;

    if (!frontmatter || !contractScope) {
      diagnostics.push({
        severity: "error",
        code: "contract_doc_scope_missing",
        message: "Linked contract document must declare contract_scope frontmatter.",
        path: relativeTarget,
      });
      continue;
    }

    contracts.push({
      contractScope,
      name: typeof frontmatter.name === "string" ? frontmatter.name : null,
      boundary: boundaryName,
      root: toWorkspacePath(workspace, path.dirname(targetPath)),
      path: relativeTarget,
      metadata: frontmatter,
    });

    if (contractScope === "public") {
      publicFiles.push(relativeTarget);
      continue;
    }

    if (contractScope !== "internal") {
      diagnostics.push({
        severity: "warning",
        code: "unknown_contract_scope",
        message: `Unknown contract_scope '${contractScope}'. Expected 'public' or 'internal' for linked contract documents.`,
        path: relativeTarget,
      });
    }
  }

  publicFiles.sort((left, right) => left.localeCompare(right));
  return { publicFiles, contracts };
}

async function collectPublicArtifacts({
  workspace,
  boundaryRoot,
  readmePath,
  frontmatter,
  diagnostics,
}) {
  const publicArtifacts = [];
  const seen = new Set();
  const entries = frontmatter?.[PUBLIC_ARTIFACTS_KEY];

  if (entries === undefined) {
    return publicArtifacts;
  }

  if (!Array.isArray(entries)) {
    diagnostics.push({
      severity: "error",
      code: "public_artifacts_invalid",
      message: "Boundary README public_artifacts must be a frontmatter list of workspace-local files.",
      path: toWorkspacePath(workspace, readmePath),
    });
    return publicArtifacts;
  }

  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.trim()) {
      diagnostics.push({
        severity: "error",
        code: "public_artifact_invalid",
        message: "public_artifacts entries must be non-empty relative file paths.",
        path: toWorkspacePath(workspace, readmePath),
      });
      continue;
    }

    const target = stripMarkdownTargetSuffix(entry.trim());
    if (!isLocalArtifactTarget(target)) {
      diagnostics.push({
        severity: "error",
        code: "public_artifact_invalid",
        message: "public_artifacts entries must be relative file paths, not URLs, anchors, or absolute paths.",
        path: toWorkspacePath(workspace, readmePath),
      });
      continue;
    }

    if (CONTRACT_DOC_EXTENSIONS.has(path.extname(target).toLowerCase())) {
      diagnostics.push({
        severity: "error",
        code: "public_artifact_markdown",
        message: "Markdown contract documents must be linked from the README and declare contract_scope instead of using public_artifacts.",
        path: toWorkspacePath(workspace, readmePath),
      });
      continue;
    }

    const targetPath = path.resolve(path.dirname(readmePath), target);
    const relativeTarget = toWorkspacePath(workspace, targetPath);

    if (seen.has(relativeTarget)) {
      continue;
    }
    seen.add(relativeTarget);

    if (!isInside(boundaryRoot, targetPath)) {
      diagnostics.push({
        severity: "error",
        code: "public_artifact_outside_boundary",
        message: "public_artifacts entries must stay inside the boundary root.",
        path: relativeTarget,
      });
      continue;
    }

    let stats;
    try {
      stats = await fs.stat(targetPath);
    } catch {
      diagnostics.push({
        severity: "error",
        code: "public_artifact_missing",
        message: "public_artifacts entry points to a missing file.",
        path: relativeTarget,
      });
      continue;
    }

    if (!stats.isFile()) {
      diagnostics.push({
        severity: "error",
        code: "public_artifact_not_file",
        message: "public_artifacts entries must point to files.",
        path: relativeTarget,
      });
      continue;
    }

    publicArtifacts.push(relativeTarget);
  }

  publicArtifacts.sort((left, right) => left.localeCompare(right));
  return publicArtifacts;
}

function extractMarkdownLinkTargets(content) {
  const targets = [];
  const pattern = /(!?)\[[^\]]*]\(([^)]+)\)/g;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    const isImage = match[1] === "!";
    if (isImage) {
      continue;
    }

    const target = normalizeMarkdownLinkTarget(match[2]);
    if (target) {
      targets.push(target);
    }
  }

  return targets;
}

function normalizeMarkdownLinkTarget(rawTarget) {
  const trimmed = rawTarget.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end > 1 ? trimmed.slice(1, end) : null;
  }

  return trimmed.split(/\s+/)[0] ?? null;
}

function stripMarkdownTargetSuffix(target) {
  const withoutHash = target.split("#")[0];
  return withoutHash.split("?")[0];
}

function isLocalMarkdownTarget(target) {
  const cleanTarget = stripMarkdownTargetSuffix(target);

  if (!cleanTarget || cleanTarget.startsWith("#")) {
    return false;
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(cleanTarget) || cleanTarget.startsWith("//")) {
    return false;
  }

  if (path.isAbsolute(cleanTarget) || cleanTarget.startsWith("/")) {
    return false;
  }

  return CONTRACT_DOC_EXTENSIONS.has(path.extname(cleanTarget).toLowerCase());
}

function isLocalArtifactTarget(target) {
  if (!target || target.startsWith("#")) {
    return false;
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("//")) {
    return false;
  }

  if (path.isAbsolute(target) || target.startsWith("/")) {
    return false;
  }

  return true;
}

function findDuplicateBoundaryNames(boundaries) {
  const diagnostics = [];
  const byName = new Map();

  for (const boundary of boundaries) {
    if (!boundary.name) {
      continue;
    }

    const existing = byName.get(boundary.name) ?? [];
    existing.push(boundary);
    byName.set(boundary.name, existing);
  }

  for (const [name, matches] of byName.entries()) {
    if (matches.length <= 1) {
      continue;
    }

    for (const boundary of matches) {
      diagnostics.push({
        severity: "error",
        code: "duplicate_boundary_name",
        message: `Boundary name '${name}' is declared more than once.`,
        path: boundary.readme,
      });
    }
  }

  return diagnostics;
}

export function parseFrontmatter(content) {
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);

  if (lines[0]?.trim() !== "---") {
    return null;
  }

  const metadata = {};
  let pendingListKey = null;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.trim() === "---") {
      return metadata;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (pendingListKey && /^\s*-\s+/.test(line)) {
      metadata[pendingListKey].push(parseScalar(trimmed.slice(1)));
      continue;
    }

    pendingListKey = null;

    const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    if (match[2] === "") {
      metadata[match[1]] = [];
      pendingListKey = match[1];
      continue;
    }

    metadata[match[1]] = parseScalar(match[2]);
  }

  return null;
}

function parseScalar(value) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  return trimmed;
}

export function toWorkspacePath(workspace, absolutePath) {
  const relative = path.relative(workspace, absolutePath);

  if (!relative) {
    return ".";
  }

  return normalizePath(relative);
}

export function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizePath(value) {
  return value.replaceAll(path.sep, "/");
}
