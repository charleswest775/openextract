# Guide videos

Short, silent screen recordings of the real app for the website's guides, one per task
(the first: [/videos/save-iphone-texts-as-pdf](https://www.openextract.app/videos/save-iphone-texts-as-pdf)).
Each video is a step list here, and one command records and encodes it:

```bash
node scripts/record-guide-video.mjs scripts/guide-videos/save-iphone-texts-as-pdf.mjs \
  --backup ~/dev/openextract-suite/test-backups/syn-maren-ios26-encrypted/00008140-71766CB0FCFEEA02
```

It rebuilds `dist-electron` (and puts it back), starts Vite, drives the dev app with the
run-openextract skill's driver, records the window with a visible cursor, and writes
`website/static/videos/media/<slug>.mp4` (H.264, 1920×1080, faststart), `<slug>.jpg` (the poster)
and `<slug>.vtt` (captions). It prints the length, size and chapter times for the watch page.

**Before the first run:** the [run-openextract skill](../../.claude/skills/run-openextract/SKILL.md)'s
setup (`playwright-core`, the `.venv`), plus `ffmpeg` and `pdftoppm` (`brew install ffmpeg poppler`).
macOS only so far.

**Only ever a synthetic backup.** `--backup` must be one of backupgen's made-up backups (see the
skill): it's cloned into a throwaway HOME, so the start screen shows it as found on this computer
and nothing real can appear. The profile is throwaway too, and the card after an export is
switched off in it, since it's not part of any guide.

## A step list

`<slug>.mjs` exports `{ slug, title, steps }`. A step is one of:

- `{ caption, do: [actions] }`: recorded. The caption is burned in below the app (70 characters
  at most) while the step runs.
- `{ card: { title, sub }, ms }`: a title card. `*words*` in the title are set in coral italic,
  `\n` breaks the line.
- `{ pdf: { pages }, ms, caption }`: the PDF saved earlier in the run, its first pages side by side.

Any step can also have `say` (the fuller sentence for the captions file and the transcript),
`chapter` (starts a chapter there, for YouTube and the page's Clip markup), `lead` (ms the
caption shows before anything moves, default 1000) and `poster: true` (the poster is taken
`posterAt` seconds into it, default 2.2).

Actions, each an array:

| Action | Does |
|---|---|
| `['click', target]` | Glides the cursor there, rings it, clicks |
| `['hover', target, ms]` | The same without the click |
| `['type', target, text]` | Clicks it, then types at a readable speed |
| `['wheel', target, dy, ms]` | Scrolls under the cursor, eased |
| `['waitFor', target, { cut: true }]` | Waits until it's on screen; `cut` drops the wait from the video |
| `['saveTo']` | Answers the next folder picker with the run's own folder |
| `['pause', ms]`, `['press', key]`, `['eval', js]` | As named |

A target is `{ text }` (a button, link or label with that text, or starting with it), `{ label }`
(an `aria-label`, like a home-page tile), `{ css }` or `{ point: [x, y] }`, optionally with
`within: css` and `at`: the part with that text, or `[x, y]` as fractions of the target, for
where the cursor goes.

## After recording

1. Look at it: `ffmpeg -i <mp4> -vf fps=1,scale=384:-1,tile=8x9 sheet.png` makes a contact sheet.
2. Add or update the watch page `website/static/videos/<slug>.html` (copy the first one): the
   `duration` and `Clip` times in its JSON-LD and its chapter links come from what the command
   printed, and the sitemap entry's `<video:duration>`. `npm test` checks they match the captions file.
3. Re-recording keeps the file names, so the URLs Google has stay the same.
