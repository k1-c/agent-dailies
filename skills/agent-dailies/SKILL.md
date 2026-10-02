---
name: agent-dailies
description: Show the user your work in progress (images, videos, GIFs, audio, 3D models, PDFs, HTML, text) in the agent-dailies viewer — one live browser tab — and ask them to choose there between things to look at (pick a render, sign off on how something looks), instead of opening windows, printing paths or publishing an Artifact. Questions answered from words alone stay in the terminal. Use whenever you want the user to look at something you made ("show me", "let me see", "open it", "見せて", "開いて", "比べたい"), need them to choose between things you made ("which one looks better", "どっちの絵がいい", "見比べて選んで", "見た目をレビューして"), look back on finished work or summarize a period ("devlog", "制作記録", "ふりかえり", "前回からの変更", "アップデートのまとめ"), or they refer to something on that page ("this one", "the left one", "これ", "左の", "今見てるやつ", "採用したやつ").
---

# agent-dailies

The user keeps one browser tab open — the viewer. Everything you show or ask lands
at the top of it, live, grouped by repository, issue and session. They reply to what
you show (OK, or a note) and answer your questions (pick an option, press Send; a
note is optional), and all of that comes back to you.

## Which tool when

| Situation | Use |
| --- | --- |
| Your work in progress to look at | `agent-dailies show` |
| A choice between things to look at: which render, how it looks, what to keep | `agent-dailies ask` |
| A page other people read, or that outlives this work (report, shared doc) | an Artifact |
| Any question answered from words alone — which approach, yes/no, a name, what next, even a design decision | ask in the terminal |

Do not route plain questions through the viewer: the user answers those faster in
the terminal, and a post with no picture in it is just noise on the page.

## Show

```sh
agent-dailies show <file>… --title "<what to look at>" [--note "<what changed>"] [--tag before|after]
```

- Alternatives go in one call so they sit side by side.
- The browser opens only when no viewer tab is open. Do not also run `xdg-open` or a
  viewer (a hook stops that), and do not leave the user only a file path.

## Ask

One question, options from files and sentences (A, B, C… in that order):

```sh
agent-dailies ask "Which front view do we keep?" a.png b.png --option "Neither — redraw it" \
  --why "B matches the back view best; A loses the cape."
```

`--multi` lets them pick several. They can add a note to their answer.

When an option is a pattern shown by several files, group the files under it (the
user chooses the pattern, not single files):

```sh
agent-dailies ask "Which palette do we keep?" \
  --pattern "Current" current_front.png current_back.png \
  --pattern "Warmer" warm_front.png warm_back.png \
  --option "Neither — try again"
```

Several such decisions at once (a review of things to look at) — write a sheet and pass it with `--file`:

```json
{
  "title": "SUMM-123 contract screen: decisions",
  "note": "Pick per item; choose Let's discuss and add a line where you are unsure.",
  "questions": [
    {
      "text": "List species you lack materials for, greyed out",
      "why": "**Why**: shows what to collect next.",
      "options": [
        "OK as proposed",
        { "label": "Alternative: list only the ones you can contract", "body": "A shorter list.\n- Goals move to the bestiary" },
        "Let's discuss"
      ]
    }
  ]
}
```

Options can carry `"files": ["path.png"]` (relative to the sheet), questions too.
Write the sheet in the user's language. Do not start labels with "A:" — the letters
are added for you.

Then start the wait in the background (Bash `run_in_background`, timeout 7200000):

```sh
agent-dailies wait <post-id>
```

It exits with every answer (or as soon as the user comments on the post), which
wakes you. Act on the answers; keep discussing the items they marked for discussion.
Ask again (a new post) for the next round.

## Devlog

A record of how the work changed, written as you go, so that updates and devlog
posts can be summarized later from it (no scheduled screenshots).

**Only merged work goes in.** Record an entry when work has landed on the main
branch — after the user approved the merge and it went through — not at each commit
on a branch (work on a branch may still change or be dropped). Then look back over
the session. If it changed something a person using the product would notice,
record an entry — these entries are what update videos and devlog posts are written
from:

```sh
agent-dailies devlog add --title "Thief's cape reads at game size" \
  --before i_mupkr1c5fdf43e --after shots/cape_after.png shots/cape_run.mp4 --summary - <<'EOF'
The cape was a flat plate from the back; it is now thick and follows the run.
## 工夫
Pushed the cloth out along its normals instead of remodelling it, so the
animation and texture stayed as they were.
## 苦労
The first try thickened the hood too and it clipped the horns; the user spotted
it in the viewer, so the hood is now left out by vertex group.
## 決めたこと
Keep the darker hem (option B in the viewer).
EOF
```

- **Summary** (first part): what changed for the people using it, and why.
- **## 工夫 / craft**: what was done well or cleverly — the idea that made it work.
- **## 苦労 / struggle**: what was hard — what failed first, what you tried, what
  the user had you redo, what you learned. Be concrete; this is the story.
- **## 決めたこと / decided**: decisions, with the user or yours.
  (`--craft`, `--struggle`, `--decided` work too. Leave out a section only when
  there truly is nothing.)
- **Before/after are required when the change can be seen or heard.** Images for
  how it looks; short videos (or several files) when the change is in motion,
  timing, feel or sound — a still cannot show those. Use the `i_…` ids of files
  you already showed (`agent-dailies context`/`list` print them), or capture the
  "before" from the commit before the merge in a temporary worktree. Only changes
  nobody can see or hear go without them. Skip refactors and fixes nobody notices.
- The session's merged commits are attached automatically, with the issue of the
  merged branch, and `devlog add` refuses work that is not on the main branch yet
  (`--commits A..B` must be on it too; `none` for work without commits). The Stop
  hook reminds you once after a merge lands — that is the moment to record.

To write an update or a devlog post ("since the last one"), take the period from the
previous update itself (when it ended — its date, or the notes kept with it):

```sh
agent-dailies devlog summary --since "2026-10-01 18:00"   # entries, decisions, commits, transcripts
```

`agent-dailies devlog list` shows recent entries. The viewer keeps the devlog on
its own tab (Devlog), apart from what you show for review (Dailies).

## Hear back

- `agent-dailies context` — what they selected (or the newest post): files with paths
  you can read, answers, replies. Run it first when they say "this one" / "これ".
- `agent-dailies watch` in the background — exits when they comment or answer on
  anything you showed this session. Start it again only while you still expect a
  reply; when your work is done and nothing waits on the user, let it end.
- `agent-dailies feedback [--since 2h] [--all]` — their replies and answers.
- `agent-dailies list [--all]`, `agent-dailies get <item-id> [--to PATH]`.

Add `--json` to `show`, `ask`, `context`, `feedback` and `list` for exact fields.
