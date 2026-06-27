# Setup

Read this only when applying contract-boundary Codex permission automation to an existing workspace.

## Preconditions

- Boundary entrypoint documents declare `contract_scope: boundary` and `name`.
- Public contract documents linked from boundary contract sections declare `contract_scope: public`.
- Internal documents declare `contract_scope: internal`.
- External dependencies are linked from body sections such as `External Contracts` or `Dependencies`.
- The target project owns its public entrypoint/deep import policy through lint/review/CI.

Frontmatter 없는 Markdown은 즉시 error가 아닙니다. It remains legacy/unclassified and does not participate in the contract graph.

Missing frontmatter becomes an error only when a boundary document links that Markdown file from a contract section such as `Contract Documents`, `Contracts`, or `Public Contract Documents`. A document referenced as a contract must explicitly declare `contract_scope`.

Post-implementation contract document updates are not part of this permission setup skill. Implementation sessions should follow the target project's own prompt/review/check guidance when deciding whether a changed Markdown document needs `contract_scope` or updated body links.

## Execution Model

The plugin provides the skill, hook source, and deterministic tool primitives. The canonical runtime is the target workspace, not the installed plugin cache.

Before running setup commands, wire the primitives into the target workspace with this layout:

```text
<workspace>/.codex/tools/contract-boundary-permissions/
  hooks/pre-commit.mjs
  scripts/
  src/
```

In the commands below, `<tool-root>` means `<workspace>/.codex/tools/contract-boundary-permissions`.

## Steps

1. Check contract graph state.

```text
node <tool-root>/scripts/scan-boundaries.mjs <workspace> --pretty
```

2. Generate graph and generated metadata.

```text
node <tool-root>/scripts/refresh-generated.mjs <workspace> --write
```

This refreshes `.codex/boundaries.json`, `.codex/dependency-graph.json`, and `.codex/rules/generated.rules`. It does not edit `.codex/config.toml`.

3. Generate the permission candidate.

```text
node <tool-root>/src/generate-codex-permissions.ts <workspace> --graph <workspace>/.codex/dependency-graph.json --out <workspace>/.codex/generated-permissions.toml
```

Add `--default-boundary <name>` only when the default profile is explicitly chosen.

4. Merge `.codex/generated-permissions.toml` into active `.codex/config.toml` using `permissions.md`.

5. Validate the merged config.

```text
node <tool-root>/src/validate-codex-permissions.ts <workspace> --graph <workspace>/.codex/dependency-graph.json --config <workspace>/.codex/config.toml
```

6. Install the rendered pre-commit hook into the target repository `.git/hooks/pre-commit`.

## Notes

- Generated permission TOML is a candidate, not active config.
- Preserve existing model, MCP, hooks, and user-defined settings in `.codex/config.toml`.
- The paired pre-commit hook checks generated freshness, contract scan diagnostics, and active config validation in fail-only mode before commit.
- Do not instruct users to run setup from `npm --prefix <plugin-cache>`; that path is not the target workspace runtime.



