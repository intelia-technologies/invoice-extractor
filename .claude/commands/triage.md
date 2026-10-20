---
name: triage
description: Interactively triage and prioritize findings from code reviews, audits, or analysis
argument-hint: "[source: pr-comments|audit|analysis]"
---

# Triage Findings

Interactively process findings and decide which to action.

**IMPORTANT: DO NOT CODE DURING TRIAGE!** This is for decision-making only.

## Source

<source> #$ARGUMENTS </source>

## Workflow

### 1. Gather Findings

Based on source type:

**pr-comments:**
```bash
gh pr view --json reviewRequests,comments,reviews
```

**audit:** Read the audit output file

**analysis:** Read the analysis results

### 2. Present Each Finding

For each finding, present:

```
---
Finding #X of Y

**Title:** [Brief description]
**Severity:** P1 (Critical) | P2 (Important) | P3 (Nice-to-have)
**Category:** [Security/Performance/Architecture/Bug/etc.]

**Description:**
[What's wrong or could be improved]

**Location:** [file_path:line_number]

**Proposed Fix:**
[How to address it]

**Effort:** Small (<2h) | Medium (2-8h) | Large (>8h)

---

What do you want to do?
1. Accept - Add to task list
2. Skip - Not relevant
3. Modify - Adjust priority/details
4. Merge - Combine with another finding
```

### 3. Handle Decisions

**Accept:** Add to implementation list with all details
**Skip:** Log reason, move to next
**Modify:** Ask what to change, re-present
**Merge:** Combine with another finding

### 4. Track Progress

Show progress after each decision:
```
Progress: 5/12 processed | Accepted: 3 | Skipped: 2
```

### 5. Final Summary

```markdown
## Triage Complete

**Total:** 12 findings
**Accepted:** 7
**Skipped:** 5

### Accepted Items by Priority
P1 (2): ...
P2 (3): ...
P3 (2): ...

### Next Steps
1. Address P1 items first
2. Review task list
3. Start implementation
```