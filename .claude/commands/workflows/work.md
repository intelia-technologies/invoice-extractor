---
name: work
description: Execute a plan - implement with incremental commits and verification
argument-hint: "[path to plan file]"
---

# Work

Execute a plan with incremental commits and verification.

## Arguments

<plan_path> #$ARGUMENTS </plan_path>

**If no path provided:**
1. Check for recent plans: `ls -la thoughts/plans/ | head -10`
2. Ask: "Which plan should I execute?"

## Workflow

### Phase 1: Setup

#### 1.1 Read and Parse Plan

Read the plan file completely. Extract:
- All tasks (checkbox items)
- Phase structure
- Success criteria
- Dependencies

#### 1.2 Check Git State

```bash
git status --short
git branch --show-current
```

**If on main branch:**
1. Determine appropriate branch name from plan title (e.g., `feat/plugin-engine`)
2. Create branch: `git checkout -b <branch-name>`

### Phase 2: Execute Tasks

For each task in order:

#### 2.1 Implement

Follow project rules:
- No hardcoded provider logic — all provider-specific behavior in JSON files
- Engine stays generic
- Provider JSON follows the schema in `.claude/rules/provider-schema.md`

#### 2.2 Incremental Commit

After completing a logical unit of work:

```bash
git status --short
git diff --stat
git add <specific-files>
git commit -m "<type>: <description>"
```

**Commit types:** `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`

#### 2.3 Mark Plan Progress

Update the plan file - change `- [ ]` to `- [x]` for completed tasks.

### Phase 3: Verification

After implementing, verify the changes work:

1. Check all JS files for syntax errors (use browser DevTools or node --check)
2. Verify all JSON provider files parse correctly
3. Follow the plan's Verification section steps
4. Test in Chrome: reload extension, verify functionality

### Phase 4: Update Plan Status

Update the plan file:

```markdown
**Status:** Complete

## Completion Summary

**Completed on:** YYYY-MM-DD
**Total commits:** X

### What was implemented
- [Summary of changes]

### Commits
- abc1234: Description
- def5678: Description
```

### Phase 5: Create Pull Request

```bash
git push -u origin HEAD
gh pr create --title "<type>: <title from plan>" --body "$(cat <<'EOF'
## Summary
[Brief description]

## Changes
- Change 1
- Change 2

## Plan
Implements: thoughts/plans/YYYY-MM-DD-<type>-<name>-plan.md

## Test Plan
- [ ] Extension loads without errors
- [ ] Provider list appears correctly
- [ ] Downloads work for affected providers
EOF
)"
```

### Phase 6: Summary

```markdown
## Work Complete

**Plan:** [plan path]
**Branch:** [branch name]
**PR:** [PR URL]

### Tasks Completed
- [x] Task 1
- [x] Task 2

### Commits Made
1. abc1234 - feat: Add provider engine
2. def5678 - feat: Add Webflow provider

### Next Steps
1. Wait for PR review
2. Test in Chrome with real billing pages
```

## Safety Rules

1. **Never push to main directly**
2. **Never commit credentials or API keys**
3. **Always create incremental commits** (not one giant commit)

## Handling Blockers

If a task is blocked:
1. Update plan with blocker note: `- [?] Task name (BLOCKED: reason)`
2. Continue with next non-blocked task
3. If all remaining tasks are blocked, summarize and ask user