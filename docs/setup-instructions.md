# Operator standing instructions (`instructions.md`)

NerdAlert reads an optional file at `~/.nerdalert/instructions.md` and injects its
contents into the agent's system prompt on every turn, for every personality. It
is the equivalent of a project-instructions / agent.md file: a persistent place
for "how I want you to behave" directives that should hold across all
conversations.

## Setup (the easy way: the Instructions panel)

Click the **pencil (Instructions) icon** in the dock. It opens an editor showing
the current instructions (empty by default), the file path, and a byte counter.
Type your directives, click **SAVE**, and they take effect on your next message
(no restart needed). Clearing the box and saving turns the feature off (the file
is deleted). The editor is capped at ~6KB and rejects an over-cap save rather than
truncating your text.

The panel writes the file through a direct, loopback-only route that bypasses the
agent entirely --- the same discipline as the credential and tool-toggle panels.
The agent has no way to edit its own standing instructions.

## Setup (the manual way)

The feature is presence-based, so you can also just create the file yourself:

```
$EDITOR ~/.nerdalert/instructions.md
```

Write plain markdown / bullet points. Same behavior: edits take effect on your
next message, and deleting or emptying the file turns it off.

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
