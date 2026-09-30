# <The decision, as a statement>

<!--
What this file is: the MADR template every ADR in this directory is copied from.

What this file is **not**: a decision. `0000-template.md` is a scaffold with
placeholder prose in every section. It is never edited to record a real decision —
it is copied, and the copy is renamed to the next free number.

House rules this template encodes, because they are the ones that get broken:

  1. The **title** is the decision as a statement, not a topic. "Identity D1 is
     reachable only by the Identity Worker", never "Database access". A reader who
     reads only the title and the status should already know what was decided.
  2. **Status** is one of `Proposed`, `Accepted`, `Deprecated`, `Superseded by
     ADR-NNNN`. Every ADR in this directory that is not `Proposed` is in force.
  3. **Context** is specific to *this* system. Generic architecture prose is the
     failure mode here: a reader must be able to disagree with the decision, and
     they can only do that if the forces are real.
  4. **Decision** is in the active voice, as an instruction to the next person.
     "The Admin Worker does not hold a D1 binding", not "it might be considered".
  5. **Consequences** is the honest column, in both directions. A consequences
     section that lists only benefits is marketing. Name what a future maintainer
     will resent, because that is what tells them when to revisit.
  6. **Alternatives considered** gets at least two entries, each with the actual
     reason it lost. "Rejected because it is bad practice" is not a reason.
  7. **Revisit when** names observable conditions, not feelings. This is the
     section most ADRs omit and it is the reason an ADR is not dead weight.
  8. Every decision that establishes a boundary names **where it is enforced**:
     the architecture checker, a wrangler config, a CI workflow, a compile-time
     attribute, or a database constraint. If none of those exists yet, the ADR
     says so and names what the enforcement will be.
  9. Nothing here describes unimplemented behaviour in the present tense. Where
     the code does not exist yet, the ADR says "will" and names the phase.
 10. An Enforcement table's third column says what exists **today**, and a cell
     that says "not yet built" names what should land. If a file another author is
     still writing is the enforcement, the ADR names the path and says it is
     landing concurrently — it never claims to have read a file it has not read.
-->

- **Status:** Proposed
- **Date:** YYYY-MM-DD
- **Deciders:** <!-- who accepted this; a person, not a team -->
- **Technical story:** <!-- optional: the issue or PR this closes -->
- **Constraints covered:** <!-- numbers from the founding list, 1-29. Number 29
     is the meta-constraint: a change to any of the others requires an ADR
     before the change, and every ADR in this directory cites it. The numbered
     constraints are restated as SC-1 … SC-24 in
     ../security/security-constraints.md, which is the owner document for them -->

## Context

<!--
What problem exists. What constraints bind it. What people have to live with if
the decision goes the other way.

Name the concrete thing: the binding, the table, the type, the command, the file.
`IDENTITY_DB`, `PlatformRole`, `OutboxEventId`, `security_version` — a reader
should be able to grep this section.
-->

## Decision drivers

<!--
What made this decision hard. These are the forces that eliminated the options in
"Alternatives considered" — write them before the options, not after, so the
elimination is visible.

A short list is fine. Five real drivers beat fifteen generic ones.
-->

## Decision

<!--
What was decided, in the active voice, as an instruction.

Then, under a bold lead-in, where it is enforced:

**Enforcement:** <the architecture checker, the wrangler config, the CI job, the
compile-time attribute, the database constraint> — or, if it does not exist yet:
"enforcement not yet built; it will be <what>, in the <phase> phase."
-->

## Consequences

### Easier

<!-- What this makes cheaper, safer or more obvious. Be concrete about the
mechanism, not the benefit: "a reviewer checks one grep" beats "simpler". -->

### Harder or more expensive

<!-- What this makes worse. Name the friction you expect to feel, in the terms the
next person will feel it in. -->

### What a future maintainer will resent

<!--
The line that saves the most time, three years from now. Not "this is a downside"
in general — the specific sentence someone will say when they are tempted to
change this decision without reading it.
-->

## Alternatives considered

### <Alternative, as a noun phrase>

<!--
What it was, and the **actual** reason it lost — specific to this system. If it
was genuinely close, say so and say what would have changed the answer.
-->

## Revisit when

<!--
The observable conditions that should reopen this decision. A bullet list of
things that can be *seen or measured*, not opinions:

- "if <platform> ships <specific capability>"
- "if <a second deployable> appears with a different data-ownership story"
- "if <a metric> crosses <a threshold>"

"if it becomes inconvenient" is not a condition; "if a support workflow needs a
read the binding cannot serve within one round trip" is.
-->

## Related

- [ADR-NNNN — title](NNNN-title.md) — <!-- the relationship: depends on,
  extends, is the enforcement for. Replace both NNNNs with a real number and a
  real filename; every ADR links to real files in this directory, and a link that
  does not resolve is a broken cross-reference a reader cannot follow -->
- `path/to/owner/document.md` — the document that owns the consequences of this
  decision. ADRs state decisions; the owner document states what follows.
