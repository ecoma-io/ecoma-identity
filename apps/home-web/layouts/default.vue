<template>
  <div class="layout">
    <header class="header">
      <a href="/" class="logo">Ecoma</a>
      <nav class="nav">
        <a href="#features">Features</a>
        <a href="https://github.com/ecoma-io" rel="noopener">GitHub</a>
      </nav>
    </header>
    <main class="main">
      <slot />
    </main>
    <footer class="footer">
      <p>© 2026 Ecoma. Fair-code labor OS.</p>
    </footer>
  </div>
</template>

<style scoped>
.layout {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 2rem;
  border-bottom: 1px solid #e5e7eb;
}

.logo {
  font-size: 1.5rem;
  font-weight: 700;
  color: #111827;
  text-decoration: none;
}

.nav {
  display: flex;
  gap: 1.5rem;
}

.nav a {
  color: #6b7280;
  text-decoration: none;
}

.nav a:hover {
  color: #111827;
}

.main {
  flex: 1;
}

.footer {
  padding: 1rem 2rem;
  border-top: 1px solid #e5e7eb;
  text-align: center;
  color: #6b7280;
  font-size: 0.875rem;
}
</style>
