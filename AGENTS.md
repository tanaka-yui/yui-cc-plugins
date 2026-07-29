# Repository Guidelines

## Project Structure & Module Organization

This repository is a pnpm workspace for cmux-oriented Claude Code/Codex plugins and apps.

- `apps/cmux-fork`, `apps/cmux-using`, and `apps/cmux-team-dispatch-task` contain plugin packages.
- Plugin metadata lives in `.claude-plugin/plugin.json` and, for Codex, `.codex-plugin/plugin.json`.
- Skills live under `apps/*/skills/<skill-name>/SKILL.md`; slash command docs live under `apps/*/commands/`.
- `apps/cmux-remote/client` and `apps/cmux-remote/server` are the PWA client and Bun bridge server.
- `.agents/plugins/marketplace.json` is the Codex marketplace catalog.

## Build, Test, and Development Commands

- `pnpm install`: install workspace dependencies using pnpm `10.33.0`.
- `pnpm check`: run TypeScript checks and Biome checks through Turbo.
- `pnpm lint` / `pnpm lint:fix`: run or fix Biome lint issues.
- `pnpm format` / `pnpm format:fix`: check or apply Biome formatting.
- `pnpm sort-package`: verify package.json ordering.
- `cd apps/cmux-remote/client && pnpm build`: build the remote client.
- `cd apps/cmux-remote/server && bun run start`: run the bridge server.
- Package-specific tests exist where declared, for example `cd apps/cmux-remote/client && pnpm test` or `cd apps/cmux-remote/server && bun test`.

## Coding Style & Naming Conventions

Use TypeScript ESM for code packages. Biome enforces 2-space indentation, LF endings, 120-column line width, single quotes, and semicolons as needed. Prefer kebab-case for plugin, skill, command, and package directory names, matching manifest `name` fields. Keep generated files, `dist`, `.next`, and `node_modules` out of formatting and review scope.

## Testing Guidelines

Place tests next to source files using `*.test.ts` or `*.test.tsx`. Client tests use Vitest, and server tests use Bun. Add focused tests for queueing, task dispatch, terminal/proxy behavior, or UI logic when changing those areas.

## Commit & Pull Request Guidelines

History uses short imperative messages, often Conventional Commit style for scoped fixes, such as `fix(cmux-team-dispatch-task): ...` or `refactor(...): ...`. Prefer that format for behavioral changes; simple maintenance commits like `update version` are also present but should stay specific.

PRs should include a concise summary, affected plugin/app paths, validation commands run, and screenshots or terminal output when UI or cmux behavior changes. Link related issues when available.

## Agent-Specific Instructions

Do not overwrite user changes. When editing plugin metadata, keep Claude and Codex manifests consistent unless intentionally changing one surface only.
