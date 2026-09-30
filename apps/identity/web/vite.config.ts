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

export default defineConfig({
  plugins: [vue()],
  // The Worker serves this directory as static assets and falls back to
  // `index.html` for client-side routes, so the built asset filenames are
  // content-hashed and `dist/` is self-contained.
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
