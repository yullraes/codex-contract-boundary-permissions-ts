---
name: contract-boundary-permissions
description: Setup skill for JS/TS workspaces that generates Codex filesystem permission candidates from README frontmatter boundaries and dependency graphs, then merges and validates them in .codex/config.toml.
---

# Contract Boundary Permissions

This skill is the permission setup entrypoint for the Contract Boundary Permission Bundle.

General implementation guidance, post-implementation contract document updates, and generated metadata freshness checks are not this skill's responsibility. The paired `Stop` hook performs those consistency checks in fail-only mode.

## Reference Loading

Read only the reference needed for the current permission setup task.

- Applying or resetting the bundle in an existing JS/TS workspace: `references/setup.md`
- Merging generated permission candidates into active `.codex/config.toml`: `references/permissions.md`
- Reviewing permission/config changes: `references/review.md`

## Boundaries

- This skill handles Codex permission setup.
- This skill does not replace implementation-agent prompts.
- This skill does not overwrite active `.codex/config.toml` automatically.
- This skill does not invent target-project public entrypoint or deep import lint policy.
