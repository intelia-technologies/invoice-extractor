# Implement Skill

Execute implementation work from a plan file.

## When to use

When the user says `/implement <plan-path>` or asks to start building from a plan.

## Workflow

1. Read the plan file
2. Identify the current phase (first unchecked phase)
3. Implement tasks one by one
4. After each phase, verify the validation criteria
5. Mark tasks as complete in the plan file
6. Move to the next phase

## Guidelines

- **Work in phases** — complete one phase before starting the next
- **Test after each provider** — don't batch all providers, verify each one works
- **Commit after each phase** — keep atomic, reviewable commits
- **Don't over-engineer** — the plan says what to build, build exactly that
