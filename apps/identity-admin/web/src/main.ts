// The entry point for the operator console.
//
// It mounts the app and initializes i18n. There is deliberately no startup call to
// the API, no session probe before mount, and no loading gate: in the bootstrap
// phase the console renders immediately and honestly, and if a screen needs to
// ask the Admin Worker something it asks when it mounts. A startup probe would
// put a spinner in front of every screen, and a spinner that resolves to "not
// available yet" is worse than no spinner — it implies the answer was worth
// waiting for.
import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import { router } from "./router";
import { i18n, initializeI18n } from "./plugins/i18n";
import "./styles/tokens.css";
import "./styles/app.css";

// Initialize i18n before mounting the app
async function bootstrap() {
  const app = createApp(App);

  app.use(createPinia());
  app.use(router);
  app.use(i18n);

  // Initialize locale from cookie or browser
  await initializeI18n();

  app.mount("#app");
}

// `void` rather than a `.catch()` that logs and carries on. The only await in
// `bootstrap` is a dynamic `import()` of a locale file the bundler resolved at
// build time, so a rejection means the chunk is gone — a deploy-skew failure
// where the client holds HTML naming a chunk this deployment no longer serves.
// No recovery path can paper over that, and mounting anyway would render a page
// of raw message keys (`nav.missing`) in front of an operator who has done
// nothing wrong. The unhandled rejection is left visible in the console rather
// than replaced with a message implying the console carried on.
void bootstrap();
