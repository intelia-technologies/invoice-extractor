---
description: Create a pull request
allowed-tools: Bash(git:*), Bash(gh:*), Read, Edit
---

# Create Pull Request

Create a pull request for the changes we've made in this conversation.

## Phase 0: Check Branch State

Current branch: !`git branch --show-current`
Status: !`git status --short`

### If on main branch:
Create a feature branch first:
1. Look at the changes made
2. Create an appropriate branch name (e.g., `fix/description`, `feat/description`)
3. Run: `git checkout -b <branch-name>`

### If already on a feature branch:
Proceed directly to Phase 1.

## Phase 1: Pre-PR Check

Verify there are no obvious issues:
1. Check for console errors or syntax issues in JS files
2. Verify all JSON files parse correctly

## Phase 2: Create the PR

### 2.1 Check Current State

Status: !`git status`
Commits: !`git log origin/main..HEAD --oneline`

### 2.2 Commit, Push and Create PR

1. If there are uncommitted changes related to the task, commit them
2. Push: `git push -u origin HEAD`
3. Create PR: `gh pr create --fill`

## Phase 3: Summary

Report the PR URL and a summary of what's included.