<!--
  The second-factor setup screen.

  What it is: where a user adds a TOTP authenticator or a passkey, and — in the
  bootstrap phase — a statement that enrolment is not served.

  What it is not: an enrolment form. This is the one screen where a mock would
  be most tempting and most damaging, because the natural placeholder is a
  QR code: an enrolment screen that renders a QR image looks finished, and a
  person scanning a QR code that encodes nothing has been told they have a
  second factor. They have not. They have a second factor that an attacker can
  choose.

  The contract this screen will honour when it exists is written down, so the
  future implementation cannot quietly get the secrets wrong: the enrolment
  secret is a secret, and it must never be logged, put in a URL, or written to
  `localStorage`. It is shown once, in a QR code, and then it is a secret the
  user has proved they stored — which is the same discipline as the session
  cookie's, applied to the one credential this app does have to hand out.
-->
<script setup lang="ts">
import CapabilityGate from "../../components/CapabilityGate.vue";
</script>

<template>
  <section class="screen" aria-labelledby="second-factor-heading">
    <h1 id="second-factor-heading" class="screen__heading">
      Set up a second factor
    </h1>

    <p class="screen__lede">
      A second factor is something you hold, rather than something you know. A
      one-time password from an authenticator app, or a passkey, raises a
      session from one factor to two.
    </p>

    <CapabilityGate feature-id="second-factor">
      <p class="screen__note">The enrolment options will appear here.</p>
    </CapabilityGate>

    <p class="screen__footnote">
      When enrolment works, the setup secret is shown once as a QR code and is
      never stored by this application.
    </p>
  </section>
</template>
