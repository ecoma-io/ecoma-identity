<!--
  The operator session screen.

  What it is: the console's own header, showing who is signed in and at what
  assurance level — and, in the bootstrap phase, a statement that the console
  cannot determine either.

  What it is not, and this is the part worth reading: it is not an
  authorization check, and it is not a login screen.

  The administrative session cookie is `HttpOnly` and `Secure`, so this app
  cannot read it. There is no way to inspect "am I signed in" or "what role do I
  hold" from here, and therefore no way to render a control whose visibility
  depends on either. Every screen in this console renders behind its own
  capability gate, and every command is authorized by the Admin Worker on the
  server, against the resolved session and the AAL.

  A console that branched its UI on a client-side "is an administrator" flag
  would be worse than useless here: it would create the impression that access
  is controlled in the browser, which is the one place it is not controlled at
  all. So this screen reports three states — signed in, signed out, and unknown —
  and "unknown" is the honest one to spend the bootstrap phase in.
-->
<script setup lang="ts">
import { computed } from "vue";

import CapabilityGate from "../../components/CapabilityGate.vue";
import { useOperatorStore } from "../../stores/operator";

const operator = useOperatorStore();

/**
 * The session line, in the three states the store distinguishes.
 *
 * The `unknown` branch is not filler. It is the state this console spends all of
 * the bootstrap phase in, and it is the honest answer to a question the client
 * structurally cannot answer.
 */
const sessionLine = computed(() => {
  switch (operator.status) {
    case "signed-in":
      return `Signed in as ${operator.session?.display_name ?? "an unnamed operator"} (${operator.session?.role ?? "unknown role"}).`;
    case "signed-out":
      return "You are not signed in. The Admin Worker answered 401.";
    case "unknown":
    default:
      return (
        "Operator session state is unknown. This console cannot read its own " +
        "session cookie, so only the Admin Worker can say whether you are " +
        "signed in, and the session query has not answered yet."
      );
  }
});

/**
 * The assurance line, rendered only when there is a real session.
 *
 * The AAL matters here because every command that changes someone's security
 * posture requires an AAL2 session. A console that showed an AAL1 operator an
 * administrative action and let them discover the refusal by clicking it would
 * be wasting an operator's time during an incident.
 */
const assuranceLine = computed(() => {
  const session = operator.session;
  if (session === null) {
    return "";
  }
  const level = session.aal === "aal2" ? "two factors" : "one factor";
  return (
    `This session is authenticated at ${level} (${session.aal}).` +
    (session.step_up_required
      ? " The Admin Worker will require a step-up before sensitive actions."
      : "")
  );
});
</script>

<template>
  <section class="screen" aria-labelledby="operator-heading">
    <h1 id="operator-heading" class="screen__heading">Operator session</h1>

    <p class="screen__lede">
      Who is signed in to this console, and how strongly their session is
      authenticated.
    </p>

    <!--
      `role="status"` so the change from "unknown" to a settled answer is
      announced: it is a real state change, not decoration.
    -->
    <p class="screen__note" role="status" aria-live="polite">
      {{ sessionLine }}
    </p>

    <CapabilityGate feature-id="operator-session">
      <p class="screen__note">{{ assuranceLine }}</p>
    </CapabilityGate>

    <p class="screen__footnote">
      This page reports session state; it does not grant anything. Every
      administrative command is authorized by the Admin Worker against the
      session it resolves, and the refusal rules are the server's to apply.
    </p>
  </section>
</template>
