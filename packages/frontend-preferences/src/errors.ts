/**
 * The one error this package throws.
 *
 * ## Why a named error class rather than `new Error(...)`
 *
 * Every failure mode in this package has the same cause — a configuration that
 * should have been projected was not — and the same remedy: render it. A caller
 * that catches this can therefore say something specific, and a test can assert
 * that a build fails *loudly and for this reason* rather than failing with an
 * `undefined` further downstream.
 *
 * It is a distinct class so the failure is recognisable at a catch site without
 * matching on a message string. The message is the part a human reads; the class
 * is the part code branches on, and a message is not an API.
 *
 * ## Why it exists at all, rather than a fallback value
 *
 * The alternative to throwing is returning a default, and a default for
 * "which cookie name" or "which locales" is a second copy of a fact
 * `infra-topology/topology.json` and
 * `infra-topology/frontend-support.json` already own. Two owners of one fact
 * eventually disagree, and the disagreement is invisible: both files are
 * plausible, every type checks, and the symptom is a preview build writing
 * production's cookie name or a visitor reading raw message keys.
 *
 * A fallback also has the property of firing *only when something is already
 * broken*, which is the worst possible time to introduce a second source of
 * truth — it turns a loud, early, obviously-caused build failure into a quiet,
 * late, hard-to-attribute behaviour difference in production. Failing is the
 * honest answer, so this package fails.
 */
export class MissingFrontendConfigError extends Error {
  constructor(message: string) {
    super(message);
    // Set by hand because the `Error` subclassing contract says a transpiled
    // `extends Error` may not repair the prototype, and `instanceof` is exactly
    // what a caller would use. Without it the class is decorative.
    this.name = "MissingFrontendConfigError";
  }
}
