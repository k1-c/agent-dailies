---
name: agent-dailies
description: Show the user images, videos, GIFs, audio, 3D models (GLB/glTF), PDFs or other files in the agent-dailies viewer (one live browser tab) instead of opening windows or printing paths, and read back what they picked and said. Use whenever you want the user to look at something you made or found ("show me", "let me see", "open it", "見せて", "開いて", "比べたい"), and when they refer to something on that page ("this one", "the left one", "これ", "左の", "今見てるやつ", "採用したやつ").
---

# agent-dailies

The user keeps one browser tab open — the viewer — and everything you show lands
at the top of it, live, grouped by repository and worktree. They can mark each
file adopted or rejected and write comments, and those come back to you.

## Show something

```sh
agent-dailies show <file>… --title "<what to look at>" [--note "<what changed>"] [--tag before|after|A|B]
```

- Put alternatives in one call so they sit side by side: `show a.png b.png --title "Option A / B"`.
- The title says what to compare or decide; the note says what changed since last time.
- It copies the files into the store, so worktree files can be cleaned up afterwards.
- It opens the browser only when no viewer tab is open. Do not also run
  `xdg-open`, an image viewer or a video player (a hook stops that), and do not
  leave the user only a file path.
- Works for images, GIFs, videos (mp4/webm/ogv), audio (ogg/wav/mp3), GLB/glTF,
  PDF, HTML, Markdown and other text.

## Hear back

- After showing something you want a reaction to, keep `agent-dailies watch`
  running in the background (Bash with `run_in_background`, timeout 7200000).
  It exits when the user writes a comment, which wakes you with it. Act on it,
  then start it again. One per session is enough; a second exits at once.
- If you are about to stop with comments unread, the Stop hook hands them to you.
  Marks and comments also ride along with the user's next message.
- `agent-dailies context` — what they selected in the viewer (or the newest
  post): the files with paths you can read, marks, comments. Run it first when
  they say "this one" / "これ".
- `agent-dailies feedback [--since 2h] [--all]` — their marks and comments.
- `agent-dailies list [--all]` — recent posts; `agent-dailies get <item-id> [--to PATH]`
  — a stored file.

Add `--json` to `show`, `context`, `feedback` and `list` for exact fields.
