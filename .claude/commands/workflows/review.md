---
name: review
description: Code review focused on provider schema compliance and engine correctness
argument-hint: "[files or PR to review]"
---

# Review

Run focused code review on changes.

## Arguments

<target> #$ARGUMENTS </target>

## Workflow

### Phase 1: Determine Review Scope

**If no arguments provided:**
1. Check for open PR: `gh pr view --json number,url,body 2>/dev/null`
2. Check branch changes: `git log main..HEAD --oneline`
3. Check git status: `git status --short`

**Get the diff:**
```bash
git diff main..HEAD
git diff main..HEAD --stat
```

### Phase 2: Review Checklist

For each changed file, check:

#### Provider JSON files
- [ ] All required fields present: `id`, `name`, `icon`, `billingUrl`, `readySelector`, `extract`, `download`
- [ ] `dateFormat` is a valid value
- [ ] CSS selectors are relative to row element (not absolute)
- [ ] `download.method` matches one of: `direct-link`, `fetch-blob`, `open-tabs`, `print-page`
- [ ] Provider ID matches filename (kebab-case)
- [ ] `filenameTemplate` uses valid placeholders

#### Engine (engine.js)
- [ ] No provider-specific logic (must stay generic)
- [ ] All new patterns are schema-driven
- [ ] Error handling doesn't swallow errors silently
- [ ] Date parsing handles edge cases

#### UI (popup.js, popup.html)
- [ ] Works in both popup and floating window modes
- [ ] State persistence handles new fields
- [ ] No hardcoded provider references

### Phase 3: Present Findings

```markdown
## Review Summary

**Target:** [PR / branch / files]
**Files reviewed:** X

### Issues Found
1. **[SEVERITY]** Description — file:line
   **Fix:** How to fix

### All Clear (if no issues)
No issues found. Code is ready.
```