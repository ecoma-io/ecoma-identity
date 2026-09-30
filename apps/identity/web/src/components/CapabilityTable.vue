<!--
  The capability inventory, rendered.

  This is the screen that makes the honest state of the product visible in one
  place: every feature this app knows about, whether it works, and — for the
  ones that do not — the phase they are deferred to and what the endpoint
  actually answers.

  It reads the inventory from `src/capabilities.ts` and renders it. It holds no
  list of its own: a second copy of this table is exactly the drift the
  inventory exists to prevent, and it would be a second thing to update when a
  feature lands.

  Why this screen exists in a bootstrap phase at all: the brief's rule is that
  a reader must be able to tell, from any file, exactly what is real. This is
  that answer, in the UI, for a user who cannot read the source.
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
 * rendered bare in a user-facing table is a developer string. The enum is for
 * the code; this is for the reader.
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
      Every feature this application knows about, and whether the Identity
      Worker answers for it yet.
      <strong>{{ summary.implemented }}</strong> of
      <strong>{{ summary.deferred + summary.implemented }}</strong> are
      available.
    </p>

    <!--
      A real table with a real caption, not a list of divs: this is tabular
      data with three columns, and a screen reader should be able to say which
      feature a given status belongs to.
    -->
    <table class="capability-table">
      <caption class="visually-hidden">
        Feature availability for the Ecoma identity application.
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
