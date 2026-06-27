---
name: contract-boundary-permissions
description: Setup skill that generates Codex filesystem permission candidates from Markdown contract boundary documents, then merges and validates them in .codex/config.toml.
---

# Contract Boundary Permissions

This skill is the permission setup entrypoint for the Contract Boundary Permission Bundle.

The source of truth is the Markdown contract graph:

- `contract_scope: boundary` documents define boundary entrypoints.
- public/internal contract docs are linked from boundary entrypoint inline links.
- external dependency boundaries are linked from boundary entrypoint inline links, with the target frontmatter deciding the boundary.

This skill is for permission setup. General implementation guidance and post-implementation contract document updates belong to the target project's implementation-agent prompt, review process, hook output, or check scripts. The paired pre-commit hook performs generated metadata and config consistency checks in fail-only mode.

## Reference Loading

Read only the reference needed for the current permission setup task.

- Applying or resetting the bundle in an existing workspace: `references/setup.md`
- Merging generated permission candidates into active `.codex/config.toml`: `references/permissions.md`
- Reviewing permission/config changes: `references/review.md`

## Boundaries

- This skill handles Codex permission setup.
- This skill does not replace implementation-agent prompts.
- This skill does not own ongoing contract document updates during implementation sessions.
- This skill does not overwrite active `.codex/config.toml` automatically.
- This skill does not invent target-project public entrypoint or deep import lint policy.


