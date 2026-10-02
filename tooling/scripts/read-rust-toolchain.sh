#!/usr/bin/env bash
#
# read-rust-toolchain.sh — print the Rust channel declared in .moon/toolchains.yml.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS
# ---------------------------------------------------------------------------
# `.moon/toolchains.yml` declares the rustup CHANNEL this repository develops
# against, and four `dtolnay/rust-toolchain` steps in `.github/workflows/` used
# to restate it as the literal `stable`. Two owners of one fact is two facts:
# the day the channel changes, one of them is silently wrong, and nothing in
# either file says so.
#
# Moon 2.5.6 cannot close the gap itself. `moon toolchain info <id>` prints the
# PLUGIN's schema — every supported key, its type and its documentation — and
# never the CONFIGURED value: with `rust.version` declared, the word "stable"
# still does not appear anywhere in its output (the `Version:` line it does
# print is the plugin's own version, 1.0.9, not Rust's), and the command has no
# `--json` flag. `moon query` has no `toolchains` subcommand either. So there
# is no machine-readable path from the declaration to a workflow, and CI has to
# read the file.
#
# It prints the value and nothing else, so a caller can use it in a `with:`
# block, an export, or a comparison. It writes nothing and changes nothing.
#
# ---------------------------------------------------------------------------
# WHY THIS IS NOT A MOON TASK
# ---------------------------------------------------------------------------
# The steps that need the channel run BEFORE `pnpm install` and before the
# moon toolchain cache is restored — that is the point of them. A moon task
# cannot be the thing that feeds them without reordering the job around the
# thing the job exists to set up. Hence a plain script, called by `run:`.
#
# ---------------------------------------------------------------------------
# WHY THE PARSING IS THIS NARROW
# ---------------------------------------------------------------------------
# It is a line-oriented scan for the `rust:` block, not a general YAML parser,
# because `yq` is not on a GitHub runner image and this repository has no YAML
# parser dependency to spend on this. The shape it accepts is the shape this
# repository writes, and it FAILS LOUDLY rather than guessing when the file
# does not have it:
#
#   * `rust:` must be a top-level key, at column zero. An indented `rust:` is a
#     nested key under something else, which is not this declaration.
#   * `version:` is read only while inside that block and only at the block's
#     own indentation, so a `version:` belonging to any other toolchain — or a
#     nested key inside `rust:` — cannot be mistaken for this one.
#   * An empty result is an error, not an empty string. A step that receives
#     an empty `toolchain:` from this script fails inside `dtolnay/rust-toolchain`
#     with a bare `exit code 1` and one line on stderr, which is the exact
#     failure mode `ci.yml` already documents at length for a missing
#     `toolchain:` input. Failing here instead names the file and the reason.

set -euo pipefail

FILE="${1:-.moon/toolchains.yml}"

if [ ! -f "$FILE" ]; then
  echo "::error::$FILE does not exist. It is the single owner of the Rust channel; a workflow cannot derive one that is not declared." >&2
  exit 1
fi

CHANNEL="$(
  awk '
    # `rust:` is a top-level key: column zero, nothing else on the line. An
    # indented `rust:` is a nested key under some other toolchain and is not
    # this declaration.
    $0 ~ /^rust:[[:space:]]*$/ { want_indent = 1; next }

    # The first real line under `rust:` shows how far this block indents, which
    # is what tells a `version:` belonging to this block from one belonging to
    # something deeper inside it. Latched from the line AFTER the key rather
    # than from document order, so it holds wherever in the file `rust:` sits.
    want_indent {
      if ($0 ~ /^[[:space:]]*$/ || $0 ~ /^[[:space:]]*#/) next
      match($0, /^[[:space:]]*/)
      prefix = substr($0, 1, RLENGTH)
      want_indent = 0
    }

    # The channel itself. An unquoted value is as valid as a quoted one, so
    # only strip quotes that are actually there.
    prefix != "" && index($0, prefix "version:") == 1 {
      line = substr($0, length(prefix) + length("version:") + 1)
      sub(/[[:space:]]*#.*$/, "", line)   # a trailing comment is not the value
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      gsub(/^["'\'']/, "", line)          # open quote
      gsub(/["'\'']$/, "", line)          # close quote
      print line
      exit
    }
  ' "$FILE"
)"

if [ -z "$CHANNEL" ]; then
  echo "::error::$FILE declares no rust.version. Every Rust job needs a channel, and an absent one would reach dtolnay/rust-toolchain as an empty toolchain input and fail there without saying why." >&2
  exit 1
fi

printf '%s\n' "$CHANNEL"