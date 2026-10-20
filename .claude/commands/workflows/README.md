# Workflow Pipeline

A development pipeline: **brainstorm -> plan -> work -> compound -> review**.

## The Pipeline

```
                    [BRAINSTORM]
                         |
                         v
                      [PLAN]
                    /        \
              [DEEPEN]   [PLAN-REVIEW]
                    \        /
                         v
                      [WORK]
                         |
                    +---------+
                    |         |
                    v         v
              [COMPOUND]   [REVIEW]
```

## Commands

### 1. `/workflows:brainstorm` - Explore WHAT to build

Collaborative dialogue to refine an idea before committing to a plan.

**Input:** Vague idea or problem statement
**Output:** `thoughts/brainstorms/YYYY-MM-DD-<topic>-brainstorm.md`
**Next:** `/workflows:plan`

### 2. `/workflows:plan` - Plan HOW to build

Create a structured implementation plan with phases and tasks.

**Input:** Brainstorm output or clear requirements
**Output:** `thoughts/plans/YYYY-MM-DD-<type>-<name>-plan.md`
**Next:** `/workflows:work`

### 3. `/workflows:work` - Execute the plan

Turn the plan into working code with incremental commits.

**Input:** Plan file path
**Output:** Git commits, PR
**Next:** `/workflows:compound`, `/workflows:review`

### 4. `/workflows:compound` - Capture what was learned

Extract and persist learnings from the development session.

**Input:** Conversation context (auto-detect)
**Output:** Updated CLAUDE.md, rules, learnings docs

### 5. `/workflows:review` - Code review

Review changes for provider schema compliance and engine correctness.

**Input:** Files/PR to review
**Output:** Findings with fix instructions

## Directory Structure

```
thoughts/
  brainstorms/        # /workflows:brainstorm outputs
  plans/              # /workflows:plan outputs
  learnings/          # /workflows:compound outputs (detailed)
```

## Typical Flow

```bash
/workflows:brainstorm add pagination support for large invoice lists
# -> Explores approaches, outputs brainstorm doc

/workflows:plan thoughts/brainstorms/2026-03-10-pagination-brainstorm.md
# -> Creates detailed implementation plan

/workflows:work thoughts/plans/2026-03-10-feat-pagination-plan.md
# -> Implements, tests, creates PR

/workflows:compound
# -> Captures what was learned
```

## When to Use Each

| Scenario | Start With |
|----------|-----------|
| Vague idea, need exploration | `/workflows:brainstorm` |
| Clear requirements, need structure | `/workflows:plan` |
| Have a plan, ready to implement | `/workflows:work` |
| Just solved something, want to remember | `/workflows:compound` |
| Code ready, need quality check | `/workflows:review` |