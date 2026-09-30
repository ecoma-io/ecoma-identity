<!--
  The audit log screen.

  What it is: where an operator reads the record of security-relevant changes —
  who suspended whom, when, and under which session. In the bootstrap phase it is
  a statement that the query is not served.

  What it is not: an empty audit log, and this is the single most important
  absence in the whole console.

  Events *are* being recorded. The server records them regardless of whether
  anyone can read them back; only the query is deferred. So an empty table here
  would be asserting that nothing has happened — during an incident, to the
  person investigating it. "No events" is a specific, alarming, and completely
  false claim, and a console that made it would send an operator to conclude
  that a compromise left no trace when in fact the trace exists and this screen
  simply cannot show it.

  The screen therefore renders the deferral and the endpoint, and nothing else.
  The data contract the future query returns is in `src/api/contracts.ts` as
  types — `AdminAuditRow`, `QueryAudit`, `QueryAuditOutcome` — with no values
  behind them, so a reviewer looking for the source of any row on screen will
  find that there isn't one.
-->
<script setup lang="ts">
import CapabilityGate from "../../components/CapabilityGate.vue";
</script>

<template>
  <section class="screen" aria-labelledby="audit-heading">
    <h1 id="audit-heading" class="screen__heading">Audit log</h1>

    <p class="screen__lede">
      Every security-relevant change, who made it, and under which session. This
      is the record an incident review is built from.
    </p>

    <CapabilityGate feature-id="audit-log">
      <p class="screen__note">
        The audit filters and the event table will appear here.
      </p>
    </CapabilityGate>

    <p class="screen__footnote">
      Events are being recorded now. Only reading them back is deferred, so this
      screen shows an unavailable query rather than an empty result — those are
      very different things during an incident.
    </p>
  </section>
</template>
