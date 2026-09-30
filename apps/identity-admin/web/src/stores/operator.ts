/**
 * The operator's session state, as far as this console can honestly know it.
 *
 * The short version: it cannot know. The administrative session cookie is
 * `HttpOnly` and `Secure`, so no JavaScript here can read it, and there is
 * therefore no client-side "is an administrator" flag to compute. This store
 * holds three things — whether the last question to the server succeeded, what
 * it said, and whether a question is in flight — and holds them as *the last
 * thing the server said*, never as a cached assumption.
 *
 * Three states, not two, and the third is the important one:
 * - `unknown` — we have not asked. The initial state, and the state after any
 *   failure. **Not** treated as signed out: a console that renders "you are not
 *   signed in" because it has not finished loading has invented a fact.
 * - `signed-out` — the server answered 401. This is the real signed-out state
 *   and the only one. There is no dev-mode variant of it (constraint 26).
 * - `signed-in` — the server returned a session. Only ever set from a server
 *   response; nothing here can set it locally.
 *
 * ## This store is not an authorization check
 *
 * It exists to render an honest header, not to decide what an operator may do.
 * Every administrative command is authorized by the Admin Worker, on the
 * server, against the resolved session and the AAL. Flipping anything in this
 * store would change what the console *says* and nothing about what it can
 * *do* — which is the correct property: a client-side gate that looked like
 * enforcement would be the most dangerous kind of check in an operator console,
 * because an operator would reasonably trust it.
 *
 * Nothing here writes to `localStorage` or `sessionStorage`. A persisted
 * "signed in as administrator" flag is readable by any script on the page,
 * survives logout, and would outlive the cookie it claims to describe. The store
 * is deliberately in-memory only, so a reload asks the server again.
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { getAdminSession } from "../api/admin";
import { isSignedOut, toErrorState, type ErrorState } from "../api/errors";
import type { DeferredTo } from "../capabilities";

/** The three things this console may honestly say about the operator. */
export type OperatorStatus = "unknown" | "signed-out" | "signed-in";

/**
 * The phase printed when the operator-session query is deferred.
 *
 * `/admin/session` answers 501 in the bootstrap phase. The value is the phase
 * the capability inventory records, kept here so the store and the screen cannot
 * disagree about which phase to name. It is typed as the inventory's
 * `DeferredTo`, so a phase name invented in this file is a compile error rather
 * than a second owner of the roadmap's vocabulary.
 */
const SESSION_PHASE: DeferredTo = "phase 6";

export const useOperatorStore = defineStore("operator", () => {
  const status = ref<OperatorStatus>("unknown");
  const session = ref<Awaited<ReturnType<typeof getAdminSession>> | null>(null);
  const loading = ref(false);
  const error = ref<ErrorState | null>(null);

  /** Whether a question is in flight. */
  const isLoading = computed(() => loading.value);

  /**
   * The signed-in state, and only it.
   *
   * `unknown` is `false` here on purpose. A gate that treated "not yet known" as
   * "signed in" would render an operator shell during load; one that treated it
   * as "signed out" would flash a sign-in screen. Both are lies about a fact the
   * client has not established, so callers get `false` and are expected to
   * handle `unknown` explicitly.
   *
   * It is a display convenience, **not** a permission check. Nothing in this
   * console asks this to decide whether to show a control.
   */
  const isSignedIn = computed(() => status.value === "signed-in");

  /**
   * Ask the server who the operator is.
   *
   * Route: `GET /admin/session`. In the bootstrap phase that route answers 501,
   * so this resolves to a `deferred` {@link ErrorState} and the status stays
   * `unknown` — the honest outcome. It is emphatically **not** "signed out": a
   * 501 is a statement about the implementation, not about the operator's
   * credentials, and treating it as a signed-out operator would be the console
   * inventing an authentication result.
   *
   * On a 401 the status becomes `signed-out`, and only then.
   */
  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      session.value = await getAdminSession();
      status.value = "signed-in";
    } catch (caught) {
      const state = toErrorState(caught, SESSION_PHASE);
      error.value = state;
      if (isSignedOut(state)) {
        status.value = "signed-out";
        session.value = null;
      }
      // A deferred or unreachable query leaves the status at `unknown`. Both
      // mean "we do not know", and the screens render that.
    } finally {
      loading.value = false;
    }
  }

  /**
   * Forget the cached session without claiming the operator signed out.
   *
   * Deliberately not named `signOut`: this does not end a session, and a store
   * method called `signOut` that only clears memory is how a UI ends up
   * reporting a sign-out that never reached the server. Ending an administrative
   * session is the Worker's to do, and this console cannot do it by itself
   * because it cannot read the cookie.
   */
  function clear(): void {
    session.value = null;
    status.value = "unknown";
    error.value = null;
  }

  return { status, session, error, isLoading, isSignedIn, refresh, clear };
});
