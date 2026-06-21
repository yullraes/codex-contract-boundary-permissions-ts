# Review

Read this only when reviewing permission setup or config changes.

## Review Focus

Lead with findings.

- `.codex/config.toml` preserves existing model, MCP, hooks, and user-defined settings.
- Generated permission profile names match graph-derived names.
- Only owner boundaries are writable.
- External boundary roots are denied by default.
- No external path is reopened except direct dependency `contractFiles` and `publicArtifacts`.
- `.codex` and sensitive globs are not loosened.
- No `danger-full-access` posture is introduced.

## Out Of Scope

- Contract document freshness is handled by `scan:boundaries` diagnostics and the paired `Stop` hook.
- Generated metadata freshness is handled by `check:generated` through the paired hook.
- Public entrypoint and deep import policy belong to the target project's lint rule.

## Suggested Verification

```text
node <workspace>/.codex/tools/contract-boundary-permissions/src/validate-codex-permissions.ts <workspace> --graph <workspace>/.codex/dependency-graph.json --config <workspace>/.codex/config.toml
```

If the target workspace added package scripts that point at `.codex/tools/contract-boundary-permissions`, `npm run validate:permissions -- ...` is equivalent.
