<!--
  The sign-in screen.

  What it is: the screen a user lands on to sign in with an emailed one-time
  code, and — in the bootstrap phase — a screen that states plainly that it
  cannot yet do that.

  What it is not: a form that accepts an address and then says "check your
  email". That is the specific dishonesty this screen could commit most easily,
  and it is worth spelling out why it is not an option here. The Worker answers
  501 on `/oauth/authorize`, so submitting this form would send a request that
  cannot succeed. Worse, "check your email" is a claim about the world: it
  says a message is on its way. A user who is told that, and then waits for a
  code that will never arrive, has been actively misinformed about the state of
  their account — and the natural next step, going to their provider to check
  whether the platform is broken, is exactly the behaviour a security product
  must not induce.

  There is therefore no input and no submit button on this screen. Not a
  disabled one: a disabled control with no explanation is the third way this
  screen could mislead, and it is the worst of the three because it looks like
  a decision rather than an absence.

  The real signed-out state is also shown, and it is the real one. This app
  cannot inspect the session cookie (`HttpOnly`), so it has no way to know
  whether the user is signed in; the session store reports "unknown" until the
  server answers, and the app renders that uncertainty rather than resolving it
  in the user's favour.
-->
<script setup lang="ts">
import { computed } from "vue";

import CapabilityGate from "../../components/CapabilityGate.vue";
import { useSessionStore } from "../../stores/session";

const session = useSessionStore();

/** What this app honestly knows about the caller's session, right now. */
const sessionLine = computed(() => {
  switch (session.status) {
    case "signed-in":
      return "You have a session the Identity Worker recognises.";
    case "signed-out":
      return "You are not signed in. The Identity Worker answered 401.";
    case "unknown":
    default:
      return (
        "This application cannot tell whether you are signed in: the session " +
        "cookie is HttpOnly and unreadable from JavaScript by design, so only " +
        "the Worker can answer, and it has not been asked yet."
      );
  }
});
</script>

<template>
  <section class="screen" aria-labelledby="sign-in-heading">
    <h1 id="sign-in-heading" class="screen__heading">Sign in</h1>

    <p class="screen__lede">
      Ecoma Identity signs you in with a one-time code sent to your email
      address. There is no password to remember and no third-party account to
      authorise.
    </p>

    <!--
      The live session line. `aria-live="polite"` because it settles from
      "unknown" to one of two answers after a call, and that transition is
      information rather than an interruption.
    -->
    <p class="screen__note" role="status" aria-live="polite">
      {{ sessionLine }}
    </p>

    <CapabilityGate feature-id="sign-in">
      <p class="screen__note">
        The address field and the code field will appear here.
      </p>
    </CapabilityGate>

    <p class="screen__footnote">
      The verification step that follows a successful sign-in is a separate
      screen, and is deferred to the same phase.
    </p>
  </section>
</template>
