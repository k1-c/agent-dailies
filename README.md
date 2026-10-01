# agent-dailies

**A live review page for what your coding agent makes.**

When an agent renders an image, records a clip, generates a sound or exports a
3D model, it usually opens a new window or leaves you a path deep inside a
worktree — and you end up asking "open it" again and again. agent-dailies gives
the agent one place to put things instead: a browser tab you keep open, where
every result appears at the top as it is made, side by side with the
alternatives, and stays there.

You mark files **adopted** or **rejected**, answer the agent's questions ("which
of these three?", a whole design review) and write comments right on the page.
Those come back to the agent — even while it is idle — so the review loop runs
through the page instead of through copy-pasted paths and options typed in chat.

Named after *dailies*, the daily review where a film or game team looks at
yesterday's renders and decides what to keep.

- **One tab, live** — new posts slide in at the top (server-sent events); no
  windows pop up, nothing steals focus. The browser is opened only when no tab is.
- **Every medium** — images and GIFs, video (looping, muted, plays when in view;
  formats browsers no longer play, such as Ogg Theora, are converted once with
  [ffmpeg](https://ffmpeg.org/) if it is installed),
  audio, GLB/glTF (orbit with [model-viewer](https://modelviewer.dev/)), PDF,
  HTML, Markdown and text.
- **Grouped by worktree** — posts carry the repository, worktree/branch, the
  issue key from the branch name (`summ-239` → `SUMM-239`) and the agent session,
  so parallel agents never mix.
- **Questions** — `agent-dailies ask` turns files and sentences into options
  A, B, C… to pick from, or takes a whole review sheet of decisions; your answers
  wake the agent.
- **Feedback reaches the agent** — `agent-dailies watch` exits (waking the agent)
  when you comment; hooks hand comments over before the agent stops and with your
  next message.
- **Take files with you** — copy an image straight to the clipboard and paste it
  anywhere; copy a video's or model's path to paste into an upload dialog;
  download one file or the whole post under the original names; drag a file to the
  desktop or a folder.
- **Kept** — files are stored by content hash outside your repository, so they
  survive worktree cleanup and never bloat git.
- **Keyboard first** — `j`/`k` posts, `h`/`l` files, `a` adopt, `x` reject,
  `c` comment, `f` full screen, `1`–`9` choose an option, `Enter` send it,
  `y` copy (`Y` the path), `d` download.

## Install

You need [Node.js](https://nodejs.org/) 22.6 or later on your `PATH`. Nothing
else: no npm package, no build.

### Claude Code

```text
/plugin marketplace add k1-c/agent-dailies
/plugin install agent-dailies@agent-dailies
```

The plugin is the whole tool. Claude Code fetches this repository; the plugin's
hooks run the code in it with Node, and at session start they put its `bin/` on
the agent's `PATH` (through `$CLAUDE_ENV_FILE`), so the agent can simply type
`agent-dailies show …`. The plugin also adds a skill (when and how to show
things) and hooks that tell the agent about the viewer, stop `xdg-open`/image
viewers/video players on media files in favour of `agent-dailies show`, and
hand your comments to the agent.

### Your own shell, or another agent

Clone the repository and put `bin/` on your `PATH`:

```sh
git clone https://github.com/k1-c/agent-dailies ~/.local/share/agent-dailies-src
ln -s ~/.local/share/agent-dailies-src/bin/agent-dailies ~/.local/bin/
agent-dailies guide   # the instructions to give your agent (CLAUDE.md / AGENTS.md)
```

`agent-dailies hook <pre-tool-use|session-start|user-prompt-submit|stop>` reads
a Claude Code style hook event on stdin, if your agent has hooks.

## Use

The agent runs:

```sh
agent-dailies show render_a.png render_b.png --title "Lighting: A / B" --note "B lowers the fill light"
```

```text
Shown 2 files in the viewer: http://127.0.0.1:4777/#p_mupkr1fn81b4a9
  1. render_a.png  (i_mupkr1c5fdf43e)
  2. render_b.png  (i_mupkr1c613713a)
The viewer is open in 1 tab; it updated in place. No need to open anything.
```

When it needs a decision, it asks:

```sh
agent-dailies ask "Which front view do we keep?" a.png b.png --option "Neither — redraw it" \
  --why "B matches the back view best; A loses the cape."
agent-dailies ask --file review.json      # several decisions at once (see the skill for the format)
agent-dailies wait <post-id>              # in the background: exits with the answers
```

You look, mark, answer and comment in the tab. The agent reads it back:

| Command | What it gives the agent |
| --- | --- |
| `agent-dailies context` | What you selected (or the newest post): files with readable paths, marks, answers, comments |
| `agent-dailies wait <post-id>` | Blocks until every question of a post is answered (or you comment on it), prints the answers, exits |
| `agent-dailies watch` | Blocks until you comment on this session's posts, prints the feedback, exits. Run it in the background so your comment wakes the agent |
| `agent-dailies feedback [--since 2h] [--all]` | Your marks, answers and comments for this worktree |
| `agent-dailies list [--all]` | Recent posts |
| `agent-dailies get <item-id> [--to PATH]` | A stored file |

And for you: `agent-dailies open` (open the viewer), `status`, `stop`.

### When to use it

| Situation | Use |
| --- | --- |
| The agent's work in progress, to look at | `show` |
| A decision on it: which option, approve a design, what to keep | `ask` |
| A page other people read, or that outlives the work (a report, a shared doc) | your agent's documents / Artifacts |
| A quick choice with nothing to look at | the terminal |

### How comments and answers get back to the agent

Every post remembers the agent session that showed it (`CLAUDE_CODE_SESSION_ID`).
A comment on it, or an answer to its questions, is pending for that session until
it has been handed over once:

1. **While the agent is idle** — it keeps `agent-dailies watch` running in the
   background. Claude Code wakes the agent when a background command exits, and
   `watch` exits with your comment.
2. **When the agent is about to stop** — the Stop hook hands over unread comments
   (and, once per new post, reminds the agent to start `watch`).
3. **With your next message** — the UserPromptSubmit hook adds marks and comments
   since the agent last heard.
4. **In a new session** — the SessionStart hook passes on feedback left in this
   worktree that no session read.

### Getting files out

| On the page | What you get |
| --- | --- |
| ⧉ copy (`y`) | Still images: the picture itself (as PNG) — paste into chat, issues, posts. Text files: the text. Video, audio, GIFs, models: the file's path, because a web page cannot put those on the clipboard as files; in an upload dialog press `Ctrl+L` and paste. Shift-click (`Y`) always copies the path. |
| ⤓ download (`d`), ⤓ All | The file, or every file in the post, saved under the original names. From Chrome's download bubble you can drag them on into another site. |
| Drag a file name (or an image) | Dropped on the desktop or in a folder, the file itself; dropped on another page, images arrive as images and other files as their link. |

Paths point to `named/<item>/<original name>` in the store, a hard link to the
stored copy, so the name is right and no space is used.

## Where things are kept

```text
$XDG_DATA_HOME/agent-dailies/        (~/.local/share/agent-dailies)
  blobs/<ab>/<sha256><ext>           files, once per content
  log/<machine>.jsonl                append-only events: post (with its questions), verdict, comment, answer
  named/<item>/<original name>       hard links under the original names (copy path)
  derived/<sha256>.webm              videos converted for the browser
  sessions/<session>.json            what each agent session has been handed
  selection.json                     what is selected in the viewer
  server.log
```

Each machine only appends to its own log, so syncing the store between machines
is a plain union — the groundwork for the planned sync (below).

| Variable | Default |
| --- | --- |
| `AGENT_DAILIES_HOME` | `$XDG_DATA_HOME/agent-dailies` |
| `AGENT_DAILIES_PORT` | `4777` |
| `AGENT_DAILIES_HOST` | `127.0.0.1` (`0.0.0.0` to reach it from other machines, e.g. over Tailscale) |
| `AGENT_DAILIES_NO_OPEN=1` | never open a browser from `show` |
| `AGENT_DAILIES_BROWSER` | command to open URLs with |
| `AGENT_DAILIES_AUTO_WATCH=0` | no Stop-hook reminder to start `watch` |

## Security

The viewer listens on `127.0.0.1` only and has no login. It refuses requests
whose `Host` is not the viewer's own address (DNS rebinding), requires JSON for
every write (so other sites cannot post forms to it) and rejects cross-origin
writes. Listening on `0.0.0.0` turns the `Host` check off — do that only on a
network you trust.

## Roadmap

- Sync the store between machines through Cloudflare R2, set up by
  `agent-dailies init` after `wrangler login` (no infrastructure to run): files
  fetched on demand, logs merged.
- Provenance between posts (this model came from that sketch, that prompt).
- Codex and other agents' hooks.

## Develop

```sh
npm run setup     # TypeScript and types into dev/; the tool itself has no dependencies
npm test          # node --test, TypeScript run directly by Node
npm run verify    # typecheck, test, build
bin/agent-dailies show some.png
```

The 3D viewer ([model-viewer](https://github.com/google/model-viewer), with
three.js and Lit) is vendored in `web/vendor/` so the page works offline; their
licenses are in `web/vendor/licenses/`. `npm run vendor` refreshes it.
Development tooling lives in `dev/package.json`, not the root one: Claude Code runs `npm install`
on a plugin that has dependencies, and this plugin needs none.

## License

MIT
