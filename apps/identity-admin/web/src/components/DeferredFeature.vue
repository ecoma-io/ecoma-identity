<!--
  The one component every deferred administrative screen renders.

  It exists so that "this is not built yet, and here is the phase it is
  deferred to" is written once. Every screen that gates on a capability renders
  this rather than inventing its own empty state, because the failure mode this
  guards against is a screen that renders an *empty* list and leaves the
  operator to conclude the platform is empty rather than unbuilt.

  That failure mode is sharper here than it would be in a user-facing app. An
  empty user table claims there are no users; an empty audit log claims nothing
  has been recorded, which is the specific and alarming claim an operator
  investigating an incident must never be given by a query that does not exist.
  Both are security-relevant, and neither is a fact this console is entitled to
  assert.

  What it deliberately does not do:
  - It does not show a retry control when the capability is unimplemented.
    There is nothing to retry; a button that re-issues a request known to
    answer 501 only teaches an operator to click it and burn their rate limit.
  - It does not show sample data, a skeleton, or a spinner. Nothing here ever
    resolves into content, so nothing pretends to be loading.
  - It does not offer a sign-up or contact link. There is nothing to join.

  The one place it *does* vary is the `errorState` prop: when a screen actually
  called the API and got something other than a 501 — a 5xx, an unreachable
  network — that is a different fact and gets a different message, with the
  request id that makes it actionable.
-->
<script setup lang="ts">
import { computed } from "vue";

import type { ErrorState } from "../api/errors";
import { deferralSentence, type Capability } from "../capabilities";

const props = defineProps<{
  /** The feature this screen would have shown. */
  capability: Capability;
  /**
   * The failure to show instead of the deferral, when the screen did call the
   * API and got something other than a 501. `undefined` means "the screen
   * knows from the capability inventory alone that this is deferred", which is
   * the case for every screen in the bootstrap phase.
   *
   * Typed as `ErrorState | undefined` rather than a bare optional, because
   * `exactOptionalPropertyTypes` is on: a plain `errorState?: ErrorState` would
   * permit the *absence* of the prop but reject passing an explicit
   * `undefined`, which is exactly what `CapabilityGate` does when it forwards
   * a computed that has not settled.
   */
  errorState?: ErrorState | undefined;
}>();

/**
 * The headline. The deferral sentence names the feature and the phase; an
 * error state brings its own title, which is the correct headline for a
 * failure that is not about the implementation.
 */
const heading = computed(() => props.errorState?.title ?? "Not available yet");

/** The body: the deferral sentence, or the error's detail. */
const detail = computed(
  () =>
    props.errorState?.detail ??
    deferralSentence(props.capability) ??
    `${props.capability.label} is available.`,
);

/**
 * The secondary line naming the endpoint and what it actually answers.
 *
 * This is the line that makes the screen *verifiable* rather than merely
 * apologetic: a reader can curl the route and check that it really does answer
 * 501. An empty state that only says "coming soon" cannot be checked against
 * anything.
 *
 * Hidden when an error state is shown, because in that case the endpoint is not
 * the story — the server-side failure is, and printing "answers 501" next to a
 * 500 would be a contradiction.
 */
const backendNote = computed(() =>
  props.errorState
    ? undefined
    : `${props.capability.route} — ${props.capability.backendBehaviour}`,
);

/**
 * The request id, when there is one. Rendered inside the `aria-live` region
 * below so a screen-reader user hears the same thing a sighted user reads.
 */
const requestId = computed(() => props.errorState?.requestId);
</script>

<template>
  <section class="panel deferred" aria-labelledby="deferred-heading">
    <!--
      `role="status"` with `aria-live="polite"` rather than `role="alert"`: the
      deferral is the screen's settled state, not an interruption. An assertive
      region would interrupt a screen reader on every navigation to a screen
      that has never worked.
    -->
    <div class="deferred__body" role="status" aria-live="polite">
      <h2 id="deferred-heading" class="deferred__heading">{{ heading }}</h2>
      <p class="deferred__detail">{{ detail }}</p>

      <p v-if="backendNote" class="deferred__backend">
        <span class="deferred__label">Endpoint</span>
        <code>{{ backendNote }}</code>
      </p>

      <p v-if="requestId" class="deferred__request-id">
        <span class="deferred__label">Request id</span>
        <code>{{ requestId }}</code>
      </p>

      <!--
        No retry control is rendered for a deferred feature, and that is the
        intended absence rather than a missing feature. The route answers 501
        deterministically; re-issuing the request cannot change the answer.
      -->
    </div>
  </section>
</template>
