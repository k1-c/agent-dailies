# agent-dailies — notes for coding agents

## Commands

```sh
npm install
npm test            # node --test over test/**/*.test.ts (Node runs the TypeScript directly)
npm run typecheck
npm run verify      # typecheck + test + build; run before every commit
node src/cli.ts …   # run the CLI from source
```

Point a manual run at a scratch store so it never touches the real one:
`AGENT_DAILIES_HOME=$(mktemp -d) AGENT_DAILIES_PORT=47901 AGENT_DAILIES_NO_OPEN=1 node src/cli.ts show x.png`.

## Layout

- `src/cli.ts` — commands; `src/server.ts` — the viewer (HTTP, server-sent events, JSON API);
  `src/client.ts` — talking to it and starting it in the background; `src/store.ts` — files by
  hash and the event log; `src/feedback.ts` — handing comments to agent sessions;
  `src/hook.ts` — agent hooks and the guide text; `src/where.ts` — repository/worktree/issue/session.
- `web/` — the page: plain HTML, CSS and JavaScript, no build step. Strings live in `web/i18n.js`
  (English and Japanese).
- `agent-plugin/` — the Claude Code plugin (skill + hooks); `.claude-plugin/marketplace.json` lists it.

## Invariants

- The store is append-only. Each machine writes only `log/<machine>.jsonl`; nothing rewrites or
  deletes events. Files are named by content hash and never change. This is what lets stores sync
  by union later.
- While the viewer runs it is the only writer of this machine's log; the CLI copies files into the
  store and posts the event to the viewer. The CLI writes the log itself only when the viewer
  cannot start.
- TypeScript stays erasable (`erasableSyntaxOnly`): no enums, namespaces or parameter properties,
  so Node can run the sources and tests without a build. Relative imports use `.ts`.
- Hooks must be quick and quiet: exit 0 with no output unless they have something to say; exit 2
  (stderr to the agent) only to block on purpose.
- The viewer binds to 127.0.0.1 by default and checks `Host`, `Origin` and the JSON content type
  on writes. Keep those checks when adding endpoints.
- Every user-visible string in the page has English and Japanese.

## Commits

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Keep each commit passing
`npm run verify`.
