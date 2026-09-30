<!--
  The account moderation screen: suspend and unsuspend.

  What it is: where an operator suspends a user who is attacking the platform,
  or reinstates one they suspended in error. In the bootstrap phase it is a
  statement that neither command is served.

  What it is not: a confirm-and-act button, even a disabled one. Three reasons,
  and each is a reason on its own:

  - **No partial implementation.** Suspension is not a flag this console could
    set optimistically. The Worker revokes the user's sessions as part of it, and
    an operator who clicks "suspend" during an incident needs to know whether
    it took effect, not to watch a spinner and assume it did.
  - **Suspension is asymmetric.** `deactivated` cannot be reinstated. A UI that
    offered one "toggle account" control over both states would be offering a
    destructive transition behind the same affordance as a reversible one.
  - **It is an audited command.** Suspension is written to the audit trail with
    the operator and their session. That is a record of what a person did to
    another person's account, and it should be created by an explicit server
    round-trip, not by a click whose outcome is assumed.

  The screen also does not pre-empt the server's rules. Who may suspend is
  decided by the Admin Worker; this page will show its refusal when it arrives.
-->
<script setup lang="ts">
import CapabilityGate from "../../components/CapabilityGate.vue";
</script>

<template>
  <section class="screen" aria-labelledby="moderation-heading">
    <h1 id="moderation-heading" class="screen__heading">
      Suspend and reinstate
    </h1>

    <p class="screen__lede">
      Bar a user from authenticating, and put them back. Suspension revokes
      their live sessions as part of taking effect.
    </p>

    <CapabilityGate feature-id="suspend-user">
      <p class="screen__note">
        The suspend and reinstate actions will appear here.
      </p>
    </CapabilityGate>

    <p class="screen__footnote">
      Suspension and permanent deactivation are different states, and only
      suspension is reversible. This screen will offer only the transition the
      server permits, rather than a single control spanning both.
    </p>
  </section>
</template>
