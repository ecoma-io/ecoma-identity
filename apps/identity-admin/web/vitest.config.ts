// Vitest configuration for the operator console.
//
// A separate file from `vite.config.ts` rather than a `test` key inside it: the
// build does not need a test environment, and a `jsdom` environment configured
// for tests should not be able to leak into a production bundle by being one
// object away.
//
// The environment is `jsdom` because the tests mount components. Nothing needs
// stubbing in `src/test-setup.ts` for this app — the console has no browser API
// it depends on that jsdom lacks — but the file is kept as the single place to
// add one, with the rule that each entry must name what it exists for.
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    // Component tests live next to the components they cover, mirroring the
    // source tree. The pure-logic tests are in `tests/` because they are about
    // modules rather than components.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
