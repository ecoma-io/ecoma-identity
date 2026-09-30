<!--
  The user search screen.

  What it is: where an operator searches for a person. In the bootstrap phase it
  is a statement that the query does not exist.

  What it is not, and this is the screen most likely to tempt an implementer: a
  mock user table. A table of invented rows would be the most convincing thing
  in this console and the most dangerous, because an operator cannot tell a
  sample row from a real one by looking at it, and would act on it — reporting
  a suspension of a person who does not exist, escalating a fabricated
  incident, or worse, concluding that a real user is not in the list because
  they were not typed into the fixture.

  So there is no table, no search box, and no filter controls. Not disabled ones:
  a disabled search box with no explanation is a control that looks like a
  decision. What is here instead is the data contract the future query returns
  (`src/api/contracts.ts`), and the deferral naming the phase.

  The gate is read from the capability inventory before any request is issued,
  so the console never sends a call it knows will answer 501 and never shows a
  spinner that resolves to nothing.
-->
<script setup lang="ts">
import CapabilityGate from "../../components/CapabilityGate.vue";
</script>

<template>
  <section class="screen" aria-labelledby="user-search-heading">
    <h1 id="user-search-heading" class="screen__heading">Search users</h1>

    <p class="screen__lede">
      Find a person by display name or email address, and filter by role or
      account status.
    </p>

    <CapabilityGate feature-id="user-search">
      <p class="screen__note">
        The search field and its results will appear here.
      </p>
    </CapabilityGate>

    <p class="screen__footnote">
      The search runs against Identity D1 through the Admin Worker's private
      service binding. This console never queries that database directly and
      never addresses the Identity Worker.
    </p>
  </section>
</template>
