import { promises as fs } from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = "0.2.0";
export const README_FILE = "README.md";
export const CONTRACT_DOC_EXTENSIONS = new Set([".md", ".mdx"]);
export const PUBLIC_ARTIFACTS_KEY = "public_artifacts";
export const CONTRACT_DOCUMENT_SECTION_HEADINGS = new Set([
  "contracts",
  "contract details",
  "contract documents",
  "public contract documents",
  "public contracts",
  "계약 문서",
  "공개 계약 문서",
]);
export const EXTERNAL_CONTRACT_SECTION_HEADINGS = new Set([
  "dependencies",
  "external contracts",
  "external contract dependencies",
  "required contracts",
  "uses",
  "외부 계약",
  "외부 계약 문서",
  "외부 의존",
  "의존 계약",
]);
export const PUBLIC_ARTIFACT_SECTION_HEADINGS = new Set([
  "public artifacts",
  "artifacts",
  "public files",
  "공개 artifact",
  "공개 아티팩트",
  "공개 파일",
]);
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

export async function findMarkdownDocuments(root) {
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

      if (entry.isFile() && CONTRACT_DOC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(absolutePath);
      }
    }
  }

  await visit(root);
  results.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
  return results;
}

export async function findReadmes(root) {
  const documents = await findMarkdownDocuments(root);
  return documents.filter((documentPath) => path.basename(documentPath) === README_FILE);
}

export async function scanBoundaryContracts(workspace, documents) {
  const records = [];
  const contractsByPath = new Map();
  const boundaries = [];
  const diagnostics = [];

  for (const documentPath of documents) {
    const content = await fs.readFile(documentPath, "utf8");
    const frontmatter = parseFrontmatter(content);
    const contractScope = frontmatter?.contract_scope ?? null;
    const relativePath = toWorkspacePath(workspace, documentPath);
    const rootPath = path.dirname(documentPath);
    const relativeRoot = toWorkspacePath(workspace, rootPath);

    const record = {
      absolutePath: documentPath,
      content,
      frontmatter,
      contractScope,
      relativePath,
      rootPath,
      relativeRoot,
    };
    records.push(record);

    if (!frontmatter || !contractScope) {
      continue;
    }

    const contract = {
      contractScope,
      name: typeof frontmatter.name === "string" ? frontmatter.name : null,
      root: relativeRoot,
      readme: relativePath,
      path: relativePath,
      metadata: frontmatter,
    };
    addContract(contractsByPath, contract);

    if (contractScope === "boundary") {
      if (!contract.name) {
        diagnostics.push({
          severity: "error",
          code: "boundary_name_missing",
          message: "Boundary contract document must declare a non-empty name.",
          path: relativePath,
        });
      }

      boundaries.push({
        name: contract.name,
        root: relativeRoot,
        readme: relativePath,
        entrypoint: relativePath,
        contractFiles: [relativePath],
        publicArtifacts: [],
        dependencies: [],
        dependencyLinks: [],
        contractScope,
        metadata: frontmatter,
      });
      continue;
    }

    if (contractScope !== "public" && contractScope !== "internal") {
      diagnostics.push({
        severity: "warning",
        code: "unknown_contract_scope",
        message: `Unknown contract_scope '${contractScope}'. Expected 'boundary', 'public', or 'internal'.`,
        path: relativePath,
      });
    }
  }

  diagnostics.push(...findDuplicateBoundaryNames(boundaries));

  for (const record of records) {
    if (!record.frontmatter || !record.contractScope || record.contractScope === "boundary") {
      continue;
    }

    const owner = findBoundaryForPath(boundaries, record.relativePath);
    if (owner) {
      const contract = contractsByPath.get(record.relativePath);
      if (contract) {
        contract.boundary = owner.name;
      }
    }
  }

  for (const boundary of boundaries) {
    const record = records.find((item) => item.relativePath === boundary.readme);
    if (!record) {
      continue;
    }

    const linkedContracts = await collectLinkedContractDocs({
      workspace,
      boundary,
      boundaryRoot: record.rootPath,
      documentPath: record.absolutePath,
      documentContent: record.content,
      contractsByPath,
      diagnostics,
    });
    const publicArtifacts = await collectPublicArtifacts({
      workspace,
      boundaryRoot: record.rootPath,
      documentPath: record.absolutePath,
      documentContent: record.content,
      frontmatter: record.frontmatter,
      diagnostics,
    });

    boundary.contractFiles = [boundary.readme, ...linkedContracts.publicFiles];
    boundary.publicArtifacts = publicArtifacts;
  }

  for (const boundary of boundaries) {
    const record = records.find((item) => item.relativePath === boundary.readme);
    if (!record) {
      continue;
    }

    const dependencyResult = await collectBoundaryDependencies({
      workspace,
      boundary,
      boundaries,
      documentPath: record.absolutePath,
      documentContent: record.content,
      diagnostics,
    });
    boundary.dependencies = dependencyResult.dependencies;
    boundary.dependencyLinks = dependencyResult.links;
  }

  if (boundaries.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "no_boundaries_found",
      message: "No Markdown documents declared contract_scope: boundary.",
      path: ".",
    });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    workspace: normalizePath(workspace),
    boundaries,
    contracts: [...contractsByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    diagnostics,
  };
}

function addContract(contractsByPath, contract) {
  const existing = contractsByPath.get(contract.path);
  contractsByPath.set(contract.path, existing ? { ...existing, ...contract, boundary: contract.boundary ?? existing.boundary } : contract);
}

async function collectLinkedContractDocs({
  workspace,
  boundary,
  boundaryRoot,
  documentPath,
  documentContent,
  contractsByPath,
  diagnostics,
}) {
  const publicFiles = [];
  const seen = new Set([toWorkspacePath(workspace, documentPath)]);
  const targets = extractMarkdownLinkTargetsFromSections(documentContent, CONTRACT_DOCUMENT_SECTION_HEADINGS);

  for (const target of targets) {
    if (!isLocalMarkdownTarget(target)) {
      continue;
    }

    const targetPath = path.resolve(path.dirname(documentPath), stripMarkdownTargetSuffix(target));
    const relativeTarget = toWorkspacePath(workspace, targetPath);

    if (seen.has(relativeTarget)) {
      continue;
    }
    seen.add(relativeTarget);

    if (!isInside(boundaryRoot, targetPath)) {
      diagnostics.push({
        severity: "error",
        code: "contract_doc_outside_boundary",
        message: "Boundary contract document sections may only link contract documents inside the boundary root.",
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
        message: "Boundary contract document section links to a missing contract document.",
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

    const contract = {
      contractScope,
      name: typeof frontmatter.name === "string" ? frontmatter.name : null,
      boundary: boundary.name,
      root: toWorkspacePath(workspace, path.dirname(targetPath)),
      path: relativeTarget,
      metadata: frontmatter,
    };
    addContract(contractsByPath, contract);

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
  return { publicFiles };
}

async function collectPublicArtifacts({
  workspace,
  boundaryRoot,
  documentPath,
  documentContent,
  frontmatter,
  diagnostics,
}) {
  const publicArtifacts = [];
  const seen = new Set();
  const entries = [
    ...frontmatterPublicArtifacts(frontmatter, workspace, documentPath, diagnostics),
    ...extractMarkdownLinkTargetsFromSections(documentContent, PUBLIC_ARTIFACT_SECTION_HEADINGS),
  ];

  for (const entry of entries) {
    const target = stripMarkdownTargetSuffix(entry.trim());
    if (!isLocalArtifactTarget(target)) {
      diagnostics.push({
        severity: "error",
        code: "public_artifact_invalid",
        message: "Public artifact entries must be relative file paths, not URLs, anchors, or absolute paths.",
        path: toWorkspacePath(workspace, documentPath),
      });
      continue;
    }

    if (CONTRACT_DOC_EXTENSIONS.has(path.extname(target).toLowerCase())) {
      diagnostics.push({
        severity: "error",
        code: "public_artifact_markdown",
        message: "Markdown contract documents must be listed in contract document sections and declare contract_scope instead of being public artifacts.",
        path: toWorkspacePath(workspace, documentPath),
      });
      continue;
    }

    const targetPath = path.resolve(path.dirname(documentPath), target);
    const relativeTarget = toWorkspacePath(workspace, targetPath);

    if (seen.has(relativeTarget)) {
      continue;
    }
    seen.add(relativeTarget);

    if (!isInside(boundaryRoot, targetPath)) {
      diagnostics.push({
        severity: "error",
        code: "public_artifact_outside_boundary",
        message: "Public artifacts must stay inside the boundary root.",
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
        message: "Public artifact entry points to a missing file.",
        path: relativeTarget,
      });
      continue;
    }

    if (!stats.isFile()) {
      diagnostics.push({
        severity: "error",
        code: "public_artifact_not_file",
        message: "Public artifacts must point to files.",
        path: relativeTarget,
      });
      continue;
    }

    publicArtifacts.push(relativeTarget);
  }

  publicArtifacts.sort((left, right) => left.localeCompare(right));
  return publicArtifacts;
}

function frontmatterPublicArtifacts(frontmatter, workspace, documentPath, diagnostics) {
  const entries = frontmatter?.[PUBLIC_ARTIFACTS_KEY];

  if (entries === undefined) {
    return [];
  }

  if (!Array.isArray(entries)) {
    diagnostics.push({
      severity: "error",
      code: "public_artifacts_invalid",
      message: "Boundary contract document public_artifacts must be a frontmatter list of workspace-local files.",
      path: toWorkspacePath(workspace, documentPath),
    });
    return [];
  }

  const valid = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.trim()) {
      diagnostics.push({
        severity: "error",
        code: "public_artifact_invalid",
        message: "public_artifacts entries must be non-empty relative file paths.",
        path: toWorkspacePath(workspace, documentPath),
      });
      continue;
    }
    valid.push(entry);
  }
  return valid;
}

async function collectBoundaryDependencies({
  workspace,
  boundary,
  boundaries,
  documentPath,
  documentContent,
  diagnostics,
}) {
  const dependencyNames = new Set();
  const links = [];
  const seenTargets = new Set();
  const targets = extractMarkdownLinkTargetsFromSections(documentContent, EXTERNAL_CONTRACT_SECTION_HEADINGS);

  for (const target of targets) {
    if (!isLocalMarkdownTarget(target)) {
      continue;
    }

    const targetPath = path.resolve(path.dirname(documentPath), stripMarkdownTargetSuffix(target));
    const relativeTarget = toWorkspacePath(workspace, targetPath);

    if (seenTargets.has(relativeTarget)) {
      continue;
    }
    seenTargets.add(relativeTarget);

    let stats;
    try {
      stats = await fs.stat(targetPath);
    } catch {
      diagnostics.push({
        severity: "error",
        code: "boundary_dependency_missing",
        message: "External contract section links to a missing contract document.",
        path: relativeTarget,
      });
      continue;
    }

    if (!stats.isFile()) {
      diagnostics.push({
        severity: "error",
        code: "boundary_dependency_not_file",
        message: "External contract section must link to contract document files.",
        path: relativeTarget,
      });
      continue;
    }

    const targetBoundary = findBoundaryForPublicTarget(boundaries, relativeTarget);
    if (!targetBoundary) {
      diagnostics.push({
        severity: "error",
        code: "boundary_dependency_unknown",
        message: "External contract section links to a document that is not another boundary entrypoint or public contract document.",
        path: relativeTarget,
      });
      continue;
    }

    if (targetBoundary.name === boundary.name) {
      diagnostics.push({
        severity: "warning",
        code: "boundary_dependency_self",
        message: "External contract section links to its own boundary; self dependency is ignored.",
        path: relativeTarget,
      });
      continue;
    }

    if (!targetBoundary.name) {
      continue;
    }

    dependencyNames.add(targetBoundary.name);
    links.push({ boundary: targetBoundary.name, path: relativeTarget });
  }

  return {
    dependencies: [...dependencyNames].sort((left, right) => left.localeCompare(right)),
    links: links.sort((left, right) => left.boundary.localeCompare(right.boundary) || left.path.localeCompare(right.path)),
  };
}

function findBoundaryForPublicTarget(boundaries, relativeTarget) {
  return boundaries
    .filter((boundary) => isSameOrChildPath(boundary.root, relativeTarget))
    .sort((left, right) => right.root.length - left.root.length)
    .find((boundary) => readableFilesForBoundary(boundary).includes(relativeTarget)) ?? null;
}

function findBoundaryForPath(boundaries, relativePath) {
  return boundaries
    .filter((boundary) => isSameOrChildPath(boundary.root, relativePath))
    .sort((left, right) => right.root.length - left.root.length)[0] ?? null;
}

function readableFilesForBoundary(boundary) {
  return [...new Set([
    ...(Array.isArray(boundary.contractFiles) && boundary.contractFiles.length > 0 ? boundary.contractFiles : [boundary.readme]),
    ...(Array.isArray(boundary.publicArtifacts) ? boundary.publicArtifacts : []),
  ])];
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

function extractMarkdownLinkTargetsFromSections(content, headings) {
  const targets = [];
  const lines = content.split(/\r?\n/);
  let activeLevel = null;
  let activeContent = [];

  function flush() {
    if (activeLevel === null) {
      return;
    }
    targets.push(...extractMarkdownLinkTargets(activeContent.join("\n")));
    activeContent = [];
  }

  for (const line of lines) {
    const heading = parseAtxHeading(line);
    if (heading) {
      if (activeLevel !== null && heading.level <= activeLevel) {
        flush();
        activeLevel = null;
      }

      if (activeLevel === null && headings.has(normalizeHeadingText(heading.text))) {
        activeLevel = heading.level;
        activeContent = [];
      } else if (activeLevel !== null) {
        activeContent.push(line);
      }
      continue;
    }

    if (activeLevel !== null) {
      activeContent.push(line);
    }
  }

  flush();
  return targets;
}

function parseAtxHeading(line) {
  const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (!match) {
    return null;
  }

  return {
    level: match[1].length,
    text: match[2],
  };
}

function normalizeHeadingText(value) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
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

export function isSameOrChildPath(parent, child) {
  const relative = path.posix.relative(normalizePath(parent), normalizePath(child));
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative));
}

export function normalizePath(value) {
  return value.replaceAll(path.sep, "/");
}
