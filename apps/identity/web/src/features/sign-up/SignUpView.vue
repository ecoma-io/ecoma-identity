<!--
  The sign-up screen.

  What it is: where a new user would create an account, and — in the bootstrap
  phase — a statement that account creation does not exist yet.

  What it is not: a sign-up form that collects an address and a display name.
  Beyond the 501, two things make a collecting form actively harmful here: the
  email is the user's first factor, and a form that accepts an address it
  cannot verify, cannot confirm receipt of, and cannot rate-limit is a
  credential-collection surface with no credential behind it. A user who types a
  real address into a form that cannot send anything has disclosed their
  primary identifier for no benefit.

  So the form fields are not rendered disabled, absent, or prefilled. They are
  absent, and the screen says which phase they are waiting for.
-->
<script setup lang="ts">
import CapabilityGate from "../../components/CapabilityGate.vue";
</script>

<template>
  <section class="screen" aria-labelledby="sign-up-heading">
    <h1 id="sign-up-heading" class="screen__heading">Create an account</h1>

    <p class="screen__lede">
      An Ecoma Identity account is an email address, a display name, and
      whatever second factors you choose to add later. Nothing else is required
      to sign in.
    </p>

    <CapabilityGate feature-id="sign-up">
      <p class="screen__note">
        The address and display-name fields will appear here.
      </p>
    </CapabilityGate>

    <p class="screen__footnote">
      Account creation and the emailed code share one endpoint, so neither
      branch of that screen works until that endpoint does.
    </p>
  </section>
</template>
