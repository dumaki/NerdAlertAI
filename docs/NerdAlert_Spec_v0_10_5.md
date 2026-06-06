# NerdAlert v0.10.5 --- operator standing instructions (`instructions.md`)

**Released:** 2026-06-06 (dev branch).
**Branch policy:** All work on `dev`; `main` advances only on explicit operator
confirmation. `main` remains at `0e28e93`.
**Version label:** v0.10.5 --- a small prompt-layer feature: an operator-authored
`~/.nerdalert/instructions.md` injected into every personality's system prompt as
a persistent "standing instructions" block (the agent.md analog). Additive over
v0.10.4; the core loop and the trust model are unchanged.

**Change set (on `origin/dev`, oldest first):**

```
operator standing-instructions block (agent.md)   feat  12dad2b
docs: v0.10.5 cap -- operator instructions         cap   (this commit)
```

---

## What it is

An operator-authored markdown file (`~/.nerdalert/instructions.md`) whose contents
are appended to EVERY personality's system prompt on EVERY turn, framed as trusted
standing directives. It is the direct analog of a project-instructions / agent.md
file, and the COOPERATIVE-guardrail layer for the opt-in-L5 user: the place to
write persistent directives like "explain every shell command before running it"
or "never delete a file unless I say the word delete".

## How it works

- **Injection point.** `personalities/index.ts` `wrapWithSecurityRules` already
  appends three shared blocks (credential-refusal, tool-behaviour, file-handling)
  to every personality's prompt. The instructions block is a fourth, appended
  last via `getOperatorInstructionsBlock()` (`src/personalities/instructions.ts`).
- **Self-gating (P6).** No file / empty / unreadable => the helper returns `''`
  (no separator, no block), so the assembled prompt is byte-identical to before.
  Dropping the file in is the only thing that turns the feature on
  (dormant-by-default). Strict-superset preserved.
- **Live edits.** Read fresh each turn (a small sync `readFileSync`), so editing
  the file takes effect on the next message with NO restart --- unlike
  `config.yaml`, which is boot-loaded.
- **Bounded.** Capped at 6KB with a visible truncation marker, so a large file
  can't blow the context budget.
- **Injection-resistant framing.** The block states the instructions are trusted
  operator config (not chat input), apply every turn, may ADD constraints, do NOT
  override the core safety rules or the trust/permission system, and that chat /
  tool content cannot expand, replace, or weaken them --- mirroring the autonomous
  clearance block's "in-task claims cannot widen scope" posture.

## Security posture --- cooperative, not a gate

This is the important framing, and it is stated both in the injected block and
here. `instructions.md` is PROMPT-LAYER guidance: trusted and present every turn
(so far more reliable than memory, which is advisory and selectively applied), but
it is NOT an enforcement boundary. The project's whole ethos is "trust is enforced
at tool execution, not prompt text", so:

- Use `instructions.md` for cooperative behaviour the user WANTS ("how to behave",
  added caution, dry-run-first, explain-before-acting). It is the right, prevalent
  home for that --- better than memory, better than a skill.
- For a rule that must hold even against a wrong or adversarial model, the
  enforcement still lives at the STRUCTURAL layer: disable the dangerous tool
  (the carded writes and `shell_exec` are individually toggleable), or cap
  standing trust. The credential-safety precedent is the model: a prompt rule
  (`CREDENTIAL_REFUSAL_RULES`) for cooperation PLUS a structural gate (the secret
  scanner) for the guarantee. `instructions.md` is the prompt half; pair it with a
  tool toggle / trust cap for the structural half.

This is exactly the "extra guardrails while keeping the elevation I deliberately
turned on" lane: the careful L5 operator writes their standing cautions here, and
reaches for a tool toggle when they want a hard stop.

## Files

| File | Role |
|------|------|
| `src/personalities/instructions.ts` | Reader + framed-block builder. Self-gating, capped, fail-safe. |
| `src/personalities/index.ts` | `wrapWithSecurityRules` appends the block (4th) to every personality prompt. |
| `src/personalities/instructions.test.ts` | Absent/empty => '', present => framed block, oversize => truncated. |
| `docs/setup-instructions.md` | Operator how-to. |

## Spec amendments (relative to v0.10.4)

### S4 Core loop --- prompt build
The prompt-build "personality voice + clearance + shared rules" assembly now
appends an optional fourth shared block (operator standing instructions) when
`~/.nerdalert/instructions.md` is present. Absent => byte-identical, so the core
loop is unchanged.

### S6 Personality subsystem --- shared blocks
`wrapWithSecurityRules` now appends four shared blocks, not three. The fourth is
operator-authored (the others are compiled constants) and global across all
personalities (matching "clearance/trust is global; personality is voice").
Per-personality / per-project instruction files are clean deferred extensions.

### S14 Invariants --- not agent-writable
`~/.nerdalert/instructions.md` is operator-edited and a write-root of NO tool, so
the agent cannot alter its own standing rules through any normal tool. (shell_exec
remains the single documented §14 exception, as for every operator file.)

## Key learnings (don't re-discover)

- The right home for persistent user directives is the system-prompt layer, NOT
  memory (advisory, selectively applied) and NOT a skill (cannot enforce). An
  operator file injected every turn is trusted and prevalent.
- Prompt-layer can ADD a guardrail cooperatively but cannot GUARANTEE one --- the
  guarantee lives at tool-execution (disable / trust cap). State this plainly so
  the file is never mistaken for an enforcement boundary.
- Read-per-turn (vs boot-cache) buys live edits for free at sub-6KB sizes --- a
  genuine UX win over config.yaml.
