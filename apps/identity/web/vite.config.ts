// Vite configuration for the end-user identity UI.
//
// It builds the static half of the `identity` release unit. The output in
// `dist/` is what the Identity Worker serves through its `ASSETS` binding;
// this file does not decide where that happens, and it must not be changed to
// point the dev server at a separate backend — the BFF *is* the Worker (see
// `src/api/http.ts`).
//
// There is no `server.proxy` here, and that is deliberate. A dev proxy would
// make `localhost:5173` look like it has working authentication while hiding
// the fact that every route answers 501; the honest local experience is the
// same one production has, reached through `VITE_API_BASE_URL`.
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

import { readFrontendConfig } from "./src/config";

export default defineConfig(() => {
  // Read inside the callback rather than at module scope because the callback
  // runs again on every dev-server config reload, and the file the projection
  // writes changes underneath a long-running `vite` when the environment is
  // re-rendered. The throw inside `readFrontendConfig` is deliberate; see the
  // header of that module for why a missing config is not a default.
  const frontend = readFrontendConfig();

  return {
    plugins: [vue()],
    define: {
      // The cookie NAME reaches the blocking inline script in `index.html`
      // through Vite's `%NAME%` HTML substitution, and that substitution is fed
      // by `import.meta.env.*` defines — NOT by `envPrefix` on its own. An
      // `envPrefix` route would need the value exported as a process
      // environment variable by every task that builds or runs this app, and an
      // undefined variable is left in the HTML verbatim with only a warning: the
      // bundle would then read a cookie named `%ECOMA_FRONTEND_COOKIE_NAME%`
      // and silently never find a colour-mode preference. A `define` cannot be
      // undefined, so the name reaching the HTML is always a real string.
      //
      // Verified on Vite 8.3.1: the substitution lands inside a CLASSIC,
      // non-module inline `<script>`, which is the only reason the no-flash
      // bootstrap in `index.html` can be synchronous. `index.html` records what
      // was checked and what the fallback would have cost.
      //
      // The value is a cookie NAME, not a secret. It is already present in
      // `infra-topology/topology.json`, in the rendered HTML of every
      // environment, and in the request headers of every visitor who has the
      // cookie at all.
      "import.meta.env.ECOMA_FRONTEND_COOKIE_NAME": JSON.stringify(
        frontend.cookie.name,
      ),
    },
    // The Worker serves this directory as static assets and falls back to
    // `index.html` for client-side routes, so the built asset filenames are
    // content-hashed and `dist/` is self-contained.
    build: {
      outDir: "dist",
      sourcemap: true,
    },
  };
});
