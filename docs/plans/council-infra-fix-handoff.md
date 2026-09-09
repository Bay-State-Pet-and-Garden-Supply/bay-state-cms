# Handoff: Fix Council Pass 1 Infra Blocker (for repair agent)

## Objective
Restore `subagent` background-child launches so Council Pass 1 (`oracle` + `reviewer`) can run same-protocol. Do NOT implement the onboarding rewrite itself.

## Exact failure
- Workflow `a1566a63-9a2c-4eba-bc0f-b4f96b4fb3b3` — `complete`, 0/2 done, 2 failed; Mission `fb6a5412-945e-40a8-b3fa-47378a3ba1e7`
- `advisor-oracle` run `5e8b2ebf-8373-45e9-a098-db63498f0782`: failed to start async child session
- `advisor-reviewer` run `c5eda725-ef81-41bd-9924-5dc8b6c78721`: identical failure
- Error text (both): `Background children require pi installed as the npm package (@earendil-works/pi-coding-agent) with its dependencies; /Users/nickborrello/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent does not provide @earendil-works/pi-server, @earendil-works/pi-server/unix, @earendil-works/pi-client/unix, so the async runner cannot create child sessions. A standalone pi binary cannot run background children.`
- Events: `/var/folders/09/psvh1gl520384nntp58c2lrr0000gn/T/pi-subagents-uid-501/async-subagent-runs/a1566a63-9a2c-4eba-bc0f-b4f96b4fb3b3/events.jsonl`
- Note: earlier workflow `166f42fa-ada4-48b6-934a-cd481ec5a739` (3 scouts) SUCCEEDED in this same session — regression or env drift since, not a permanently broken runner.

## Repo / worktree state (do not discard)
- Cwd: `/Users/nickborrello/Desktop/Projects/bay-state-cms`, branch `main`, ref `14a28e7`, ahead of origin by 5, worktree DIRTY
- Modified: `.gitignore, AGENTS.md, CONTEXT.md, src/client/App.tsx, src/client/api.ts, src/client/components/brand-strategy/BrandStrategyView.tsx, src/client/onboarding-feature-flags.ts, src/db/repositories/workspace-repo.ts, src/onboarding/flags.ts, src/server/routes/workspace-routes.ts, src/server/services/migration-service.ts, src/server/services/workspace-service.ts, src/tests/unit/onboarding-feature-flags.test.ts, src/tests/unit/shopsite-xml-roundtrip.test.ts`
- Untracked (preserve): `.out-of-scope/`, `docs/adr/0034-onboarding-rename-and-shell-rewrite.md`, `docs/agents/`, `docs/plans/manual-evidence-extraction-route-plan.md`, `docs/plans/onboarding-frontend-rewrite-plan.md`, `docs/plans/type-first-curation-accuracy-guardrails-plan.md`, `scripts/repair-system-auto-accept.ts`, `src/classification/*type*/currentness/verifier` files, `src/db/repositories/classification-refresh-repo.ts`, related unit tests
- Parked planner run `6f62b626-6fda-4dca-aa3d-f83d9da08b0f` (model now `openai-codex/gpt-5.6-sol:max`) — leave parked until council converges.

## Key diagnostic clue
- `which pi` → `/Users/nickborrello/.nvm/versions/node/v24.12.0/bin/pi`, `pi --version` → `0.85.1`
- `npm root -g` → `/opt/homebrew/lib/node_modules` (Homebrew node), NOT the nvm tree the binary runs from — global-root / binary mismatch
- nvm package dir listing shows `dist docs examples node_modules npm-shrinkwrap.json package.json` but runner reports missing `@earendil-works/pi-server*` deps
- `subagent doctor`: async support `available`, 14 agents (12 builtin, 2 user, 0 project, 0 package), intercom bridge active; only management actions verified — child launch still broken

## Suspected repair path (verify, don't assume)
1. Align active node/npm with the pi install (nvm `v24.12.0` vs Homebrew) or reinstall `@earendil-works/pi-coding-agent` as a real npm package WITH dependencies under the active tree so `pi-server`/`pi-client` resolve.
2. Re-run `subagent({action:"doctor"})` and one trivial async probe (e.g. single `scout` via `workflowScript` + `runs.run`, async) to prove child sessions spawn.
3. Only then relaunch Council Pass 1 same-protocol (do not switch to foreground/CLI/external modes without owner approval).

## Council relaunch spec (same-protocol only)
- Roster (fallbacks, no `council-*` profiles exist): `oracle` with `context:"fork"`, `reviewer` with normal profile context; pass cap 2
- Pass 1 contract: read-only, no children, no peer contact, ~600 words, structured report `{recommendation, evidence[{claim,sources}], assumptions[{assumption,status}], risks, confidence{level,reason}, challengeClaims[max 3], ownerDecisions, changeMyMind}` via `outputSchema` (full schema in `skills/council-mode/references/pass-contracts.md`)
- Brief question: approve full rewrite to linear renamed stages + Step 0 brand gate + combined execution strip, keeping Review + attention panels, rewriting shell/tabs/monitoring?
- Locked decisions under review: (1) linear stages with FULL domain rename in code (`sourcing→discovery→extraction→curation→review→promotion`, `STAGE_ORDER` in `src/db/repositories/onboarding-item-repo.ts:84`, enum in `src/shared/schemas/onboarding.ts:212`); (2) Step 0 brand gate, domain health top + item fixes below, unblocking Discovery authority gate; (3) execution strip = batch+stage status AND live SSE feed; (4) full rewrite shell, keep `ReviewWorkspace` + attention panels
- Evidence: `CONTEXT.md` onboarding sections; handoffs in `.pi/agent/sessions/--Users-nickborrello-Desktop-Projects-bay-state-cms--/subagent-artifacts/outputs/166f42fa-ada4-48b6-934a-cd481ec5a739/{frontend-ui,backend-pipeline,runs-observability}.md`; `src/shared/schemas/onboarding-work-state.ts`, `src/onboarding/job-queue.ts`, `src/onboarding/sse-emitter.ts`, `BatchWorkspace.tsx`/`WorkStateTabs.tsx`/`batch-workspace-logic.ts`, `review/ReviewWorkspace.tsx`, attention panels, `BatchPreflightModal.tsx`
- Aggregate receipt shape: `{pass:1, advisors:[{key,agent,requestedContext,runId,report}]}` preserving order / keyed by stable key

## Acceptance
- [ ] Root cause of missing `pi-server`/`pi-client` deps identified and fixed without touching dirty worktree contents
- [ ] Trivial async child probe succeeds
- [ ] Council Pass 1 relaunched same-protocol returns 2 structured reports + aggregate receipt
- [ ] Memo inputs (run ids, evidence, confidence, fallbacks incl. forked `oracle`) recorded for Pass 2

## Explicit non-goals
No rewrite implementation, no CONTEXT.md/ADR edits, no migration of dirty files, no mode switch (no `interactive_shell`, `pi -ne`, Codex/Claude/Cursor CLI, or foreground agents) without owner approval.
