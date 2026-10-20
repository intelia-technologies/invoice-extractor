---
name: plan
description: Plan HOW to build - create structured implementation plan with phases and tasks
argument-hint: "[brainstorm path or clear requirements]"
---

# Plan

Create a structured implementation plan for HOW to build something.

## Arguments

<input> #$ARGUMENTS </input>

**If no arguments provided:**
1. Check for recent brainstorms: `ls -la thoughts/brainstorms/ | head -10`
2. Ask: "Which brainstorm should I create a plan for? Or describe what you want to build."

## Output Location

All plans saved to: `thoughts/plans/`

## Workflow

### Phase 1: Gather Context

#### 1.1 Check for Brainstorm Input

If input is a brainstorm file path, read it to extract:
- Selected approach
- Constraints
- Open questions

If input is raw requirements, proceed to Phase 2.

#### 1.2 Check Existing Plans

```bash
ls -la thoughts/plans/ 2>/dev/null || echo "No existing plans"
```

Avoid duplicating existing plans on the same topic.

### Phase 2: Local Research

**ALWAYS do local research before external research.**

#### 2.1 Codebase Patterns

Look for:
- Similar implementations to reference
- Existing provider JSONs for schema patterns
- Engine code for extension points
- Conventions to follow

#### 2.2 Project Conventions

Read and summarize relevant conventions from:
- `CLAUDE.md` - Project rules
- `.claude/rules/` - Specific patterns (provider schema, etc.)
- Existing code in the area being modified

### Phase 3: Conditional External Research

**Only do external research if:**
- Topic is complex (new Chrome API, new download method)
- No good internal patterns exist
- User explicitly requests it

### Phase 4: Create Plan Structure

**Filename:** `YYYY-MM-DD-<type>-<name>-plan.md`

Where `<type>` is one of:
- `feat` - New feature
- `fix` - Bug fix
- `refactor` - Code improvement
- `chore` - Maintenance task

**Plan template:**

```markdown
# Plan: [Title]

**Date:** YYYY-MM-DD
**Type:** feat | fix | refactor | chore
**Status:** Draft | Ready | In Progress | Complete
**Brainstorm:** [link if exists]

## Overview

### Problem
[What problem does this solve?]

### Solution
[High-level approach]

### Success Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Technical Approach

### Architecture
[How components interact]

### Key Decisions
| Decision | Rationale |
|----------|-----------|
| Use X instead of Y | Because... |

### Files to Modify
| File | Change Type | Purpose |
|------|-------------|---------|
| engine.js | Modify | Add new method |
| providers/new.json | Create | New provider |

## Implementation Phases

### Phase 1: [Name] (Est: Xh)

**Goal:** [What this phase accomplishes]

Tasks:
- [ ] Task 1.1: Description
- [ ] Task 1.2: Description

**Validation:**
- [ ] How to verify phase is complete

## Verification

**Environment:** Local (Chrome with extension loaded unpacked)

1. Reload extension in chrome://extensions
2. [Specific test steps]

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Risk 1 | Low/Med/High | Low/Med/High | How to address |

## Dependencies

- **Blocking:** [Things that must be done first]
- **External:** [External services, APIs, etc.]

## Rollback Plan

[How to undo if something goes wrong]

---

## Next Steps

Ready to implement? Run:
/workflows:work thoughts/plans/YYYY-MM-DD-<type>-<name>-plan.md
```

### Phase 5: Estimate & Validate

For each phase:

1. **Estimate time** based on complexity
2. **Check feasibility**: Are all dependencies available?

### Phase 6: Write Plan

```bash
mkdir -p thoughts/plans
```

Write the plan file with all sections filled in.

### Phase 7: Handoff

After writing the plan, present:

1. **Summary:** Total estimated time, number of phases, key risks
2. **Offer next steps:**
   - `/workflows:work [path]` - Start implementation
   - Continue refining - If not ready

## Quality Criteria

A plan is ready for implementation when:

- [ ] All phases have clear tasks
- [ ] Time estimates are provided
- [ ] Risks are identified with mitigations
- [ ] Success criteria are measurable
- [ ] Verification steps are defined
- [ ] Rollback plan exists