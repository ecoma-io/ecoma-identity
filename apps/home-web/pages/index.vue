<template>
  <div class="home">
    <section class="hero">
      <h1 class="title">Ecoma</h1>
      <p class="tagline">Fair-code labor OS</p>
      <p class="description">
        Humans, AI agents and rules/code as one kind of labor resource.
      </p>
      <div class="actions">
        <a href="https://github.com/ecoma-io" class="button primary">
          View on GitHub
        </a>
      </div>
    </section>

    <section id="features" class="features">
      <h2>What is Ecoma?</h2>
      <p class="status-note">
        <strong>Status:</strong> Platform bootstrap. The product is under active
        development.
      </p>
      <ul class="feature-list">
        <li>
          <strong>Unified labor model.</strong> Humans, AI agents, and automated
          rules operate within a single coordination layer.
        </li>
        <li>
          <strong>Graph + loop engineering.</strong> Work flows through
          structured graphs with explicit feedback loops.
        </li>
        <li>
          <strong>Fair-code.</strong> Open source with sustainable licensing for
          production use.
        </li>
      </ul>
    </section>

    <section class="links">
      <h2>Repositories</h2>
      <ul class="repo-list">
        <li>
          <a href="https://github.com/ecoma-io/ecoma">ecoma</a> — the product
        </li>
        <li>
          <a href="https://github.com/ecoma-io/runtime-trail">runtime-trail</a>
          — local developer observability
        </li>
        <li>
          <a href="https://github.com/ecoma-io/loom">loom</a> — UI system and
          composition library
        </li>
        <li>
          <a href="https://github.com/ecoma-io/archkeep">archkeep</a> —
          architecture governance
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.home {
  max-width: 48rem;
  margin: 0 auto;
  padding: 2rem;
}

.hero {
  text-align: center;
  padding: 4rem 0;
  border-bottom: 1px solid #e5e7eb;
}

.title {
  font-size: 3rem;
  font-weight: 800;
  color: #111827;
  margin: 0 0 0.5rem;
}

.tagline {
  font-size: 1.5rem;
  color: #6b7280;
  margin: 0 0 1rem;
}

.description {
  font-size: 1.125rem;
  color: #374151;
  max-width: 32rem;
  margin: 0 auto 2rem;
}

.actions {
  display: flex;
  justify-content: center;
  gap: 1rem;
}

.button {
  display: inline-block;
  padding: 0.75rem 1.5rem;
  border-radius: 0.375rem;
  text-decoration: none;
  font-weight: 500;
}

.button.primary {
  background: #111827;
  color: #fff;
}

.button.primary:hover {
  background: #374151;
}

.features,
.links {
  padding: 3rem 0;
  border-bottom: 1px solid #e5e7eb;
}

.features h2,
.links h2 {
  font-size: 1.5rem;
  color: #111827;
  margin: 0 0 1rem;
}

.status-note {
  padding: 1rem;
  background: #fef3c7;
  border-radius: 0.375rem;
  margin-bottom: 1.5rem;
  color: #92400e;
}

.feature-list,
.repo-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.feature-list li,
.repo-list li {
  color: #374151;
}

.repo-list a {
  color: #2563eb;
  text-decoration: none;
}

.repo-list a:hover {
  text-decoration: underline;
}
</style>
