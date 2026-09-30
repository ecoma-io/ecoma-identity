// The entry point for the end-user identity UI.
//
// It mounts the app and nothing else. There is deliberately no startup call to
// the API, no session probe before mount, and no loading gate: in the bootstrap
// phase the app renders immediately and honestly, and if a screen needs to ask
// the Worker something it asks when it mounts. A startup probe would put a
// spinner in front of every screen, and a spinner that resolves to "not
// available yet" is worse than no spinner — it implies the answer was worth
// waiting for.
import { createApp } from "vue";
import { createPinia } from "pinia";

import App from "./App.vue";
import { router } from "./router";
import "./styles/tokens.css";
import "./styles/app.css";

createApp(App).use(createPinia()).use(router).mount("#app");
