<!--
  The role administration screen.

  What it is: where an administrator changes a user's platform role. In the
  bootstrap phase it is a statement that the command is not served.

  What it is not, and this is the screen where a client-side check would be most
  tempting and most wrong: a role selector with the forbidden combinations
  disabled.

  The three refusal rules are real, and they are exactly the kind of thing a UI
  looks like it should enforce:

  - An operator cannot change their own role. Self-promotion is the
    privilege-escalation primitive; the only way to grant a role is for another
    administrator to grant it.
  - Only an administrator assigns roles. `support` moderates accounts but does
    not promote.
  - The last *active* administrator cannot be demoted, which is why a suspended
    administrator does not count toward the total.

  Encoding any of these as a disabled `<option>` would be a client-side
  authorization check. A check like that is one the client can be wrong about, it
  teaches an operator that the rule is the UI's rather than the server's, and —
  worst — it is the sort of check that gives a false sense that the action is
  impossible when it is merely hidden. The rules belong on the server, in the
  same transaction that would apply the change, and the console's job is to
  render the refusal it gets.
-->
<script setup lang="ts">
import CapabilityGate from "../../components/CapabilityGate.vue";
</script>

<template>
  <section class="screen" aria-labelledby="role-admin-heading">
    <h1 id="role-admin-heading" class="screen__heading">Platform roles</h1>

    <p class="screen__lede">
      A user's platform role says what they may do to accounts. It is not a
      business permission: it is never consulted to decide what a user may do in
      another Ecoma repository.
    </p>

    <CapabilityGate feature-id="change-role">
      <p class="screen__note">The role selector will appear here.</p>
    </CapabilityGate>

    <p class="screen__footnote">
      Three changes are refused by the server and are not hidden by this
      console: an operator changing their own role, an operator without
      administrator standing assigning a role, and a change that would leave no
      active administrator.
    </p>
  </section>
</template>
