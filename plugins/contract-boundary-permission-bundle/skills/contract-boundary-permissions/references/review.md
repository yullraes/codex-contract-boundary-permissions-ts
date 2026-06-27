# Review

Read this only when reviewing permission setup or config changes.

## Review Focus

Lead with findings.

- `.codex/config.toml` preserves existing model, MCP, hooks, and user-defined settings.
- Generated permission profile names match contract graph-derived names.
- Only owner boundaries are writable.
- External boundary roots are denied by default.
- No external path is reopened except direct dependency `contractFiles` and `publicArtifacts`.
- Direct dependencies come from boundary document body links, not hidden frontmatter lists.
- `.codex` and sensitive globs are not loosened.
- No `danger-full-access` posture is introduced.

## Out Of Scope

- Public entrypoint and deep import policy belong to the target project's lint/review/CI.
- Ongoing contract document updates during implementation sessions belong to the target project's implementation-agent prompt, review process, hook output, or check scripts.
- Hook handles generated metadata freshness in fail-only mode.

## Suggested Verification

```text
node <workspace>/.codex/tools/contract-boundary-permissions/src/validate-codex-permissions.ts <workspace> --graph <workspace>/.codex/dependency-graph.json --config <workspace>/.codex/config.toml
```


