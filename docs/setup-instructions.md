# Operator standing instructions (`instructions.md`)

NerdAlert reads an optional file at `~/.nerdalert/instructions.md` and injects its
contents into the agent's system prompt on every turn, for every personality. It
is the equivalent of a project-instructions / agent.md file: a persistent place
for "how I want you to behave" directives that should hold across all
conversations.

## Setup

There is nothing to enable --- the feature is presence-based:

```
$EDITOR ~/.nerdalert/instructions.md
```

Write plain markdown / bullet points. Edits take effect on your next message (no
restart needed). The file is capped at ~6KB. To turn it off, delete or empty the
file.

## What to put in it

Good fits --- cooperative behaviour you want by default:

```
- Before running any shell_exec command, explain in one line what it will do.
- Prefer dry-runs; show me the diff before you apply a change.
- Never delete a file unless I use the word "delete" in my request.
- Keep responses concise; lead with the answer.
```

## Important: cooperative, not a hard gate

`instructions.md` is prompt-layer guidance. It is trusted (operator config, not
chat input) and present every turn, so it is far more reliable than memory --- but
it is NOT an enforcement boundary. A capable model will follow it; a confused or
adversarial one might not.

For a rule that must hold no matter what, use the STRUCTURAL controls instead (or
as well):

- Disable the dangerous tool in `config.yaml` (e.g. turn off `shell_exec`,
  `gmail_cleanup`, `cron_delete`, ...) --- a disabled tool cannot run regardless
  of any instruction.
- Keep standing `trust_level` below the tier that reaches the tool you want to
  forbid.

Think of it the way NerdAlert handles credentials: a prompt rule asks the model
not to accept secrets, and a separate scanner guarantees it. `instructions.md` is
the "ask nicely" half; a tool toggle or trust cap is the "guarantee" half.
