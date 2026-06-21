# Contract Boundary Permission Bundle

This directory is the Codex plugin distribution unit.

## Install From This Repository

From a local checkout:

```powershell
codex.cmd plugin marketplace add <repo-root>
codex.cmd plugin add contract-boundary-permission-bundle@contract-boundary-permissions-ts
```

From a Git marketplace:

```powershell
codex.cmd plugin marketplace add https://github.com/<org>/<repo> --ref <tag-or-branch>
codex.cmd plugin add contract-boundary-permission-bundle@contract-boundary-permissions-ts
```

For a large repository, use sparse marketplace checkout paths:

```powershell
codex.cmd plugin marketplace add https://github.com/<org>/<repo> --ref <tag-or-branch> --sparse .agents/plugins --sparse plugins/contract-boundary-permission-bundle
```

Start a new Codex thread after installing or updating the plugin.

Plugin installation exposes the skill and source bundle. Target workspace setup should run from a workspace-local tool root, not from `npm --prefix <plugin-cache> run ...`.

## Included Components

- `skills/contract-boundary-permissions`: the permission setup skill.
- `hooks/`: Stop hook implementation and source hook config.
- `scripts/` and `src/`: deterministic tool primitives used by the skill and hook.

Current Codex plugin manifest validation does not accept a top-level `hooks` field. Because of that, the plugin manifest exposes the skill, and the Stop hook is shipped as bundle content for workspace activation.

## Workspace Activation

The skill applies permission setup to a target JS/TS workspace. The Stop hook checks generated freshness and active permission config after Codex turns, but hook registration is still a workspace-level action.

The source hook is:

```text
hooks/stop-checks.mjs
```

Activate the workspace by copying or scaffolding `hooks/`, `scripts/`, and `src/` into:

```text
<workspace>/.codex/tools/contract-boundary-permissions/
  hooks/stop-checks.mjs
  scripts/
  src/
```

Then merge hook config that points at:

```text
<workspace>/.codex/tools/contract-boundary-permissions/hooks/stop-checks.mjs
```

`npm run render:stop-hook-config` prints a config snippet for this layout.

The hook is fail-only. It does not edit `.codex/config.toml` or generated files.

## Bundle Maintenance

The repository root keeps the development sources in `skills/`, `hooks/`, `scripts/`, and `src/`. Run this before release:

```powershell
npm run sync:plugin-bundle
npm run check:plugin-bundle
```

Then validate the plugin manifest with the Codex plugin validator.
