<!--
  The session revocation screen.

  What it is: where an operator ends every live session belonging to one user,
  without changing that user's account status. In the bootstrap phase it is a
  statement that the command is not served.

  What it is not: a "sign out" button next to the user, and not a merge of
  revocation with suspension. The two are distinct server-side effects and both
  are written to the audit trail; collapsing them into one "disable the user"
  affordance would be imprecise about what an operator actually did to someone's
  account.

  The absence of a button is deliberate even for an unimplemented command.
  Revoking an account's sessions is a real action against a real person, and a
  console that could fire it optimistically and report "done" would be telling
  an operator they have cut off an attacker's access when it had not yet
  reached the server. Every action here is a round-trip or it is nothing.
-->
<script setup lang="ts">
import CapabilityGate from "../../components/CapabilityGate.vue";
</script>

<template>
  <section class="screen" aria-labelledby="revocation-heading">
    <h1 id="revocation-heading" class="screen__heading">
      Revoke a user's sessions
    </h1>

    <p class="screen__lede">
      End every live session belonging to one account. The user stays active and
      can sign in again; what changes is that nothing is currently signed in on
      their behalf.
    </p>

    <CapabilityGate feature-id="revoke-sessions">
      <p class="screen__note">The revocation action will appear here.</p>
    </CapabilityGate>

    <p class="screen__footnote">
      This is not the same as suspending the user. Suspension changes their
      account status and revokes sessions as a consequence; this changes nothing
      about the account, only the sessions.
    </p>
  </section>
</template>
