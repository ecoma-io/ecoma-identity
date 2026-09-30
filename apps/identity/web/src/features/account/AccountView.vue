<!--
  The account screen.

  What it is: the caller's own view of their account — display name, verified
  addresses, linked identities, and the assurance level of the current session.
  In the bootstrap phase it is also the one screen that demonstrates a real
  state this app can be in: the session store's three-valued answer
  (unknown / signed-out / signed-in), which is the honest consequence of the
  session cookie being unreadable from JavaScript.

  What it is not: a profile page with sample data. The data-contract types in
  `api/contracts.ts` describe exactly what this screen will render and
  construct nothing, so there is no fixture to fall back on if the fetch fails.
  When the fetch fails — and in the bootstrap phase it does, with a 501 — the
  screen shows the deferral, and the session line above it keeps whatever
  answer the server actually gave.
-->
<script setup lang="ts">
import { computed } from "vue";

import CapabilityGate from "../../components/CapabilityGate.vue";
import { useSessionStore } from "../../stores/session";

const session = useSessionStore();

/**
 * The session line, in the three states the store distinguishes.
 *
 * The `unknown` branch is not filler. It is the state this app spends all of
 * the bootstrap phase in, and it is the honest answer to a question the client
 * structurally cannot answer: the cookie is `HttpOnly`, so there is no reading
 * of it available here, and pretending otherwise would require storing a
 * "signed in" flag somewhere script can read.
 */
const sessionLine = computed(() => {
  switch (session.status) {
    case "signed-in":
      return `Signed in as ${session.account?.display_name ?? "an unnamed account"}.`;
    case "signed-out":
      return "You are not signed in. The Identity Worker answered 401.";
    case "unknown":
    default:
      return (
        "Session state is unknown. This application cannot read the session " +
        "cookie, so only the Identity Worker can say whether you are signed " +
        "in, and the account query below has not answered yet."
      );
  }
});

/**
 * The assurance line, rendered only when there is a real account.
 *
 * Reading `session.account` inside a `v-if` on the same computed is why this is
 * safe under `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`: the
 * null check happens in the template's `v-if`, and the optional access in the
 * interpolation cannot be reached without it.
 */
const assuranceLine = computed(() => {
  const account = session.account;
  if (account === null) {
    return "";
  }
  const level = account.aal === "aal2" ? "two factors" : "one factor";
  return (
    `This session is authenticated at ${level} (${account.aal}).` +
    (account.step_up_required
      ? " Sensitive operations will ask for a second factor first."
      : "")
  );
});
</script>

<template>
  <section class="screen" aria-labelledby="account-heading">
    <h1 id="account-heading" class="screen__heading">Your account</h1>

    <p class="screen__lede">
      Your display name, your verified addresses, and any external identity you
      have linked.
    </p>

    <!--
      `role="status"` so the change from "unknown" to a settled answer is
      announced. It is a real state change, not decoration, and it is the
      answer to a question the user is implicitly asking by opening this page.
    -->
    <p class="screen__note" role="status" aria-live="polite">
      {{ sessionLine }}
    </p>

    <CapabilityGate feature-id="account">
      <p class="screen__note">{{ assuranceLine }}</p>
    </CapabilityGate>

    <p class="screen__footnote">
      Your role and status are shown here but cannot be changed from this
      screen. Only an administrator can change a role, and an administrator
      cannot change their own — that rule belongs to the server, and this
      application does not offer a control that the server would refuse.
    </p>
  </section>
</template>
