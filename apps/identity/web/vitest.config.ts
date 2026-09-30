// Vitest configuration for the end-user identity UI.
//
// A separate file from `vite.config.ts` rather than a `test` key inside it: the
// build does not need a test environment, and a `jsdom` environment configured
// for tests should not be able to leak into a production bundle by being one
// object away.
//
// The environment is `jsdom` because the tests mount components, and the two
// things jsdom does not implement that this app uses are stubbed in
// `src/test-setup.ts` — each stub there names the thing it exists for.
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    // Component tests live next to the components they cover, mirroring the
    // source tree, so a test is found by looking at the file it is about. The
    // pure-logic tests are in `tests/` for the opposite reason: they are about
    // modules, not components, and they assert behaviour that must hold
    // regardless of how anything is rendered.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
