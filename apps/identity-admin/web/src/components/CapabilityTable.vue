<!--
  The capability table: the console's whole feature inventory, rendered.

  This is the screen that makes the honest state of the console visible in one
  place: every administrative feature it knows about, whether it works, and —
  for the ones that do not — the phase it is deferred to and what the endpoint
  actually answers.

  It reads the inventory from `src/capabilities.ts` and renders it. It holds no
  list of its own: a second copy of this table is exactly the drift the
  inventory exists to prevent, and it would be a second thing to update when a
  feature lands.

  One thing this screen is careful not to imply: the badges describe what is
  *built*, not what any particular operator is *permitted* to do. Permission is
  the Admin Worker's answer, decided on the server against the operator's
  session. A table that read as a permission matrix would be a client-side
  authorization check, and an operator would be right to trust it.
-->
<script setup lang="ts">
import { computed } from "vue";

import { CAPABILITIES, phasePhrase, type Capability } from "../capabilities";

/** Every feature, in inventory order. The single source, read not copied. */
const capabilities = computed(() => CAPABILITIES);

/** How many are real, and how many are deferred. Derived, never stored. */
const summary = computed(() => {
  const implemented = capabilities.value.filter(
    (capability) => capability.status === "implemented",
  );
  return {
    implemented: implemented.length,
    deferred: capabilities.value.length - implemented.length,
  };
});

/**
 * The label for a feature's status.
 *
 * Written out rather than reusing the enum value, because `"unimplemented"`
 * rendered bare in an operator-facing table is a developer string. The enum is
 * for the code; this is for the reader.
 */
function statusLabel(capability: Capability): string {
  return capability.status === "implemented"
    ? "Available"
    : "Not available yet";
}
</script>

<template>
  <section class="panel" aria-labelledby="capabilities-heading">
    <h2 id="capabilities-heading" class="panel__heading">What works today</h2>

    <p class="panel__lede">
      Every administrative feature this console knows about, and whether the
      Admin Worker answers for it yet.
      <strong>{{ summary.implemented }}</strong> of
      <strong>{{ summary.deferred + summary.implemented }}</strong> are
      available. These describe what is built; what any given operator may do is
      decided by the Admin Worker, not by this page.
    </p>

    <!--
      A real table with a real caption, not a list of divs: this is tabular data
      with three columns, and a screen reader should be able to say which
      feature a given status belongs to.
    -->
    <table class="capability-table">
      <caption class="visually-hidden">
        Feature availability for the Ecoma Identity operator console.
      </caption>
      <thead>
        <tr>
          <th scope="col">Feature</th>
          <th scope="col">Status</th>
          <th scope="col">Endpoint and behaviour</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="capability in capabilities" :key="capability.id">
          <th scope="row">{{ capability.label }}</th>
          <td>
            <span
              class="badge"
              :class="
                capability.status === 'implemented'
                  ? 'badge--ok'
                  : 'badge--pending'
              "
            >
              {{ statusLabel(capability) }}
            </span>
          </td>
          <td>
            <code class="capability-table__route">{{ capability.route }}</code>
            <span class="capability-table__behaviour">
              {{ capability.backendBehaviour }}
            </span>
            <span
              v-if="capability.status === 'unimplemented'"
              class="capability-table__phase"
            >
              Deferred to {{ phasePhrase(capability.deferredTo) }}.
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
