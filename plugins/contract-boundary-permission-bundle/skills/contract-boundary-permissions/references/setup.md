# Setup

Read this only when applying contract-boundary Codex permission automation to an existing JS/TS workspace.

## Preconditions

- Each responsibility boundary root has a `README.md`.
- Boundary README frontmatter declares `contract_scope: boundary` and `name`.
- Public contract documents linked from a boundary README declare `contract_scope: public`.
- Internal documents declare `contract_scope: internal`.
- The workspace's dependency graph can be described from JS/TS imports.
- The target workspace provides TypeScript resolution for the analyzer.
- The target project lint command owns public entrypoint and deep import policy.

## Execution Model

The plugin provides the skill, hook source, and deterministic tool primitives. The canonical runtime is the target workspace, not the installed plugin cache.

Before running setup commands, wire the primitives into the target workspace with this layout:

```text
<workspace>/.codex/tools/contract-boundary-permissions/
  hooks/stop-checks.mjs
  scripts/
  src/
```

In the commands below, `<tool-root>` means `<workspace>/.codex/tools/contract-boundary-permissions`.

Optional target `package.json` scripts may point at `<tool-root>`:

```json
{
  "scripts": {
    "scan:boundaries": "node .codex/tools/contract-boundary-permissions/scripts/scan-boundaries.mjs",
    "analyze:imports": "node .codex/tools/contract-boundary-permissions/src/analyze-js-ts-imports.ts",
    "refresh:generated": "node .codex/tools/contract-boundary-permissions/scripts/refresh-generated.mjs",
    "check:generated": "node .codex/tools/contract-boundary-permissions/scripts/refresh-generated.mjs --check",
    "generate:permissions": "node .codex/tools/contract-boundary-permissions/src/generate-codex-permissions.ts",
    "generate:rules": "node .codex/tools/contract-boundary-permissions/src/generate-codex-rules.ts",
    "validate:permissions": "node .codex/tools/contract-boundary-permissions/src/validate-codex-permissions.ts",
    "hook:contract-boundary-stop": "node .codex/tools/contract-boundary-permissions/hooks/stop-checks.mjs"
  }
}
```

If these scripts are not present, run the direct `node <tool-root>/...` commands shown below.

## Steps

1. Check boundary contract state.

```text
node <tool-root>/scripts/scan-boundaries.mjs <workspace> --pretty
```

2. Run the target project's lint command when one is available. This bundle does not create or replace import policy.

3. Generate graph and generated metadata.

```text
node <tool-root>/scripts/refresh-generated.mjs <workspace> --write
```

This refreshes `.codex/boundaries.json`, `.codex/dependency-graph.json`, and `.codex/rules/generated.rules`. It does not edit `.codex/config.toml`.

4. Generate the permission candidate.

```text
node <tool-root>/src/generate-codex-permissions.ts <workspace> --graph <workspace>/.codex/dependency-graph.json --out <workspace>/.codex/generated-permissions.toml
```

Add `--default-boundary <name>` only when the default profile is explicitly chosen.

5. Merge `.codex/generated-permissions.toml` into active `.codex/config.toml` using `permissions.md`.

6. Validate the merged config.

```text
node <tool-root>/src/validate-codex-permissions.ts <workspace> --graph <workspace>/.codex/dependency-graph.json --config <workspace>/.codex/config.toml
```

7. Activate the Stop hook by merging the hook config for the target Codex surface.

The bundled hook config points at:

```text
<workspace>/.codex/tools/contract-boundary-permissions/hooks/stop-checks.mjs
```

The hook also receives `--tool-root <workspace>/.codex/tools/contract-boundary-permissions` so it does not depend on plugin cache paths.

## Notes

- Generated permission TOML is a candidate, not active config.
- Preserve existing model, MCP, hooks, and user-defined settings in `.codex/config.toml`.
- The paired `Stop` hook later checks generated freshness, contract scan diagnostics, and active config validation in fail-only mode.
- Do not instruct users to run setup from `npm --prefix <plugin-cache>`; that path is not the target workspace runtime.
