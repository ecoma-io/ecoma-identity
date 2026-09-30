<!--
  The capability gate: the one place a screen decides between "render the real
  thing" and "render the honest deferral".

  Screens do not each re-implement this. That is not a style preference: a gate
  written per screen is a gate that some screen will get subtly wrong, and the
  ways it goes wrong are all invisible in review — a screen that checks the
  capability *after* fetching, a screen that renders its empty state and the
  deferral together, a screen that treats "not implemented" as "no data".

  The rule this component enforces:
  - Not implemented → render the deferral and **nothing else**. The default
    slot is not rendered at all, so a screen cannot accidentally leak a
    skeleton, an empty table, or a "0 results" line next to a message saying
    the query does not exist.
  - Implemented → render the slot, and the slot is responsible for its own
    loading and error states.

  The decision is made *before* any fetch, by reading the inventory. A screen
  using this component therefore never issues a request it knows will answer
  501, never shows a spinner that resolves to nothing, and never shows a
  spinner at all in the bootstrap phase.
-->
<script setup lang="ts">
import { computed } from "vue";

import DeferredFeature from "./DeferredFeature.vue";
import { capabilityFor, isImplemented, type Capability } from "../capabilities";
import type { ErrorState } from "../api/errors";

const props = defineProps<{
  /** The feature id to gate on, as it appears in the inventory. */
  featureId: string;
  /**
   * The failure to show when the feature *is* implemented but the call failed
   * for a reason other than a 501 — a 5xx, an unreachable Worker. Ignored while
   * the feature is unimplemented, because then the deferral is the whole truth.
   *
   * `ErrorState | undefined` rather than a bare optional, for the
   * `exactOptionalPropertyTypes` reason documented on `DeferredFeature`.
   */
  errorState?: ErrorState | undefined;
}>();

/**
 * The inventory entry, or `undefined` for an id the inventory does not know.
 *
 * A missing entry is treated as **not implemented** (see below), and the
 * deferral falls back to a sentence that names the unknown id. That is a
 * visible, obviously-wrong state — a reviewer sees "unknown feature" on a
 * screen and fixes the id — rather than a crash that takes the app down.
 */
const capability = computed<Capability | undefined>(() =>
  capabilityFor(props.featureId),
);

/**
 * Whether the feature is real. An unknown id is `false`: a screen asking about
 * a feature that is not in the inventory must not get the benefit of the doubt
 * and render its real content on the strength of a typo.
 */
const implemented = computed(() => isImplemented(props.featureId));
</script>

<template>
  <DeferredFeature
    v-if="!implemented && capability"
    :capability="capability"
    :error-state="errorState"
  />

  <!--
    The unknown-id fallback. Rendered instead of the slot so an id typo shows
    a wrong screen rather than a working one.

    `deferredTo: 'phase 0'` because this is a defect in the phase the repository
    is standing in, not work scheduled for a later one — and a hand-built
    capability still has to satisfy the same closed union as the table, so a
    missing phase here would be a type error rather than a second owner.
  -->
  <DeferredFeature
    v-else-if="!implemented"
    :capability="{
      id: featureId,
      label: 'This screen',
      route: 'an endpoint this application does not name',
      status: 'unimplemented',
      deferredTo: 'phase 0',
      backendBehaviour: 'unknown — no inventory entry names this feature.',
    }"
  />

  <slot v-else />
</template>
