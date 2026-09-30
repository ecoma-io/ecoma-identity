<!--
  The single-user view.

  What it is: where an operator looks at one account — its role, its status, its
  live session count, and when it was created.

  What it is not: a profile page with a sample user, and not a screen with
  "suspend" and "change role" buttons. Both refusals are deliberate and worth
  stating:

  A mock user is the same failure as a mock user table, in miniature — an
  operator reading a plausible account here would be reading a person who does
  not exist. An empty state saying "this account was not found" is not offered
  either, for the same reason: a 501 is not a 404, and the console must not
  convert "the query does not exist" into "that person does not exist".

  The action buttons are absent rather than disabled because the rules behind
  them are the console's most consequential: a user cannot change their own role,
  only an administrator assigns roles, and the last active administrator cannot
  be demoted. Those are decided server-side, in the same transaction that would
  apply the change. A disabled button in front of an operator who has just been
  refused explains nothing and looks like a bug.
-->
<script setup lang="ts">
import CapabilityGate from "../../components/CapabilityGate.vue";
</script>

<template>
  <section class="screen" aria-labelledby="user-detail-heading">
    <h1 id="user-detail-heading" class="screen__heading">User detail</h1>

    <p class="screen__lede">
      One account's role, status, live session count, and creation date.
    </p>

    <CapabilityGate feature-id="user-detail">
      <p class="screen__note">The account summary will appear here.</p>
    </CapabilityGate>

    <p class="screen__footnote">
      This view deliberately has no "change role" or "suspend" control. Those
      actions are commands with refusal rules the server evaluates, and a
      console that offered a button the server would refuse would be a dead
      control with a misleading label.
    </p>
  </section>
</template>
