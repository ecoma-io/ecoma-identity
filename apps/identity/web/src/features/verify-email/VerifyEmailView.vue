<!--
  The email verification screen.

  What it is: where a user redeems the one-time code that proves they control
  an address, and — in the bootstrap phase — a statement that the challenge
  behind that code is not issued yet.

  What it is not: a code input. The temptation here is stronger than on the
  other screens, because a verification screen is a text box and nothing else,
  and it would be easy to ship the box and let it be non-functional. It would
  also be pointless: the `challenge_id` the real flow needs is issued by the
  same endpoint that has to answer 501, so a code typed into this screen could
  not be submitted against a challenge that does not exist. A user who received
  a code from somewhere and typed it here would be told "verification failed" —
  which is a false statement, because nothing was ever verified.

  No code box, then, and no resend control. "Resend" would imply an email that
  was sent.
-->
<script setup lang="ts">
import CapabilityGate from "../../components/CapabilityGate.vue";
</script>

<template>
  <section class="screen" aria-labelledby="verify-heading">
    <h1 id="verify-heading" class="screen__heading">
      Verify your email address
    </h1>

    <p class="screen__lede">
      Proving an address establishes it as a first factor: it shows the account
      holder can read mail at that address, and nothing more.
    </p>

    <CapabilityGate feature-id="verify-email">
      <p class="screen__note">The code field will appear here.</p>
    </CapabilityGate>

    <p class="screen__footnote">
      The one-time code is bound to a challenge identifier issued alongside it,
      so a code cannot be redeemed against a different sign-in. Neither the code
      nor the challenge is issued yet.
    </p>
  </section>
</template>
