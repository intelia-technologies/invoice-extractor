---
name: brainstorm
description: Explore WHAT to build through collaborative dialogue before committing to a plan
argument-hint: "[idea or problem to explore]"
---

# Brainstorm

Collaborative exploration of WHAT to build before committing to HOW.

## Arguments

<topic> #$ARGUMENTS </topic>

**If no arguments provided:** Ask "What idea or problem would you like to explore?"

## Output Location

All brainstorms saved to: `thoughts/brainstorms/`

## Workflow

### Phase 1: Check for Existing Brainstorms

```bash
ls -la thoughts/brainstorms/ 2>/dev/null || echo "No existing brainstorms"
```

Look for related brainstorms on the same topic. If found, ask:
- "I found an existing brainstorm on [topic]. Should I build on it or start fresh?"

### Phase 2: Initial Understanding

Before proposing approaches, understand the problem space:

1. **Summarize** what you understand from the topic
2. **Ask 2-3 clarifying questions** to probe deeper:
   - What triggered this need?
   - What's the current pain point?
   - What constraints exist (time, tech, compatibility)?
   - Who is affected?

Use direct questions - don't ask obvious things.

### Phase 3: Research Context

**Check existing code and conventions:**
- `CLAUDE.md` - Project rules
- `.claude/rules/` - Specific patterns
- Existing provider JSONs and engine code

### Phase 4: Propose Approaches

Present 2-3 concrete approaches:

```markdown
## Approach 1: [Name]

**Summary:** One-sentence description

**How it works:**
- Step 1
- Step 2
- Step 3

**Pros:**
- Benefit 1
- Benefit 2

**Cons:**
- Drawback 1
- Drawback 2

**Effort:** Small (hours) / Medium (days) / Large (week+)

**Risk level:** Low / Medium / High

---
```

### Phase 5: Dialogue

After presenting approaches, engage in dialogue:

1. Ask which approach resonates
2. Probe for concerns about each
3. Offer to combine approaches
4. Refine based on feedback

Continue until there's a clear direction.

### Phase 6: Write Brainstorm Document

Create the brainstorm file:

```bash
mkdir -p thoughts/brainstorms
```

**Filename:** `YYYY-MM-DD-<topic-slug>-brainstorm.md`

**Content template:**

```markdown
# Brainstorm: [Topic]

**Date:** YYYY-MM-DD
**Status:** Draft | Ready for Planning | Archived

## Problem Statement
[What problem are we solving?]

## Context
### Current State
[What exists today]

### Pain Points
[Specific issues]

### Constraints
- Time: [deadline if any]
- Tech: [required technologies]
- Compatibility: [what must work with]

## Explored Approaches

### Approach 1: [Name]
[Full description]

### Approach 2: [Name]
[Full description]

## Decision

**Selected approach:** [Name]

**Rationale:**
- [Key reason 1]
- [Key reason 2]

**Deferred for later:**
- [Thing we consciously chose not to do now]

## Open Questions
- [ ] Question 1
- [ ] Question 2

---

## Next Steps

Ready for `/workflows:plan`? Run:
/workflows:plan thoughts/brainstorms/YYYY-MM-DD-<topic>-brainstorm.md
```

### Phase 7: Handoff

After writing the brainstorm:

1. Confirm the file was created
2. Summarize the selected approach
3. Offer next steps:
   - `/workflows:plan [brainstorm-path]` - Create implementation plan
   - `/spec` - If more detailed requirements gathering needed
   - Continue exploring - If not ready to commit

## Guidelines

- **Be a thought partner**, not just a question-asker
- **Propose concrete options** - don't wait for perfect info
- **Challenge assumptions** - ask "why" and "what if"
- **Keep focus** - one brainstorm = one topic
- **Time-box** - brainstorming should take 15-30 minutes max

## Stack-Specific Considerations

For this Chrome extension:

- **Provider changes:** Consider backward compatibility with existing JSON schema
- **Engine changes:** Consider impact on all existing providers
- **Download methods:** Consider Chrome extension permissions and security
- **UI changes:** Consider popup vs floating window behavior

## Quality Criteria

A brainstorm is ready for planning when:

- [ ] Problem statement is clear and specific
- [ ] At least 2 approaches were considered
- [ ] Pros/cons are honest (not just selling one approach)
- [ ] Decision rationale is documented
- [ ] Open questions are captured