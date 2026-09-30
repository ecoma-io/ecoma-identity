// Fixture admin web client — the FRONTEND side, which is legal. It names
// `vue` and imports a sibling module, and neither is a violation: this file is
// under apps/identity-admin/web, not under crates/** or apps/*/worker/**.
//
// This file is the CONTROL CASE for check 4. A canary that only ever finds
// violations cannot tell "the guard fires" from "the guard fires on everything",
// so the tree must contain files that are legal and must stay unreported.
import { mountApp } from "./mount";
export const client = { mount: mountApp, framework: "vue" };
