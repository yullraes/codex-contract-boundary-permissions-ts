# Permissions

Read this only when merging or validating generated permission candidates in active `.codex/config.toml`.

## Source Files

- `.codex/dependency-graph.json`: Markdown contract graph source for permission calculation.
- `.codex/generated-permissions.toml`: merge candidate; Codex does not apply it automatically.
- `.codex/config.toml`: active project config.
- `.codex/tools/contract-boundary-permissions`: workspace-local tool root used for validation.

## Merge Rules

- Do not overwrite existing `.codex/config.toml`.
- Preserve model, MCP, hooks, and user-defined settings.
- Merge or replace only generated `[permissions.agent-*]` profiles.
- Change `default_permissions` only when explicitly requested or when setup policy chooses a boundary.
- Do not use `extends` in generated profiles; the validator cannot prove inherited permissions safe.

## Required Invariants

- Workspace root is `read`.
- Owner boundary root is `write`.
- External boundary roots are `deny`.
- Only body-linked direct dependency boundary `contractFiles` and `publicArtifacts` are reopened as `read`.
- Non-dependency boundary contract files stay `deny`.
- External boundary source and internal docs are not reopened.
- `.codex` is not writable.
- Sensitive globs are `deny`.
- `default_permissions = ":danger-full-access"` and `sandbox_mode = "danger-full-access"` fail validation.

## Validation

```text
node <workspace>/.codex/tools/contract-boundary-permissions/src/validate-codex-permissions.ts <workspace> --graph <workspace>/.codex/dependency-graph.json --config <workspace>/.codex/config.toml
```

Interpret diagnostics by effective access semantics, not TOML string equality.
