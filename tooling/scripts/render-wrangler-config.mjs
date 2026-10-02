#!/usr/bin/env node
/**
 * `render-wrangler-config.mjs` — turn `topology.json` into wrangler
 * configuration.
 *
 * WHAT THIS IS. The only thing in this repository that writes a wrangler config.
 * Everything that used to hand-write one — twelve tracked files under
 * `.generated/cloudflare/<environment>/<deployable>/`, plus the duplicate
 * `apps/home-web/wrangler.jsonc` — now runs this instead, and none of them is
 * tracked.
 *
 * WHY IT IS NOT A TEMPLATE ENGINE. There is no `.jsonc` template to fill in. A
 * template would restate every key that is not derived from topology, and a key
 * that is not derived is a key two owners can disagree about — which is the
 * exact failure this work exists to remove. Every block below is emitted because
 * the topology says the deployable has it, not because a template had a
 * placeholder for it.
 *
 * TWO STAGES, ONE CODE PATH. The difference between a shape check and a deploy
 * is where resource IDs come from, and nothing else. Both stages build the same
 * config object from the same topology; only `--stage resolve` has a descriptor
 * to read IDs out of.
 *
 *   --stage offline   No credentials, no descriptor. Every ID that would require
 *                     discovery is emitted as `UNRESOLVED_SENTINEL`, which is a
 *                     string Cloudflare cannot match, so a config that reached a
 *                     real deploy without resolution fails on an unknown resource
 *                     instead of silently working. This is what `pnpm arch`, the
 *                     architecture canary and `moon run :wrangler-validate`
 *                     consume, so **CI validates the shape that deploys.**
 *
 *   --stage resolve   Reads real IDs from `--descriptor <file>` — the ephemeral
 *                     file `reconcile-infra.mjs` writes to a runner's temp
 *                     directory — and writes them into this run's generated tree.
 *                     That tree is untracked and is deleted with the job.
 *
 *   --stage preview   No descriptor. Renders the preview environment for one PR
 *                     at names-only resolution: the Workers, KV namespaces,
 *                     queues, rate limits, hosts and cookie namespace are all
 *                     fully determined by the PR number, so a preview config can
 *                     be rendered, validated and reviewed with no account at all.
 *                     Only the D1 `database_id` is left unresolved, and a preview
 *                     fails on it loudly rather than inheriting a shared database.
 *
 * PATH RELATIVITY. Wrangler resolves `main`, `assets.directory`,
 * `migrations_dir` and `build.command`'s `--out-dir` against the CONFIG FILE's
 * own directory. Generated configs live at
 * `.generated/cloudflare/<environment>/<deployable>/`, which is four segments
 * below the repository root — the same depth as
 * `.generated/cloudflare/<environment>/<deployable>/` was. Every path in the output
 * is therefore computed from `path.relative(configDir, absoluteTarget)` rather
 * than written out by hand, which is what keeps the depth an implementation
 * detail instead of a number copied into twelve files and got wrong once already.
 *
 * No dependencies. Node ≥ 20.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEPLOYABLES,
  ENVIRONMENTS,
  EXIT_CANNOT_RUN,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_USAGE,
  TopologyError,
  loadFrontendSupport,
  loadTopology,
  matchesGrammar,
  reportFailure,
  resolveEnvironment,
} from "./topology-model.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/** Where generated configuration lands. Untracked; see `.gitignore`. */
export const GENERATED_ROOT = ".generated";

/**
 * The environments rendered when `--environment` is not given: the three FIXED
 * ones, not all four.
 *
 * `preview` is excluded on purpose. Rendering it needs a PR number, and a
 * default invocation has none — so an unqualified run would either fail (no
 * number) or, worse, be "fixed" by substituting something for it and produce a
 * Worker called `identity-pr-{pr}`. A default that renders exactly what it can
 * render correctly is better than a default that covers every environment and
 * covers two of them.
 */
const DEFAULT_ENVIRONMENTS = ENVIRONMENTS.filter(
  (environment) => environment !== "preview",
);

/**
 * The value emitted for an identifier that `--stage offline` cannot resolve.
 *
 * A deliberately unmatchable string, NOT an empty string and NOT a plausible
 * UUID. The three tracked development configs used `"0000000000000000000000000000000a"`
 * and `"00000000-0000-0000-0000-000000000000"`, which are *shaped* like real IDs;
 * a config with one of those would pass every shape check here and then point at
 * a resource that either does not exist or, worse, is real. A sentinel that
 * cannot be typed by accident is the whole of the safety property.
 */
export const UNRESOLVED_SENTINEL = "UNRESOLVED_REQUIRES_CLOUDFLARE_CREDENTIAL";

/**
 * Per-deployable facts that are not part of the topology.
 *
 * Listed here and nowhere else, and every one of them is a property of the code
 * rather than of where it is deployed: which directory the artifact lives in,
 * which module the Worker loads, how the Worker is built. Topology owns names,
 * bindings, hosts and policy; it does not own the build.
 *
 * The key is the deployable and the value is why it cannot be derived — a future
 * reader who wants to add a fifth deployable needs to know this is the list to
 * add to, and that adding to it is a decision rather than a lookup.
 */
const DEPLOYABLE_SHAPE = {
  identity: {
    kind: "worker",
    projectDir: "apps/identity/worker",
    entry: "src/lib.rs",
    build: "worker-build",
    ratelimitRole: "identity",
    compatibilityDate: "2026-09-01",
    placement: { production: "smart", staging: "off", development: "off" },
    observability: {
      production: "full",
      staging: "full",
      development: "local",
    },
  },
  "identity-admin": {
    kind: "worker",
    projectDir: "apps/identity-admin/worker",
    entry: "src/lib.rs",
    build: "worker-build",
    ratelimitRole: "identity-admin",
    compatibilityDate: "2026-09-01",
    // Smart placement, in every environment. The Admin Worker calls `identity`
    // through a service binding on nearly every request and is not itself
    // database-bound; running it next to its callee is the same trade `identity`
    // makes for its own database.
    placement: { production: "smart", staging: "smart", development: "off" },
    observability: {
      production: "full",
      staging: "full",
      development: "local",
    },
  },
  "identity-jobs": {
    kind: "worker",
    projectDir: "apps/identity-jobs/worker",
    entry: "src/lib.rs",
    build: "worker-build",
    ratelimitRole: null,
    compatibilityDate: "2026-09-01",
    // Off everywhere. A queue consumer is invoked by Cloudflare from wherever a
    // message is produced, so proximity buys nothing and costs the ability to
    // reason about where it runs.
    placement: { production: "off", staging: "off", development: "off" },
    observability: {
      production: "full",
      staging: "full",
      development: "local",
    },
  },
  "home-web": {
    kind: "worker-and-spa",
    projectDir: "apps/home-web",
    entry: null,
    build: null,
    ratelimitRole: null,
    // A Nuxt server bundle uploaded whole. There is no custom build command:
    // `apps/home-web`'s own moon `build` task produces `.output/`, and wrangler
    // uploads the directory as an artifact.
    //
    // The compatibility date is not optional. The tracked config carried
    // `2024-09-19`, two years stale: it froze the runtime's behaviour against
    // whatever Workers did in September 2024 and nothing was surfacing the
    // drift. Dropping the key is not the fix — `wrangler deploy` refuses to
    // upload a Worker without one, so removing it would have converted a stale
    // date into a broken deploy. The same date as the three Rust Workers is
    // emitted, deliberately, so one Cloudflare runtime version underlies all
    // four deployables; changing it is a single edit here and one line of
    // release notes, not four files that can disagree.
    compatibilityDate: "2026-09-01",
  },
};

/** Queue consumer tuning. Same in every environment. */
const CONSUMER = {
  max_batch_size: 10,
  max_batch_timeout: 30,
  max_retries: 5,
};

/** Log persistence and trace sampling, per observability mode. */
const OBSERVABILITY = {
  /**
   * Deployed environments. `redact_query_string` is not optional on an identity
   * Worker: OAuth authorization requests carry `code`, `state` and `nonce` in
   * the query string, and those are one-time credentials — logging them
   * unredacted turns a log reader into a session thief.
   *
   * `persist` is what makes logs queryable after an incident.
   */
  full: {
    enabled: true,
    redact_query_string: true,
    logs: { enabled: true, head_sampling_rate: 1, persist: true },
    traces: { enabled: true, head_sampling_rate: 0.1, persist: true },
    issues: { enabled: true },
  },
  /**
   * Local development. Not persisted and not traced: a developer's local logs
   * are noise in the account's log index, and persistence costs money for data
   * nobody reads.
   */
  local: {
    enabled: true,
    logs: { enabled: true, head_sampling_rate: 1, persist: false },
  },
};

/* ------------------------------------------------------------------ *
 * Output assembly
 * ------------------------------------------------------------------ */

function push(target, key, value, comment) {
  if (comment) target.push(`  // ${comment}`);
  target.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
}

/**
 * Emit a key that may legitimately need to appear more than once across
 * different code paths — `queues` carries producers in one block and consumers
 * in another, and `services` carries worker-to-worker bindings and the email
 * provider.
 *
 * A repeated top-level key in a `.jsonc` file parses. It is not an error, it is
 * not even a warning from most parsers, and the last occurrence wins — so a
 * producer binding silently vanishes from a config that still validates. That
 * failure mode is invisible at every gate, which is exactly why it is refused
 * here rather than left to an ordering convention.
 */
function emitUnique(target, key, value, comment) {
  const serialized = `  ${JSON.stringify(key)}:`;
  if (
    target.some(
      (line) =>
        line.trimStart().startsWith(serialized.trimStart()) &&
        line.startsWith('  "'),
    )
  ) {
    throw new TopologyError(
      `refusing to emit the key "${key}" twice into one config; a duplicate JSONC key parses and silently drops the first value.`,
    );
  }
  push(target, key, value, comment);
}

/**
 * The custom build command for a Rust Worker.
 *
 * The command locates the repository root itself, and both halves of that are
 * deliberate. There is no `build.cwd`: wrangler passes `cwd` through to
 * `spawn()` unexpanded and resolves relative values against the INVOKING
 * PROCESS's directory, so the relative spellings are caller-dependent and an
 * absolute one hard-codes `/home/<user>/…` into a config that a fork, a CI
 * runner or a second contributor cannot use. `command -v wrangler` resolves
 * through `node_modules` to `<repo>/node_modules/.bin/wrangler`, so three
 * `dirname`s from it is the repository root wherever the repository is.
 *
 * This was a real bug rather than a style preference: the command once used four
 * `..` written for "the config's own directory". Every local command and the
 * `wrangler-validate` moon task `cd` there first, so four was right for them,
 * and `deploy-worker.yml` runs wrangler from the repository root — where four
 * leaves the repository entirely. The first staging deploy failed with
 *
 *     [custom build] /bin/sh: 1: cd: can't cd to ../../../../apps/identity/worker
 *
 * A custom build whose working directory depends on who invoked wrangler is not
 * a build; it is a build that happens to work for the callers somebody happened
 * to try first. The `--out-dir` stays explicit because `worker-build` defaults it
 * to `build` relative to ITS OWN working directory — the crate — so the default
 * writes to `apps/<w>/worker/build/` while wrangler looks in the config
 * directory, and reports "The expected output file at build/index.js was not
 * found", naming the path it could not find rather than the one written.
 */
function rustBuildCommand(shape, configDirAbs, root) {
  const outDir = path
    .relative(root, path.join(configDirAbs, "build"))
    .split(path.sep)
    .join("/");
  const project = shape.projectDir;
  return (
    'ROOT=$(dirname "$(dirname "$(dirname "$(command -v wrangler)")")") && ' +
    `cd "$ROOT/${project}" && ` +
    'cargo install -q "worker-build@^0.8" --locked && ' +
    `worker-build --release --out-dir "$ROOT/${outDir}"`
  );
}

/**
 * Build the browser-safe configuration the three frontends read.
 *
 * IT IS A DIFFERENT FILE FROM THE DEPLOYMENT DESCRIPTOR, and the difference is
 * not tidiness: the descriptor carries `account`, `zone` and the resolved
 * resource names, none of which a browser bundle may read. A frontend that
 * could read it would have a path to an account identifier and to every
 * resource name in the platform, so the projection it gets is built by
 * WHITELIST from the same resolved values rather than by deleting keys from the
 * descriptor. A field added to the descriptor later cannot reach a browser
 * bundle by being forgotten here — it is simply not on the list.
 *
 * What a frontend legitimately needs, and what this therefore carries:
 *
 *   - the cookie policy, which is a property of where the site is deployed;
 *   - the site's own base URL, for canonicals and hreflang alternates;
 *   - the locale and colour-mode vocabulary, which is a property of the
 *     product rather than of the deployment.
 *
 * `baseUrl` is read from `resolved.hosts["home-web"]` and NOT from the
 * deployable loop's `host`. That is not a stylistic choice: `buildConfig()`
 * returns a per-deployable `host`, but the emitted file is per-ENVIRONMENT, so
 * a `baseUrl` taken from the loop would be `https://admin.ecoma.io` in a file
 * the public site reads to build its canonicals.
 */
function resolveCookiePolicy({ topology, environment, resolved }) {
  // ONE owner for the cookie rule, because the descriptor and the browser
  // projection both emit it and a browser bundle cannot be corrected by a
  // server-side deploy. Two copies of this expression drift silently: making
  // staging serve the apex in the descriptor would leave every shipped bundle
  // advertising the old domain, and nothing would fail.
  return {
    name: resolved.cookie_name,
    // Null outside production, for the reason the descriptor states: a
    // cookie scoped to the zone apex is readable by every other preview and
    // by staging, which is the sharing the per-environment NAME prevents.
    domain: environment === "production" ? topology.account.zone : null,
    secure: environment !== "development",
  };
}

function buildFrontendConfig({ topology, support, environment, resolved }) {
  // `resolved` is PASSED IN, not re-resolved here. `buildConfig()` already
  // resolved this environment for the descriptor beside it; calling
  // `resolveEnvironment` a second time ran the whole resolution — template
  // expansion, PR validation, every resource name — once per deployable, four
  // times per environment, to recompute a value that depends on the
  // environment alone. It also made the projection's provenance a matter of
  // trust: two independent resolutions of one environment, with nothing
  // asserting they agree. Taking the object the descriptor was built from
  // makes that structural instead.
  const host = resolved.hosts["home-web"];

  return {
    environment,
    baseUrl: host === null ? null : `https://${host}`,
    cookie: resolveCookiePolicy({ topology, environment, resolved }),
    supportedLocales: support.supportedLocales,
    defaultLocale: support.defaultLocale,
    defaultColorMode: support.defaultColorMode,
  };
}

/**
 * Build one deployable's config for one environment.
 *
 * Exported so the tests can assert against a real object without writing to
 * disk, and so a caller that wants the config in memory (a dry-run, a diff, a
 * reviewer) does not have to go through the filesystem to get it.
 */
export function buildConfig({
  topology,
  support,
  environment,
  deployable,
  pr,
  descriptor,
  configDirAbs,
  root = REPO_ROOT,
}) {
  const shape = DEPLOYABLE_SHAPE[deployable];
  if (!shape) {
    throw new TopologyError(
      `no build shape is declared for deployable ${JSON.stringify(deployable)}; add it to DEPLOYABLE_SHAPE in render-wrangler-config.mjs.`,
    );
  }
  const resolved = resolveEnvironment(topology, environment, { pr });
  const bindings = topology.bindings[deployable];
  const worker = resolved.resources[deployable].worker;
  const host = resolved.hosts[deployable];
  const lines = [];

  const rel = (absolute) =>
    path.relative(configDirAbs, absolute).split(path.sep).join("/") || ".";

  push(
    lines,
    "name",
    worker,
    `The ${environment} name for ${deployable}, from environments.${environment}.resources.${deployable}.worker.`,
  );

  // Unconditional, and deliberately so: a Worker with no compatibility date is
  // refused by `wrangler deploy`, and "the shape table forgot one" is a
  // programming error that should fail here where it is fixable rather than
  // three weeks later in a pipeline.
  if (typeof shape.compatibilityDate !== "string") {
    throw new TopologyError(
      `deployable ${JSON.stringify(deployable)} declares no compatibilityDate; every deployable needs one or wrangler refuses to upload it.`,
    );
  }
  push(lines, "compatibility_date", shape.compatibilityDate);
  push(lines, "compatibility_flags", ["nodejs_compat"]);
  push(lines, "workers_dev", resolved.workers_dev === true);

  if (host !== null) {
    // Custom domains. Omitted entirely where topology declares `null`, rather
    // than emitted as an empty list: an absent key is an honest "this deployable
    // has no hostname", and a declared one is checkable against
    // `services.<name>.public`.
    push(lines, "routes", [
      {
        pattern: host,
        custom_domain: true,
      },
    ]);
  }

  if (shape.kind === "worker") {
    push(lines, "main", "build/index.js");
    if (shape.build) {
      push(
        lines,
        "build",
        { command: rustBuildCommand(shape, configDirAbs, root) },
        "The command locates the repository root itself; see the note above it in render-wrangler-config.mjs.",
      );
    }
    push(
      lines,
      "observability",
      OBSERVABILITY[shape.observability[environment] ?? "production"],
    );
    push(lines, "placement", {
      mode: shape.placement[environment] ?? shape.placement.production,
    });
  } else {
    const artifactDir = rel(path.resolve(root, shape.projectDir, ".output"));
    push(lines, "main", `${artifactDir}/server/index.mjs`);
    push(lines, "assets", {
      binding: "ASSETS",
      directory: `${artifactDir}/public`,
    });
    push(lines, "observability", OBSERVABILITY.full);
  }

  // ---- Bindings. Each block exists iff topology declares the slot. ----

  if (bindings.d1 && resolved.resources[deployable].d1) {
    const d1 = resolved.resources[deployable].d1;
    const entry = {
      binding: bindings.d1,
      database_name: d1.name,
      database_id: descriptorId(descriptor, "d1", d1.name),
      migrations_dir: rel(
        path.resolve(root, "database", "identity", "migrations"),
      ),
    };
    if (d1.migrations_table) entry.migrations_table = d1.migrations_table;
    // `remote: false` makes `wrangler dev` use local emulation. It is emitted
    // for development only; deployed environments must never silently fall back
    // to a local D1 if the real one is unreachable.
    if (environment === "development") entry.remote = false;
    push(
      lines,
      "d1_databases",
      [entry],
      "SC-02/SC-03: only `identity` declares a d1 slot. The Admin Worker holds no D1 binding and the Jobs Worker depends on neither identity crate.",
    );
  }

  if (bindings.kv && resolved.resources[deployable].kv) {
    const kv = resolved.resources[deployable].kv;
    const entry = {
      binding: bindings.kv,
      id: descriptorId(descriptor, "kv", kv.name),
    };
    if (environment === "development") entry.remote = false;
    push(
      lines,
      "kv_namespaces",
      [entry],
      "Rate limits and counters only, never authoritative identity state — which is why a lost namespace costs a day of accurate rate limiting and nothing else.",
    );
  }

  // `queues` and `services` are single keys that may carry BOTH producers and
  // consumers, and BOTH a worker-to-worker binding and the email provider. They
  // are assembled and emitted once each, after every slot has contributed.
  // Emitting either twice would produce a JSONC file with a duplicate key: JSON
  // parses it, last-one-wins, and the binding silently disappears. A duplicate
  // key that parses is the worst kind of config defect, so `emitUnique` refuses
  // it outright rather than trusting an ordering argument to hold.
  const queues = { producers: [], consumers: [] };
  const services = [];

  if (bindings.queue_producer && resolved.resources[deployable].queue) {
    const queue = resolved.resources[deployable].queue;
    const entry = {
      binding: bindings.queue_producer,
      queue: queue.name,
    };
    if (environment === "development") entry.remote = false;
    queues.producers.push(entry);
  }

  // A consumer is a property of the DEPLOYABLE (identity-jobs consumes), bound
  // to a QUEUE of an environment. The queue it consumes is `identity`'s, so it
  // is read from there rather than from this deployable's own resource block —
  // which is also why a deployable with no `queue` slot can still consume.
  if (deployable === "identity-jobs") {
    queues.consumers.push({
      queue: resolved.resources.identity.queue.name,
      ...CONSUMER,
      dead_letter_queue: resolved.resources.identity.queue.dlq,
    });
  }

  if (queues.producers.length > 0) {
    emitUnique(
      lines,
      "queues",
      { producers: queues.producers },
      "contracts/events/v1/ versions the envelope so this producer stays compatible with the consumer across a deploy of either side.",
    );
  }
  if (queues.consumers.length > 0) {
    emitUnique(lines, "queues", { consumers: queues.consumers });
  }

  if (bindings.services.length > 0) {
    const entries = bindings.services.map((target) => ({
      binding: target.toUpperCase().replace(/-/g, "_"),
      service: resolved.resources[target].worker,
    }));
    // Refuse a cross-environment service binding rather than emitting it. A
    // preview Admin Worker able to reach production `identity` is a complete
    // authentication bypass behind a public URL, so this is a renderer-level
    // refusal and not only a validator assertion.
    const foreign = entries.find((entry) =>
      matchesForeignEnvironment(topology, environment, entry.service),
    );
    if (foreign) {
      throw new TopologyError(
        `${environment}/${deployable} would bind service "${foreign.service}", which belongs to another environment. Topology declares environments.${environment}.resources.${deployable}.worker as "${worker}".`,
      );
    }
    services.push(...entries);
  }

  // Omitted entirely when the environment declares no provider.
  //
  // `environments.development.email` is `{ mode: "none", service: null }` and
  // says so in its own `$comment`: "`service: null` is an honest 'there is no
  // email service in this environment' and the renderer omits the binding
  // entirely." It did not omit it. The binding was emitted anyway with a null
  // service, and wrangler's own validation rejected the result:
  //
  //     - "services[0]" bindings should have a string "service" field but got
  //       {"binding":"EMAIL_PROVIDER","service":null}
  //
  // so `moon run :wrangler-validate` — and with it the whole `ci.yml` — has been
  // red since this renderer landed, on a config that is only wrong for an
  // environment where the binding is supposed to be absent.
  //
  // The distinction that makes omitting it the honest reading rather than a
  // suppression: a DEFERRED binding and an ABSENT environment are different
  // facts. `production` and `staging` declare `provisioned: false` and still
  // name a provider — that Worker does not exist yet, the deploy fails on it,
  // and that failure is correct, so those keep the binding and keep failing.
  // `development` names no provider at all, so there is nothing to fail on and
  // nothing to bind. Emitting a binding whose value is `null` invents a third
  // state Cloudflare cannot represent.
  if (bindings.email_provider && resolved.email.service) {
    services.push({
      binding: bindings.email_provider,
      service: resolved.email.service,
    });
  }

  if (services.length > 0) {
    emitUnique(
      lines,
      "services",
      services,
      [
        "Every worker-to-worker binding points at THIS environment's `identity` Worker; the renderer refuses a cross-environment one outright.",
        resolved.email.provisioned
          ? null
          : `The email provider is NOT PROVISIONED: environments.${environment}.email.provisioned is false, so a deploy fails on that binding. That is the correct failure.`,
        "DEFERRED: the email binding exists and the code that calls it does not. This config does not claim the send path works.",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  if (bindings.ratelimit && shape.ratelimitRole) {
    const declared = resolved.ratelimits[shape.ratelimitRole];
    if (!declared) {
      throw new TopologyError(
        `topology declares ratelimits.${environment}.${shape.ratelimitRole} = null or absent, but bindings.${deployable}.ratelimit is ${JSON.stringify(bindings.ratelimit)}.`,
      );
    }
    push(lines, "ratelimits", [{ name: bindings.ratelimit, ...declared }]);
  }

  // ---- Vars ----

  const vars = {
    ENVIRONMENT: environment,
    LOCALE_COOKIE_NAME: resolved.cookie_name,
  };
  // The name the code reads. `crates/identity-cloudflare/src/secrets.rs:147`
  // calls `.var("IDENTITY_ISSUER")` and `crypto.rs:1002` expects the same. The
  // tracked configs all set `ISSUER_BASE_URL`, which nothing reads: the Worker
  // had no issuer configured at all.
  if (deployable === "identity")
    vars.IDENTITY_ISSUER = resolved.issuer_base_url;
  // SC-27. Non-secret configuration only. Secrets come from `wrangler secret put`
  // against the deployed Worker, never from this file and never from a committed
  // `.env`.
  // The locale cookie's NAME is emitted as an ordinary var, under
  // `LOCALE_COOKIE_NAME`, because that is how a Worker tells a front end which
  // cookie to read — and because a non-standard top-level key in a wrangler
  // config is a liability, not a feature. `check-architecture.mjs` classifies
  // every wrangler key it does not recognise as a binding, so an invented key
  // makes the generated config fail the §24 gate on every environment. It is
  // also, strictly, not a valid wrangler field at all: this repository does not
  // hand-edit wrangler configuration, so it must not hand-author extensions of
  // it either.
  //
  // It is NOT derived from `cookie_prefix` here: the front ends read the var,
  // and the var's name is a constant this file and the apps share.
  push(
    lines,
    "vars",
    vars,
    "Non-secret configuration only; secrets are never written to a config file (ADR-0009 §27).",
  );

  // ---- The deployment descriptor: a SECOND generated file ----

  // Separate on purpose. The descriptor is not wrangler configuration; it is the
  // environment identity the three front ends need (cookie name and domain, the
  // canonical base URL), and none of it belongs in a Cloudflare binding surface.
  // Phase 6 has `apps/*/web` and `apps/home-web` read this file instead of
  // hardcoding `ecoma_locale` / `.ecoma.io` / `https://ecoma.io`.
  //
  // The cookie DOMAIN is null outside production because production is the only
  // environment that serves the zone apex. A cookie with `domain=.ecoma.io` set
  // by a preview is readable by every other preview and by staging, which is
  // precisely the sharing the per-environment cookie NAME exists to prevent.
  const deploymentDescriptor = {
    environment,
    pr: resolved.pr,
    account: topology.account.id,
    zone: topology.account.zone,
    host,
    baseUrl: host === null ? null : `https://${host}`,
    issuerBaseUrl: resolved.issuer_base_url,
    cookie: resolveCookiePolicy({ topology, environment, resolved }),
  };
  lines.push("");

  return {
    // `lines` is the file's text and is the only thing this returns: there is
    // no separate object model, because a config assembled two ways and emitted
    // one way is a config whose object model and its text can disagree.
    descriptor: deploymentDescriptor,
    frontend: buildFrontendConfig({ topology, support, environment, resolved }),
    lines: [
      `// GENERATED. Do not edit, and do not commit.`,
      `//`,
      `// ${environment}/${deployable} rendered from infra-topology/topology.json by`,
      `// tooling/scripts/render-wrangler-config.mjs. The topology is the only`,
      `// owner of this Worker's name, bindings, hostname and cookie namespace;`,
      `// this file is a projection of it and has no content of its own.`,
      ...(descriptor
        ? [
            `//`,
            `// Rendered with resolved Cloudflare resource identifiers from an`,
            `// ephemeral reconciliation descriptor. Those identifiers are real and`,
            `// are deliberately not tracked: \`.generated/\` is in .gitignore.`,
          ]
        : []),
      "",
      "{",
      ...lines.slice(0, -1),
      "}",
      "",
    ].join("\n"),
  };
}

/**
 * Whether `service` is a Worker of a DIFFERENT environment than `environment`.
 *
 * The safety property `preview.never_binds_production` states, expressed against
 * resolved names rather than templates: if a preview Worker would receive a
 * service binding to a Worker that is not a preview Worker, refuse.
 *
 * It is written as a two-sided refusal rather than as an equality of two
 * resolved workers. An earlier version compared "which environment owns this
 * name" to "which environment owns that name" and refused whenever they
 * differed — which failed for the two names that are legitimately shared:
 * production and staging both call a Worker called `identity`, because
 * `naming.worker_fixed` is the bare deployable name. Those names do not belong
 * to two environments; they are one name, used twice, in one account. So the
 * test is the property that actually matters: a preview must not reach anything
 * outside the preview, and nothing else is a cross-environment reach in this
 * topology.
 */
function matchesForeignEnvironment(topology, environment, service) {
  if (environment !== "preview") return false;
  return !matchesGrammar(topology, "worker", service);
}

/**
 * The identifier for a logical resource name, or the sentinel.
 *
 * The lookup is by NAME and exact. A descriptor that carries an ID under a
 * different name — or carries two candidates for one name — is refused rather
 * than resolved by taking the first match, for the same reason
 * `reconcile-infra.mjs` refuses to choose between two discovered resources: a
 * duplicate is exactly the condition a resolver must not guess about.
 */
function descriptorId(descriptor, kind, name) {
  if (!descriptor) return UNRESOLVED_SENTINEL;
  const bucket = descriptor.resources?.[kind];
  if (bucket === undefined) return UNRESOLVED_SENTINEL;
  const entry = bucket[name];
  if (entry === undefined) return UNRESOLVED_SENTINEL;
  const id = typeof entry === "string" ? entry : entry?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new TopologyError(
      `descriptor entry ${kind}/${name} carries no id; refusing to guess.`,
    );
  }
  return id;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function usage() {
  return [
    "usage: render-wrangler-config.mjs [options]",
    "",
    "  --stage offline|preview|resolve   how identifiers are obtained (default offline)",
    "  --environment <name>               one environment, or all four",
    "  --deployable <name>               one deployable, or all four",
    "  --pr <number>                     required by --stage preview",
    "  --descriptor <file>               reconciliation descriptor (--stage resolve)",
    "  --out-dir <dir>                   output root (default <repo>/.generated)",
    "  --write                           write files (default: print to stdout)",
    "  --check                           verify the written tree matches, exit non-zero if not",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    stage: "offline",
    environments: null,
    deployables: null,
    pr: undefined,
    descriptor: null,
    outDir: path.join(REPO_ROOT, GENERATED_ROOT),
    write: false,
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new TopologyError(`${arg} needs a value.`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--stage":
        options.stage = next();
        break;
      case "--environment":
        options.environments = [next()];
        break;
      case "--deployable":
        options.deployables = [next()];
        break;
      case "--pr":
        options.pr = next();
        break;
      case "--descriptor":
        options.descriptor = next();
        break;
      case "--out-dir":
        options.outDir = path.resolve(next());
        break;
      case "--write":
        options.write = true;
        break;
      case "--check":
        options.check = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(usage());
        process.exit(EXIT_OK);
        break;
      default:
        throw new TopologyError(`unknown option ${JSON.stringify(arg)}.`);
    }
  }
  return options;
}

/** `pr` is parsed to a number only once, and only for the preview stage. */
function resolveDescriptorArgument(stage, descriptorPath) {
  if (stage === "resolve" && !descriptorPath) {
    throw new TopologyError(
      "--stage resolve requires --descriptor <file>. Reconcile the account first (`pnpm infra:reconcile`) rather than rendering a config that cannot name its own resources.",
    );
  }
  if (stage === "preview" && descriptorPath) {
    throw new TopologyError(
      "--stage preview takes no --descriptor: a preview's identifiers are its own and are resolved at preview deploy time.",
    );
  }
  if (stage !== "resolve") return null;
  if (!fs.existsSync(descriptorPath)) {
    throw new TopologyError(
      `descriptor ${descriptorPath} does not exist. The reconciler writes it to a runner's temp directory; nothing carries resource identifiers in the repository.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  } catch (error) {
    throw new TopologyError(
      `descriptor ${descriptorPath} is not valid JSON: ${error.message}`,
    );
  }
  return parsed;
}

/**
 * Whether this run is writing the repository's own generated tree.
 *
 * The ONE output that is not under `--out-dir`: the vocabulary copy the
 * preference package reads. It has to live there, because an application and a
 * package importing it are two directories that do not share a generated tree
 * they can both name. So it is written only when the caller meant the
 * repository, and a `--out-dir` run — a test, a scratch copy, a CI sandbox —
 * leaves the checkout alone rather than silently rewriting a tracked file it
 * was not asked to touch.
 */
function isDefaultOutDir(outDir) {
  return path.resolve(outDir) === path.join(REPO_ROOT, GENERATED_ROOT);
}

function relativeGeneratedPath(outDir, environment, deployable) {
  return path.join(
    GENERATED_ROOT,
    "cloudflare",
    environment,
    deployable,
    "wrangler.jsonc",
  );
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}`);
    return EXIT_USAGE;
  }

  if (!["offline", "preview", "resolve"].includes(options.stage)) {
    process.stderr.write(
      `unknown --stage ${JSON.stringify(options.stage)}; expected offline, preview or resolve.\n`,
    );
    return EXIT_USAGE;
  }
  if (options.stage === "preview" && options.pr === undefined) {
    process.stderr.write(
      "--stage preview requires --pr <number>. A preview without a PR number has no names: rendering the templates literally would produce a Worker called `identity-pr-{pr}`.\n",
    );
    return EXIT_USAGE;
  }

  const environments = options.environments ?? DEFAULT_ENVIRONMENTS;
  const deployables = options.deployables ?? DEPLOYABLES;
  for (const environment of environments) {
    if (!ENVIRONMENTS.includes(environment)) {
      process.stderr.write(
        `unknown environment ${JSON.stringify(environment)}; expected one of ${ENVIRONMENTS.join(", ")}.\n`,
      );
      return EXIT_USAGE;
    }
  }
  for (const deployable of deployables) {
    if (!DEPLOYABLES.includes(deployable)) {
      process.stderr.write(
        `unknown deployable ${JSON.stringify(deployable)}; expected one of ${DEPLOYABLES.join(", ")}.\n`,
      );
      return EXIT_USAGE;
    }
  }

  let topology;
  let support;
  let descriptor = null;
  try {
    ({ topology } = loadTopology(REPO_ROOT));
    // Loaded here rather than per environment: the vocabulary is a property of
    // the product, not of a deployment, so one read serves every render.
    ({ support } = loadFrontendSupport(REPO_ROOT));
    descriptor = resolveDescriptorArgument(options.stage, options.descriptor);
  } catch (error) {
    reportFailure("render-wrangler-config", error);
    return EXIT_INVALID;
  }

  const written = [];
  const failures = [];
  for (const environment of environments) {
    for (const deployable of deployables) {
      const configDirAbs = path.join(
        options.outDir,
        "cloudflare",
        environment,
        deployable,
      );
      try {
        const {
          lines,
          descriptor: deploymentDescriptor,
          frontend,
        } = buildConfig({
          topology,
          support,
          environment,
          deployable,
          pr: options.pr,
          descriptor,
          configDirAbs,
          root: REPO_ROOT,
        });
        const file = path.join(configDirAbs, "wrangler.jsonc");
        const descriptorFile = path.join(
          options.outDir,
          "deployment",
          `${environment}.json`,
        );
        const frontendFile = path.join(
          options.outDir,
          "frontend",
          `${environment}.json`,
        );
        if (options.write || options.check) {
          fs.mkdirSync(configDirAbs, { recursive: true });
        }
        if (options.write) {
          fs.writeFileSync(file, lines, "utf8");
          fs.mkdirSync(path.dirname(descriptorFile), { recursive: true });
          // Written ONCE per environment, by whichever deployable happens to be
          // rendered first. The content is a function of the environment alone,
          // so writing it four times is harmless — but it is written from the
          // first config so that `--deployable home-web` alone still produces it.
          if (
            !written.some((w) => w.endsWith(`deployment/${environment}.json`))
          ) {
            fs.writeFileSync(
              descriptorFile,
              `${JSON.stringify(deploymentDescriptor, null, 2)}\n`,
              "utf8",
            );
            written.push(
              relativeGeneratedPath(options.outDir, environment, deployable),
              `${GENERATED_ROOT}/deployment/${environment}.json`,
            );
          } else {
            written.push(
              relativeGeneratedPath(options.outDir, environment, deployable),
            );
          }
          // The frontend projection follows the same rule: one file per
          // environment, written once, from the first config rendered for it.
          if (
            !written.some((w) => w.endsWith(`frontend/${environment}.json`))
          ) {
            fs.mkdirSync(path.dirname(frontendFile), { recursive: true });
            const text = `${JSON.stringify(frontend, null, 2)}\n`;
            fs.writeFileSync(frontendFile, text, "utf8");
            // `config.json` is the COPY every frontend imports — one path for
            // all three applications, so no app needs to know which environment
            // it is building. The per-environment file above remains the record.
            //
            // Overwriting it is what makes `FRONTEND_ENVIRONMENT` a real input:
            // a render for staging replaces a development copy rather than
            // leaving the previous environment's cookie name in place. When a
            // run renders several environments at once (`pnpm infra:render`),
            // the LAST one wins — which is why every frontend build renders its
            // OWN environment explicitly rather than relying on a default.
            fs.writeFileSync(
              path.join(options.outDir, "frontend", "config.json"),
              text,
              "utf8",
            );
            written.push(
              `${GENERATED_ROOT}/frontend/${environment}.json`,
              `${GENERATED_ROOT}/frontend/config.json`,
            );
          }
          continue;
        }
        if (options.check) {
          const existing = fs.existsSync(file)
            ? fs.readFileSync(file, "utf8")
            : null;
          if (existing !== lines) {
            failures.push(
              `${relativeGeneratedPath(options.outDir, environment, deployable)} is missing or stale`,
            );
          }
          continue;
        }
        process.stdout.write(lines);
      } catch (error) {
        failures.push(`${environment}/${deployable}: ${error.message}`);
      }
    }
  }

  if (failures.length > 0) {
    process.stderr.write(
      `✗ render-wrangler-config: ${failures.length} config(s) could not be rendered:\n${failures
        .map((f) => `  - ${f}`)
        .join("\n")}\n`,
    );
    return EXIT_CANNOT_RUN;
  }

  // The package's own copy of the vocabulary, so a test or a build with no
  // generated config present still has ONE owner to read. It is GENERATED, and
  // `check-frontend-config.mjs` REFUSES a commit when it has drifted from
  // `infra-topology/frontend-support.json`: the duplication is produced, never
  // maintained.
  //
  // HOISTED OUT OF BOTH LOOPS, and that is the fix rather than a style
  // preference. It used to be written from inside the per-deployable body,
  // which had two consequences, both observed rather than theorised:
  //
  //   - It was written on the FIRST deployable and skipped for the other
  //     three, so a run that failed part-way through the environment loop left
  //     the committed copy refreshed for some environments and stale for
  //     others — a file that is neither the old state nor the new one.
  //   - It wrote to a REPO_ROOT-derived path while every other output honours
  //     `--out-dir`, so `--out-dir /tmp/scratch` still rewrote a tracked file
  //     in the repository. Verified: corrupting the tracked copy and rendering
  //     into a temp directory restored it, which is a renderer that mutates
  //     the checkout it was told not to touch.
  //
  // Written after every environment has rendered and only on success, so the
  // file is either fully current or untouched. It is derived from `support`
  // directly rather than rebuilt key by key: `loadFrontendSupport` already
  // returns a normalized object holding exactly these fields, and rebuilding
  // it meant a field added to the validated model had to be added in a second
  // place — where forgetting it ships a silently incomplete copy instead of
  // failing.
  if (options.write && isDefaultOutDir(options.outDir)) {
    fs.writeFileSync(
      path.join(
        REPO_ROOT,
        "packages",
        "frontend-preferences",
        "frontend-support.json",
      ),
      `${JSON.stringify(support, null, 2)}\n`,
      "utf8",
    );
  }

  if (options.write) {
    process.stdout.write(
      `rendered ${written.length} config(s) into ${path.relative(REPO_ROOT, options.outDir)}/\n`,
    );
  }
  if (options.check) {
    process.stdout.write(
      `${environments.length * deployables.length} config(s) match the topology.\n`,
    );
  }
  return EXIT_OK;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
