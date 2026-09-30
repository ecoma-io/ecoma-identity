// Vite configuration for the operator console.
//
// It builds the static half of the `identity-admin` release unit. The output
// in `dist/` is what the Admin Worker serves through its `ASSETS` binding.
// This file does not decide where that happens, and it must not be changed to
// point the dev server at the Identity Worker directly: the console talks only
// to the Admin Worker, which reaches identity through a private service binding
// (see `src/api/http.ts`).
//
// There is no `server.proxy` here, and that is deliberate. A dev proxy would
// make the console look operational while every administrative route answers
// 501; the honest local experience is the same one production has, reached
// through `VITE_API_BASE_URL`.
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
