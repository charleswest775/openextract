---
name: github-triage
description: Triage the OpenExtract GitHub backlog — review open PRs (tests, correctness, overlap), then open issues (labels, duplicates, already-fixed) — and produce a recommended action per item. Use when asked to check the repo, work the PR/issue backlog, or run the weekly triage.
---

# GitHub triage routine

Repo: `charleswest775/openextract`. Work PRs first, then issues. **Never merge, close,
comment, label, or push to a contributor's branch without the maintainer's explicit
approval for that specific item** — the output of this routine is a recommendation
table plus drafted replies, then act on what gets approved.

## 1. Snapshot

```bash
gh pr list --state open --limit 100 --json number,title,author,createdAt,updatedAt,isDraft,mergeable,reviewDecision,headRefName,additions,deletions
gh issue list --state open --limit 100 --json number,title,author,createdAt,updatedAt,labels,comments
```

Flag anything where the last comment is from a non-maintainer and has had no reply —
unanswered contributor questions are the highest-priority item regardless of age.
Ignore Vercel "authorize deploy" bot comments on fork PRs (site preview only).

## 2. PRs — for each open PR

1. `gh pr view N --comments` and `gh pr diff N`. Note the linked issue (`Closes #X`);
   if the body only links it informally, the issue will not auto-close — remember to
   close it by hand after merging.
2. Check out without touching the working branch:
   `git fetch origin pull/N/head:pr-N && git worktree add <scratchpad>/prN pr-N`
3. Run `python -m pytest python/tests -q` (repo venv: `/Users/charleswest/dev/openextract/.venv`).
   For TS/UI changes also `npm run build`.
4. Review against project priorities (CLAUDE.md): reliability, clear user-facing
   errors, no data loss, cross-platform. Specifically check:
   - Empty inputs (empty conversation, date filter with no matches, `None` dates).
   - Anything written into exported HTML is `html.escape`d.
   - Anything that deletes or overwrites user files/backups.
   - Filenames built from user data are sanitized and non-empty.
   - New sidecar params are threaded through `python/main.py` and the renderer call.
5. Pairwise overlap: `git merge-tree --write-tree pr-A pr-B` for PRs touching the same
   files; decide merge order.
6. Staleness: conflicting + no activity in 60+ days → check whether `main` already
   contains the change (grep for its key lines) before recommending close vs. rebase.
7. Clean up: `git worktree remove <scratchpad>/prN && git branch -D pr-N`.

Merging: `main` requires one approving review. For contributor PRs, approve
(`gh pr review N --approve`) then `gh pr merge N --squash` — don't use `--admin`
unless the maintainer says so. The maintainer can't approve their own PRs.
The failing "Vercel" check on fork PRs is just the site preview awaiting
authorization; ignore it.

Recommendation per PR is one of: **merge** (squash), **request changes** (with a
drafted review listing concrete fixes), **maintainer fix-up** (push fixes on top if
"allow edits by maintainers" is on, then merge), or **close** (with a thank-you and
the reason). Credit contributors in the squash message.

## 3. Issues — for each open issue

- Parsing bugs (calls, contacts, messages, notes, …) usually live in the sibling
  repo `charleswest775/ios-backup-core` (`src/ios_backup_core/extractors/`);
  `python/*.py` here are thin adapters. Check there before concluding "fixed".
- Missing label → propose one from: bug, enhancement, messages, photos, voicemail,
  contacts/calls (python-engine), ui, export, ios-compat, documentation, security.
- Already fixed on `main` or by a PR just merged → propose close with the commit/PR link.
- Duplicate → propose close pointing at the canonical issue.
- Bug report lacking a repro / iOS version / OS → draft a reply asking for it.
- Old maintainer-authored roadmap issues (Phase N, epics) → propose converting to a
  milestone or closing if superseded by shipped releases.
- Tag small, well-specified ones `good first issue`.

## 4. Report

Output a single table: `# | type | age | recommendation | why`, followed by drafted
comments for every item that needs one. Then ask which actions to execute.
