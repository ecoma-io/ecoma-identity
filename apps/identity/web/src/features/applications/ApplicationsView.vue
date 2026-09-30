<!--
  The connected-applications screen.

  What it is: where a user sees which applications they have granted access to
  their account, and withdraws a grant.

  What it is not: an empty list of applications. Same rule as the sessions
  screen, and for a sharper reason: an empty connected-applications list is a
  statement about who has access to a user's identity. "Nothing is connected to
  your account" is a reassuring claim, and a user who believed it during an
  account-takeover investigation would be misled in the direction that costs
  them the most.

  It also does not list the applications the *organisation* has registered. The
  distinction matters: a registered application is something Ecoma built, and a
  grant is something the user gave. Rendering the former on this screen would
  show a list of things that looks like a list of things the user consented to.
-->
<script setup lang="ts">
import CapabilityGate from "../../components/CapabilityGate.vue";
</script>

<template>
  <section class="screen" aria-labelledby="applications-heading">
    <h1 id="applications-heading" class="screen__heading">
      Connected applications
    </h1>

    <p class="screen__lede">
      Applications you have granted access to your identity, and a way to
      withdraw a grant you no longer want.
    </p>

    <CapabilityGate feature-id="applications">
      <p class="screen__note">
        Each application you have granted access to will be listed here, with a
        control to withdraw the grant.
      </p>
    </CapabilityGate>

    <p class="screen__footnote">
      Withdrawing a grant stops the application from obtaining new tokens. It
      does not by itself recall tokens already issued; whether those survive is
      the server's rule, and this screen will report what the Identity Worker
      says rather than promising a stronger outcome.
    </p>
  </section>
</template>
