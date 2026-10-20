---
description: Split a long function into smaller focused functions
---

# Split Function

Take the function at the specified location and split it into smaller, well-named functions.

## Arguments

<target> #$ARGUMENTS </target>

If no target specified, ask: "Which function should I split? (file:function_name or file:line_number)"

## Workflow

1. Read the target file
2. Identify the function to split
3. Analyze its responsibilities
4. Extract logical units into separate functions
5. Ensure the original function calls the extracted ones
6. Verify no behavior changes

## Guidelines

- Each extracted function should do ONE thing
- Use descriptive names that explain WHAT, not HOW
- Keep the original function as orchestrator
- Preserve all error handling
- Don't change the public API/signature of the original function