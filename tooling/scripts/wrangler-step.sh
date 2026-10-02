#!/usr/bin/env bash
#
# wrangler-step.sh — run one wrangler command and make its failure legible.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS
# ---------------------------------------------------------------------------
# A wrangler command that fails under `set -e` ends its step with
#
#     ##[error]Process completed with exit code 1.
#
# and nothing else. The run's annotation list stays EMPTY, so the failure is
# only findable by scrolling the step's raw output — which on an upload is
# several hundred lines, most of it `set -x` echo of the surrounding script.
# The reason is in there somewhere; finding it is the whole cost.
#
# This wrapper makes the failure say what it was on its own:
#
#   * a `::error::` annotation naming the command, so it appears in the run's
#     Annotations list and in the job summary;
#   * the command's own exit code, which `set -e` otherwise swallows into a
#     generic 1;
#   * the LAST lines of wrangler's output repeated inside the annotation,
#     because GitHub truncates a step log in the summary view and a message
#     that only exists in the log is a message most people never read.
#
# ---------------------------------------------------------------------------
# WHICH WRANGLER THIS RUNS
# ---------------------------------------------------------------------------
# `$WRANGLER_BIN` names the binary; everything else here is the same either way.
# The default is `pnpm exec wrangler`, which resolves the binary out of
# `node_modules` and is what a job with a checkout and an install wants.
#
# A job with NEITHER sets `$WRANGLER_BIN` to `npx --yes wrangler@$VERSION` and
# gets wrangler from the npm registry instead, which is how `rollback.yml`
# already runs — and how the promotion jobs in `deploy-worker.yml` now run, so
# that promoting a version does not require checking the repository out and
# installing 1,400 dependencies to execute one command.
#
# The two spellings are deliberately NOT unified. `pnpm exec` resolves against
# the lockfile-installed tree, which is a *different* wrangler than
# `wrangler@$VERSION` from the registry if `package.json` and the lockfile ever
# disagree; the pinned-registry form is reproducible on its own, and the
# pnpm form is what CI's other jobs already exercise. Making the wrapper choose
# one silently would hide that difference rather than remove it.
#
# ---------------------------------------------------------------------------
# SECRETS
# ---------------------------------------------------------------------------
# The Cloudflare token is read by wrangler from the ENVIRONMENT and is never
# passed as an argument, so it is not in this script's command line and not in
# the annotated message. `CLOUDFLARE_ACCOUNT_ID` is configuration and is
# printed deliberately. GitHub masks any registered secret as `***` in log
# output, so even a value that did appear here would be masked rather than
# leaked — which is what makes pasting a run log into an issue safe. The
# masking is not a licence to be careless: it covers secrets GitHub knows
# about, and the reason the token is never an argument is that this wrapper
# cannot tell the difference.
#
# ---------------------------------------------------------------------------
# USAGE
# ---------------------------------------------------------------------------
#   wrangler-step.sh <label> -- <wrangler args...>
#
# `<label>` is a short human name for the command ("upload a version"), used in
# the annotation. Everything after `--` is passed to wrangler untouched.
#
# This is a WORKFLOW HELPER, not a CLI: it is sourced or invoked by the deploy
# workflows, which is why it lives beside the other tooling rather than in
# `bin/`.

set -euo pipefail

if [ "$#" -lt 3 ] || [ "$2" != "--" ]; then
  echo "usage: wrangler-step.sh <label> -- <wrangler args...>" >&2
  exit 64
fi

LABEL="$1"
shift 2

# Unquoted on purpose: this is a COMMAND, not a name, and the no-checkout jobs
# set `npx --yes wrangler@4.144.0`. Word-splitting it into argv is the point.
# Every caller sets it to a literal in the workflow file — nothing in a checked
# file, a version id or a response body reaches this string.
WRANGLER_BIN="${WRANGLER_BIN:-pnpm exec wrangler}"

# ---------------------------------------------------------------------------
# STDOUT PASSES THROUGH, THE LOG GOES TO STDERR.
# ---------------------------------------------------------------------------
# Some callers capture stdout, because `--json` is the payload they parse:
#
#     JSON="$(wrangler-step.sh "list versions" -- versions list --json)"
#
# Wrapping that in `tee` would splice the transcript into `JSON` and hand the
# parser a document that is not JSON. So the transcript is written to stderr —
# which the Actions log collects exactly as it collects stdout — and stdout
# carries only what wrangler itself printed. A caller that wants to see both
# still sees both; a caller that captures one gets a clean one.

LOG="$(mktemp)"
# shellcheck disable=SC2064  # expand $LOG now, while it still names this path
trap "rm -f '$LOG'" EXIT

set +e
$WRANGLER_BIN "$@" 2> >(tee -a "$LOG" >&2) | tee -a "$LOG"
STATUS="${PIPESTATUS[0]}"
set -e

if [ "$STATUS" -ne 0 ]; then
  # The tail is what makes the annotation useful on its own. 800 characters is
  # GitHub's practical annotation limit; wrangler's error is at the END of its
  # output, so a head would be the wrong end to keep.
  TAIL="$(tail -c 800 "$LOG" | tr '\n' ' ' | tr -s ' ')"
  echo "::error title=wrangler ${LABEL} failed (exit ${STATUS})::${TAIL}"
  echo ""
  echo "The full wrangler output is in this step's log above. This step ran:"
  echo ""
  echo "    $WRANGLER_BIN $*"
  echo ""
  echo "Nothing was uploaded and no traffic moved."
fi

exit "$STATUS"