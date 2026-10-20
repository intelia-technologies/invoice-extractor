## Arguments
`$ARGUMENTS` should contain the project name/description. If not provided, ask the user to describe what they want to build.

## Task
Build a spec for: $ARGUMENTS

Use the AskUserQuestion tool (Claude's native capability for gathering user input with structured options) to interview me and gather requirements about:
- Project implementation approach
- UI & UX considerations
- Tech stack decisions
- Concerns and constraints
- Tradeoffs to consider

Make sure questions probe deeper into underlying needs - avoid obvious questions.

Interview me systematically until the spec is complete. Document all responses to create a comprehensive specification that serves as the foundation for the project.