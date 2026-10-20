---
name: compound
description: Capture what was learned - extract and persist learnings for future sessions
argument-hint: "[optional: specific topic to capture]"
---

# Compound

Extract and persist learnings from the development session for future sessions.

> "Compounding knowledge is the compound interest of software engineering."

## Trigger Detection

**Auto-detect these signals in conversation:**
- "that worked"
- "it's fixed"
- "finally figured out"
- "the problem was"
- "turns out"

When detected, proactively suggest: "Want me to capture this learning with `/workflows:compound`?"

## Arguments

<topic> #$ARGUMENTS </topic>

**If no arguments provided:** Analyze the current conversation for learnings.

## Output Location

Learnings are stored in:

| Type | Location | When |
|------|----------|------|
| Project learnings | `CLAUDE.md` (Learnings section) | Chrome extension quirks, provider patterns |
| Provider patterns | `.claude/rules/provider-schema.md` | New schema patterns discovered |
| Detailed solutions | `thoughts/learnings/` | Complex problem-solution pairs |

## Workflow

### Phase 1: Extract Learnings

Analyze the conversation and identify:

1. **Problem-Solution Pairs:** What went wrong? What worked?
2. **Chrome Extension Quirks:** Manifest V3 gotchas, permissions, API limitations
3. **Provider Patterns:** New patterns for extracting invoices
4. **DOM Quirks:** Site-specific DOM structure insights

### Phase 2: Classify

| Category | Description | Example |
|----------|-------------|---------|
| CHROME_QUIRK | Chrome extension API behavior | "executeScript world: MAIN required for DOM access" |
| PROVIDER_PATTERN | Reusable invoice extraction pattern | "Stripe receipts need open-tabs, not direct-link" |
| DOM_INSIGHT | Site DOM structure detail | "Vultr duplicates download links per row" |
| DEBUGGING_TIP | How to diagnose issues | "Check console in target tab, not popup" |
| SCHEMA_EXTENSION | New JSON schema capability needed | "preSteps needed for tabbed billing pages" |

### Phase 3: Write Learnings

1. **Check for duplicates** in existing CLAUDE.md and rules
2. **Write to appropriate location**
3. **Include concrete examples**

### Phase 4: Summary

```markdown
## Learnings Captured

### CLAUDE.md
- **[Chrome] Description**: Details

### Provider Schema Updates
- Added new pattern to `.claude/rules/provider-schema.md`

### Detailed Solutions
- `thoughts/learnings/YYYY-MM-DD-<topic>.md`
```

## Guidelines

1. **Capture immediately** - Don't wait until session end
2. **Be specific** - Include error messages, exact selectors
3. **Include context** - When does this matter?
4. **Avoid duplicates** - Check existing learnings first