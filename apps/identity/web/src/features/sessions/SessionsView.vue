<!--
  The session management screen.

  What it is: where a user sees the sessions holding their account open and
  revokes the ones they do not recognise.

  What it is not, and this is the most important thing on this screen: it does
  not render an empty list. An empty session list is a security claim — "you
  have one session, this one" — and a user reading an empty table during an
  incident would draw the exact wrong conclusion. So the screen renders the
  deferred state, which says the query does not exist, instead of an empty
  table that says the answer is "nothing to see".

  The gate lives in `CapabilityGate` and is read from the capability inventory,
  so the decision to render the deferral is made **before** any network call.
  That is not an optimisation: it means the app never issues a request it knows
  will answer 501, never shows a spinner, and never has a moment where a user
  could read a spinner as "loading your sessions".
-->
<script setup lang="ts">
import CapabilityGate from "../../components/CapabilityGate.vue";
</script>

<template>
  <section class="screen" aria-labelledby="sessions-heading">
    <h1 id="sessions-heading" class="screen__heading">Your sessions</h1>

    <p class="screen__lede">
      Every signed-in session holding your account open, and a way to end the
      ones you do not recognise.
    </p>

    <!--
      The gate's default slot holds the implemented path. It is empty by
      construction — the query is not implemented, so the slot never renders —
      but it is written down rather than omitted, so the shape of a working
      screen is reviewable. When the Worker implements `/self-service/sessions`
      the slot is filled and the deferral retires with no change above it.
    -->
    <CapabilityGate feature-id="sessions">
      <p class="screen__note">
        Your sessions will be listed here, with the current one marked and a
        control to revoke each.
      </p>
    </CapabilityGate>

    <p class="screen__footnote">
      Signing out everywhere revokes every session you have, including this one.
      When it works, it will only report success once the Identity Worker
      confirms it — this application cannot end a session by itself, because it
      cannot read the cookie that holds it.
    </p>
  </section>
</template>
