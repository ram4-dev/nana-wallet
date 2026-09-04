---
name: worktree-first-development
description: "Trigger: implementation, code change, coding task, worktree, Worktrunk. Start code work in a fresh isolated Worktrunk worktree and record its identity."
license: Apache-2.0
metadata:
  author: "ramiro"
  version: "1.0"
---

## Activation Contract

Load this skill before any implementation, refactor, bug fix, test change, dependency change, or code inspection that may lead directly to mutation.

## Hard Rules

- Inspect `git status` and the current branch before creating a worktree.
- Prefer Worktrunk: `wt switch --create <branch>` from the repository root.
- Never mutate the source worktree or its `main` branch for implementation work.
- Preserve unrelated changes; do not reset, clean, or remove existing worktrees.
- Record repository path, source branch, new branch, worktree path, and cleanup state in the task receipt.
- If `wt` is unavailable, stop and report the installation/configuration gap; use native `git worktree` only with explicit approval.

## Decision Gates

| State | Action |
|---|---|
| Code mutation requested | Create and enter a fresh Worktrunk worktree |
| Existing unrelated changes | Leave them untouched and branch from the current commit |
| Worktree already exists for this exact slice | Reuse only when the receipt identifies it and the user approved resumption |
| Slice complete | Verify, record evidence, and keep or remove the worktree according to the task scope |

## Execution Steps

1. Run `git status --short --branch` and `git worktree list`.
2. Create a unique branch/worktree with `wt switch --create <branch>`.
3. Record the returned path and branch before editing files.
4. Run implementation, review, and verification only inside that worktree.
5. Report cleanup or resumable state; never silently merge or delete work.

## Output Contract

Return the worktree path, branch, source commit, files changed, checks run, and cleanup/resumption state.

## References

- https://worktrunk.dev/
