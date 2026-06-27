# Contract Boundary Permission Bundle

This directory is the Codex plugin distribution unit.

The bundle sets up Codex filesystem permission candidates from Markdown contract boundary documents.

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

Start a new Codex thread after installing or updating the plugin.

Plugin installation exposes the skill and source bundle. Target workspace setup should run from a workspace-local tool root, not from `npm --prefix <plugin-cache> run ...`.

## Included Components

- `skills/contract-boundary-permissions`: the permission setup skill.
- `hooks/`: pre-commit hook implementation for workspace-local activation.
- `scripts/` and `src/`: deterministic tool primitives used by the skill and hook.

The plugin manifest exposes the skill, and the pre-commit checker is shipped as ordinary bundle content for workspace activation. The bundle intentionally does not ship a plugin `hooks/hooks.json`, so plugin installation does not mutate the user's global Codex hook config.

## Workspace Activation

The skill applies permission setup to a target workspace by scanning Markdown contract documents:

- `contract_scope: boundary` documents define boundary entrypoints.
- body links under `External Contracts` / `Dependencies` define direct dependency boundaries.
- dependency profiles can read only those boundaries' public contract files and public artifacts.

Activate the workspace by copying or scaffolding `hooks/`, `scripts/`, and `src/` into:

```text
<workspace>/.codex/tools/contract-boundary-permissions/
  hooks/pre-commit.mjs
  scripts/
  src/
```

Then install a Git pre-commit hook that invokes:

```text
<workspace>/.codex/tools/contract-boundary-permissions/hooks/pre-commit.mjs
```

`npm run render:pre-commit-hook` prints a `.git/hooks/pre-commit` wrapper for this layout.

The hook is fail-only. It does not edit `.codex/config.toml` or generated files.

## Bundle Maintenance

The repository root keeps the development sources in `skills/`, `hooks/`, `scripts/`, and `src/`. Run this before release:

```powershell
npm run sync:plugin-bundle
npm run check:plugin-bundle
```

Then validate the plugin manifest with the Codex plugin validator.


