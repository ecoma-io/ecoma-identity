/**
 * The caller's session state, as far as this app can honestly know it.
 *
 * The short version: it cannot know. The session cookie is `HttpOnly` and
 * `Secure`, so no JavaScript here can read it, and there is therefore no
 * client-side "am I signed in" flag to compute. This store holds exactly three
 * things — whether the last question to the server succeeded, who it said we
 * are, and whether a question is in flight — and it holds them as *the last
 * thing the server said*, never as a cached assumption.
 *
 * Three states, not two, and the third is the important one:
 * - `unknown` — we have not asked. The initial state, and the state after any
 *   failure. **Not** treated as signed out: an app that renders "you are not
 *   signed in" because it has not finished loading has invented a fact.
 * - `signed-out` — the server answered 401. This is the real signed-out state
 *   and the only one. There is no dev-mode variant of it (constraint 26).
 * - `signed-in` — the server returned an account. Only ever set from a server
 *   response; nothing in this store can set it locally.
 *
 * Nothing here writes to `localStorage` or `sessionStorage`. It would be easy
 * and it would be a mistake: a persisted "signed in" flag is readable by any
 * script on the page, survives logout, and would outlive the cookie it claims
 * to describe. The store is deliberately in-memory only, so a reload asks the
 * server again.
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { getAccount } from "../api/self-service";
import type { AccountView } from "../api/contracts";
import { isSignedOut, toErrorState, type ErrorState } from "../api/errors";
import type { DeferredTo } from "../capabilities";

/** The three things this app may honestly say about the caller's session. */
export type SessionStatus = "unknown" | "signed-out" | "signed-in";

/**
 * The phase printed when this app's own account query is deferred.
 *
 * The account route is part of the self-service contract and answers 501 in
 * the bootstrap phase. The value is the phase the capability inventory records
 * for the account, kept here so the store and the screen cannot disagree about
 * which phase to name. It is typed as the inventory's `DeferredTo`, so a phase
 * name invented in this file is a compile error rather than a second owner of
 * the roadmap's vocabulary.
 */
const ACCOUNT_PHASE: DeferredTo = "phase 5";

export const useSessionStore = defineStore("session", () => {
  const status = ref<SessionStatus>("unknown");
  const account = ref<AccountView | null>(null);
  const loading = ref(false);
  const error = ref<ErrorState | null>(null);

  /**
   * Whether a question is in flight. Screens use this to avoid rendering a
   * spinner that will resolve to placeholder data — they check the capability
   * gate first and skip the call entirely.
   */
  const isLoading = computed(() => loading.value);

  /**
   * The signed-in state, and only it.
   *
   * `unknown` is `false` here on purpose. A gate that treated "not yet known"
   * as "signed in" would render a signed-in shell during load; one that
   * treated it as "signed out" would flash a sign-in screen. Both are lies
   * about a fact the client has not established, so callers get `false` and are
   * expected to handle the `unknown` case explicitly.
   */
  const isSignedIn = computed(() => status.value === "signed-in");

  /**
   * Ask the server who the caller is.
   *
   * Route: `GET /self-service/account`. In the bootstrap phase that route
   * answers 501, so this resolves to a `deferred` {@link ErrorState} and the
   * status stays `unknown` — which is the honest outcome. It is emphatically
   * **not** "signed out": a 501 is a statement about the implementation, not
   * about the caller's credentials, and treating it as a signed-out user would
   * be the app inventing an authentication result.
   *
   * On a 401 the status becomes `signed-out`, and only then.
   */
  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const view = await getAccount();
      account.value = view;
      status.value = "signed-in";
    } catch (caught) {
      const state = toErrorState(caught, ACCOUNT_PHASE);
      error.value = state;
      if (isSignedOut(state)) {
        status.value = "signed-out";
        account.value = null;
      }
      // A deferred or unreachable query leaves the status at `unknown`. Both
      // mean "we do not know", and the screens render that.
    } finally {
      loading.value = false;
    }
  }

  /**
   * Forget the cached account without claiming the user signed out.
   *
   * Called when the app decides the cached view is stale. It is deliberately
   * not named `signOut`: this function does not end a session, and a store
   * method called `signOut` that only clears memory is how a UI ends up
   * reporting a sign-out that never reached the server. Ending the session is
   * `api/self-service.ts#signOut`, which calls the Worker, and it is currently
   * deferred.
   */
  function clear(): void {
    account.value = null;
    status.value = "unknown";
    error.value = null;
  }

  return { status, account, error, isLoading, isSignedIn, refresh, clear };
});
