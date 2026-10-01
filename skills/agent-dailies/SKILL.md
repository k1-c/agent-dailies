---
name: agent-dailies
description: Show the user your work in progress (images, videos, GIFs, audio, 3D models, PDFs, HTML, text) in the agent-dailies viewer — one live browser tab — and ask them to decide there (pick an option, sign off a design review), instead of opening windows, printing paths, listing options in chat or publishing an Artifact. Use whenever you want the user to look at something you made ("show me", "let me see", "open it", "見せて", "開いて", "比べたい"), need a decision ("which one", "choose", "review this", "どっちがいい", "選んで", "決めて", "レビューして", "判断して"), look back on finished work or summarize a period ("devlog", "制作記録", "ふりかえり", "前回からの変更", "アップデートのまとめ"), or they refer to something on that page ("this one", "the left one", "これ", "左の", "今見てるやつ", "採用したやつ").
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
| A decision on it: which option, approve a design, what to keep | `agent-dailies ask` |
| A page other people read, or that outlives this work (report, shared doc) | an Artifact |
| A quick choice with nothing to look at | ask in the terminal |

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

Several decisions at once (a design review) — write a sheet and pass it with `--file`:

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

When a piece of work is committed, look back over the session. If it changed
something a person using the product would notice, record an entry:

```sh
agent-dailies devlog add --title "Thief's cape reads at game size" \
  --before i_mupkr1c5fdf43e --after shots/cape_after.png <<'EOF'
The cape was a flat plate from the back; it is now thick and follows the run.
Decided with the user: keep the darker hem (option B).
EOF
```

- The summary (stdin with `--summary -`, or `--summary TEXT`): what changed, why,
  and what was decided along the way.
- Before/after only when a picture shows the change better than words. Use the
  `i_…` ids of files you already showed (`agent-dailies context`/`list` print
  them), or capture the "before" from the previous commit (a temporary worktree).
  Skip refactors and fixes nobody sees.
- Commits made this session are attached automatically (`--commits A..B` or
  `none` to override). The Stop hook reminds you once after new commits.

To write an update or a devlog post ("since the last one"):

```sh
agent-dailies devlog summary            # since the last cut: entries, decisions, commits, transcripts
agent-dailies devlog cut --name "Update 2026-10-02"   # after it went out
```

`agent-dailies devlog list` shows recent entries; the viewer has a Devlog view.

## Hear back

- `agent-dailies context` — what they selected (or the newest post): files with paths
  you can read, answers, replies. Run it first when they say "this one" / "これ".
- `agent-dailies watch` in the background — exits when they comment or answer on
  anything you showed this session. Start it again after acting.
- `agent-dailies feedback [--since 2h] [--all]` — their replies and answers.
- `agent-dailies list [--all]`, `agent-dailies get <item-id> [--to PATH]`.

Add `--json` to `show`, `ask`, `context`, `feedback` and `list` for exact fields.
