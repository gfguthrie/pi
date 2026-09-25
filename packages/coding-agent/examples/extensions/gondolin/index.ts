/**
 * Gondolin Tool Routing Example
 *
 * Runs pi's built-in tools inside a local Gondolin micro-VM. The host working
 * directory is mounted at /workspace in the guest. File changes under
 * /workspace write through to the host; other guest filesystem changes are
 * isolated to the VM.
 *
 * Setup:
 *   cd packages/coding-agent/examples/extensions/gondolin
 *   npm install --ignore-scripts
 *
 * Usage:
 *   cd /path/to/project
 *   pi -e /path/to/pi/packages/coding-agent/examples/extensions/gondolin
 *
 * Requirements:
 *   - Node.js >= 23.6.0 for @earendil-works/gondolin
 *   - QEMU installed (for example, `brew install qemu` on macOS)
 *
 * Guest image selection:
 *   By default the VM boots gondolin's own default image. To use a custom one,
 *   the first of these that is set wins:
 *
 *     1. pi --gondolin-image <selector>
 *     2. <cwd>/.pi/gondolin.json      { "image": "<selector>" }
 *     3. <agent-dir>/gondolin.json    { "image": "<selector>" }
 *     4. gondolin's own default: GONDOLIN_DEFAULT_IMAGE (default "alpine-base:latest")
 *
 *   `GONDOLIN_IMAGE` is retired. The extension invented that name — gondolin
 *   never read it — and placing it above the config files meant a leftover shell
 *   variable outranked the repo. `GONDOLIN_DEFAULT_IMAGE` is gondolin's own knob
 *   and sits below the config files, which is where a machine-wide default
 *   belongs. Setting `GONDOLIN_IMAGE` now warns at startup and changes nothing.
 *   `GONDOLIN_GUEST_DIR` outranks rung 4 — gondolin resolves it before the
 *   default selector — and `/gondolin` names whichever of the two applies.
 *
 *   A selector is a gondolin image ref (`name:tag`), a build id, or a directory
 *   of built guest assets. Prefer a ref: `gondolin image import <dir> --tag
 *   my:latest` repoints the ref on every rebuild, so the config survives
 *   rebuilds, and refs resolve from the local store without touching the network.
 *
 *   Set the pin without editing JSON:
 *     /gondolin image my:latest         # project (.pi/gondolin.json)
 *     /gondolin image --user my:latest  # user  (<agent-dir>/gondolin.json)
 *     /gondolin image clear             # remove the pin
 *     /gondolin image --force my:latest # pin even when it does not resolve locally
 *
 *   `/gondolin` reports the booted image, where the selection came from, and the
 *   asset directory it resolved to.
 *
 * Workspace visibility: the same gondolin.json files also control what the guest
 * can see through the /workspace mount.
 *
 *     {
 *       "image": "my:latest",
 *       "hideNodeModules": true,
 *       "hideGit": false,
 *       "hidePaths": [".env", ".env.*", ".npmrc"]
 *     }
 *
 *   `hideNodeModules` (default true) makes host `node_modules` invisible at every
 *   depth and redirects the guest's own install to a shadow layer, so a Linux
 *   guest never tries to exec host-built binaries and `npm install` starts from
 *   scratch. That layer is gondolin's `MemoryProvider`, which lives in the host pi
 *   process: VFS providers are host-side JavaScript objects served to the guest
 *   over FUSE, not guest RAM, and the layer is dropped when the session closes.
 *
 *   Two consequences of hiding `node_modules` are worth knowing before you turn it
 *   off to get them back. The guest cannot read dependency sources at all, so
 *   "what does this package's type actually say" needs a guest-side install. And
 *   the host `.npmrc` is in the default hide list, so repo npm policy such as
 *   `save-exact` does not apply to installs made inside the VM.
 *
 *   `hideGit` (default false) shadows host `.git` the same way. It is opt-in
 *   because the guest then sees no repository: `git status` and `git diff` through
 *   delegated bash stop working, and anything the guest commits lives in the shadow
 *   layer and is lost. Turn it on for read-only or mirror-style use of a tree.
 *
 *   Either way, guest git commands need one setting the host cannot leave to
 *   config files: `RealFSProvider` passes host ownership through, so `/workspace`
 *   reports the host uid/gid while guest processes run as root, and git rejects
 *   every repo not owned by the effective uid. The extension registers the mount
 *   paths as `safe.directory` entries in each command's environment; see
 *   `gitSafeDirectoryEnv`. That covers the ownership check only. Commits still
 *   need an identity, and the guest has none: the host `~/.gitconfig` is not
 *   mounted, and the inherited `GIT_ASKPASS` names a host path.
 *
 *   `hidePaths` replaces the built-in secret list when present; an empty array
 *   hides nothing. Patterns are VFS paths rooted at the mount, so the repo root is
 *   `/`, and a pattern containing `/` is rooted there for you. Hidden files report
 *   ENOENT for reads and writes alike — tracked ones included, which is why a
 *   hidden `.npmrc` shows in `git status` as deleted. All keys merge per key,
 *   project scope over user scope.
 *
 *   Gondolin also exposes this tree under its own FUSE mount point, so the guest
 *   can reach it at /data/workspace as well as /workspace. That is the same
 *   provider behind a bind mount, so this policy applies there too.
 *
 *   See "Workspace visibility policy" below for matching rules and what each
 *   mode does to reads and writes, and WORKSPACE_VISIBILITY.md next to this file
 *   for the inventory of non-portable build directories across ecosystems and the
 *   proposed config shape if these keys keep growing.
 *
 * Guest resources: RAM and CPU count come from the same gondolin.json files, plus
 * CLI flags. Each key resolves on its own; first hit wins:
 *
 *     1. pi --gondolin-memory <size> / pi --gondolin-cpus <n>
 *     2. <cwd>/.pi/gondolin.json      { "memory": "4G", "cpus": 4 }
 *     3. <agent-dir>/gondolin.json    { "memory": "2G" }
 *     4. gondolin's defaults (memory "1G", cpus 2)
 *
 *   So a project that pins only `cpus` still inherits the user's `memory`.
 *
 *   `memory` must be digits plus a K/M/G/T suffix (`512M`, `4G`), at least 1M.
 *   Gondolin hands the string to QEMU `-m` verbatim and the krun backend parses
 *   it separately, where a bare number means MiB while QEMU reads a bare number
 *   as bytes — requiring the suffix keeps both backends meaning the same thing.
 *   The floor is gondolin's own: it validates nothing in between, and krun rounds
 *   small values up with `Math.max(1, ceil(bytes / MiB))`, so `"0G"` or `"512K"`
 *   is a 1 MiB guest on krun and a bad `-m` argument on the qemu backend.
 *
 *   `cpus` must be an integer from 1 to 255, the cap both QEMU `-smp` and the
 *   krun backend enforce. Decimal digits only: `"0x10"` is rejected rather than
 *   silently read as 16.
 *
 *   Bad values are dropped with an error notification rather than passed through,
 *   and a bad value stops the ladder for that key. The highest layer that sets a
 *   key decides, so a typo in the project file yields gondolin's default rather
 *   than the user's value. Falling through is what made `--gondolin-memory 8GB`
 *   unreadable: the flag looked ignored while a file the caller was not looking at
 *   quietly supplied the size. See `firstConfigured`.
 *
 *   Swap is not configurable. Gondolin 0.12.0 has no swap option and never
 *   creates a swap device, so the guest runs with 0 swap (`/proc/swaps` is empty)
 *   and an OOM is a hard kill rather than a slowdown. Adding swap needs an
 *   upstream gondolin feature — a second disk plus `mkswap`/`swapon` at boot — not
 *   an extension change.
 *
 *   Both values are fixed at boot. Editing the config mid-session affects only the
 *   next VM, the same way the image pin and visibility policy do; `/gondolin`
 *   shows the booted values and the configured ones when they differ.
 *
 * Local patch — guest clock sync. See syncGuestClock() below. The guest clock is
 * frozen while the VM is paused between requests and nothing re-syncs it on
 * resume, which breaks TLS after enough idle time. The host is the time
 * authority, so the extension pushes host time into the guest on start and
 * periodically after.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	ERRNO,
	listImageRefs,
	RealFSProvider,
	resolveImageSelector,
	type ShadowPredicate,
	ShadowProvider,
	type VirtualProvider,
	VM,
	type VMOptions,
} from "@earendil-works/gondolin";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	CONFIG_DIR_NAME,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	getAgentDir,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const GUEST_WORKSPACE = "/workspace";
/**
 * Gondolin's default FUSE mount point. The VFS is mounted here once and individual
 * mounts are bind-mounted into their configured locations, so the workspace tree is
 * also reachable at `/data/workspace`. Same provider, same policy.
 */
const GUEST_FUSE_MOUNT = "/data";
const DEFAULT_GREP_LIMIT = 100;

/** How often to re-check the guest clock during a session. */
const CLOCK_SYNC_MIN_INTERVAL_MS = 60_000;
/** Drift within this is left alone — setting the clock is not free. */
const CLOCK_DRIFT_TOLERANCE_SECONDS = 2;

/** Host wall-clock ms of the last guest clock check. Drives the throttle. */
let clockSyncedAtHostMs = 0;

/**
 * Result of one guest clock check.
 *
 * `driftSeconds` is host minus guest, measured before any correction: positive
 * means the guest is behind, which is the normal direction here because the guest
 * clock only freezes while the VM is paused.
 */
type GuestClockSync = {
	driftSeconds: number;
	/** True only when the step was issued *and* read back at the host value. */
	applied: boolean;
};

/** Guest-clock wording for a host-minus-guest offset in seconds. */
function describeDrift(driftSeconds: number): string {
	const direction = driftSeconds > 0 ? "behind" : "ahead";
	return `${direction} by ${Math.abs(driftSeconds)}s`;
}

/**
 * Push the host clock into the guest.
 *
 * The guest clock is frozen while the VM is paused between requests and is never
 * re-synced on resume, so the offset grows with accumulated idle time. Measured:
 * the rate is exactly 100.0% of real time while the VM is active, but the offset
 * reached ~16 minutes behind across one working session.
 *
 * That breaks TLS. Gondolin's egress proxy mints TLS leaf certs with `notBefore`
 * only minutes behind its own now, so a guest more than a few minutes behind sees
 * every freshly minted cert as CERT_NOT_YET_VALID (curl exit 60). Hosts whose
 * certs are already cached keep working, which makes the failure look
 * intermittent and host-specific rather than like a clock.
 *
 * The host is the time authority: it runs the proxy, and its clock was verified
 * against registry.npmjs.org to the second. So there is nothing to fetch — read
 * it here, write it there. NTP is not usable inside the guest: BusyBox ntpd has
 * no step-once mode (it exits 0 having done nothing) and UDP/123 does not
 * traverse the bridge.
 *
 * `date -u -s @<epoch>` is deliberate. BusyBox date rejects
 * "YYYY-MM-DD HH:MM:SS UTC" as `invalid date` but accepts the `@` form.
 *
 * Returns the measured drift and whether it was actually corrected, or undefined
 * if the guest clock could not be read at all.
 *
 * `applied` is never inferred from an exit status alone. BusyBox ntpd already
 * demonstrated that a guest time command can exit 0 having changed nothing, so
 * the only evidence that counts is reading the clock back after the step.
 */
async function syncGuestClock(target: VM): Promise<GuestClockSync | undefined> {
	const hostEpochSeconds = Math.floor(Date.now() / 1000);

	try {
		const probe = await target.exec(["/bin/sh", "-lc", "date +%s"]);
		const guestEpochSeconds = Number.parseInt(probe.stdout.trim(), 10);
		if (!Number.isFinite(guestEpochSeconds)) return undefined;

		const driftSeconds = hostEpochSeconds - guestEpochSeconds;
		clockSyncedAtHostMs = Date.now();

		if (Math.abs(driftSeconds) <= CLOCK_DRIFT_TOLERANCE_SECONDS) {
			return { driftSeconds, applied: false };
		}

		const stepped = await target.exec(["/bin/sh", "-lc", `date -u -s @${hostEpochSeconds}`]);
		if (stepped.exitCode !== 0) {
			console.warn(`[gondolin] guest clock sync failed (exit ${stepped.exitCode})`);
			return { driftSeconds, applied: false };
		}

		const verify = await target.exec(["/bin/sh", "-lc", "date +%s"]);
		const verifiedSeconds = Number.parseInt(verify.stdout.trim(), 10);
		if (
			!Number.isFinite(verifiedSeconds) ||
			Math.abs(hostEpochSeconds - verifiedSeconds) > CLOCK_DRIFT_TOLERANCE_SECONDS
		) {
			console.warn(
				`[gondolin] guest clock unchanged after sync (host ${hostEpochSeconds}, guest ${verify.stdout.trim()})`,
			);
			return { driftSeconds, applied: false };
		}

		return { driftSeconds, applied: true };
	} catch (error) {
		// A failed sync must not take down VM startup: the session still runs, it
		// just keeps whatever drift it had.
		console.warn("[gondolin] guest clock sync failed:", error);
		return undefined;
	}
}

/** Sync only if the last check is older than CLOCK_SYNC_MIN_INTERVAL_MS. */
async function maybeSyncGuestClock(target: VM): Promise<void> {
	if (Date.now() - clockSyncedAtHostMs < CLOCK_SYNC_MIN_INTERVAL_MS) return;
	await syncGuestClock(target);
}

// ---------------------------------------------------------------------------
// Guest image selection
// ---------------------------------------------------------------------------

/**
 * A resolved image selector plus where it came from.
 *
 * The resolution order is silent — the source is the only way to tell *why* a
 * given image booted, which matters because gondolin itself has fallbacks that
 * look identical to "my setting had no effect".
 */
type ImageSelection = {
	selector: string;
	source: string;
};

/**
 * Parsed contents of a Gondolin config file.
 *
 * "missing" and "invalid" are kept distinct on purpose. Absent is the normal case
 * and safe to create over; a file that exists but cannot be read as a JSON object
 * must never be overwritten, because the write path would then destroy content it
 * cannot see.
 */
type ImageConfigFile = { kind: "missing" } | { kind: "invalid" } | { kind: "object"; value: Record<string, unknown> };

function readImageConfigFile(configPath: string): ImageConfigFile {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`[gondolin] could not read config ${configPath}:`, error);
			return { kind: "invalid" };
		}
		return { kind: "missing" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		console.warn(`[gondolin] ignoring unparseable config ${configPath}:`, error);
		return { kind: "invalid" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		console.warn(`[gondolin] ignoring config ${configPath}: expected a JSON object`);
		return { kind: "invalid" };
	}
	return { kind: "object", value: parsed as Record<string, unknown> };
}

/** A usable `image` value: a non-blank selector string. */
function parseSelectorValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Read the pinned `image` selector from a Gondolin config file. */
function readImageConfigSelector(configPath: string): string | undefined {
	const file = readImageConfigFile(configPath);
	return file.kind === "object" ? parseSelectorValue(file.value.image) : undefined;
}

function writeImageConfigObject(configPath: string, value: Record<string, unknown>): void {
	mkdirSync(path.dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Set or clear the pinned `image` key, leaving every other key in the file alone.
 *
 * This is a read-modify-write, not a whole-file replacement: the file is named
 * `gondolin.json` and will accumulate settings this extension does not model, so
 * a blind write would silently drop them. The file is unlinked only when removing
 * the last remaining key.
 *
 * Returns false when the file exists but is not readable as a JSON object. The
 * caller must surface that rather than overwrite it.
 */
function writeImageConfigSelector(configPath: string, selector: string | undefined): boolean {
	const file = readImageConfigFile(configPath);
	if (file.kind === "invalid") return false;
	const existing = file.kind === "object" ? file.value : {};

	if (selector === undefined) {
		if (!Object.hasOwn(existing, "image")) return true;
		const remaining: Record<string, unknown> = { ...existing };
		delete remaining.image;
		if (Object.keys(remaining).length === 0) {
			try {
				unlinkSync(configPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			return true;
		}
		writeImageConfigObject(configPath, remaining);
		return true;
	}

	writeImageConfigObject(configPath, { ...existing, image: selector });
	return true;
}

/**
 * Classify a selector the way `resolveImageSelector` will read it.
 *
 * Gondolin tries the selector as a path first and falls through to build-id/ref
 * handling when that path does not exist, so a typo'd path surfaces as a ref or
 * build-id error and the shape is lost. Naming the shape up front is what makes a
 * failure message actionable: paths are never downloaded, refs and build ids are.
 */
function classifyImageSelector(selector: string): "path" | "registry" {
	const looksLikePath =
		selector.startsWith("/") ||
		selector.startsWith("~") ||
		selector.startsWith(".") ||
		selector.includes("/") ||
		selector.includes("\\");
	return looksLikePath ? "path" : "registry";
}

type ImageResolution = { ok: true; detail: string } | { ok: false; registryResolvable: boolean; detail: string };

/**
 * Resolve a selector against the local image store without downloading.
 *
 * `resolveImageSelector` is sync and never touches the network, so `ok: false`
 * means "not on this machine", not "does not exist". A `name:tag` ref or build id
 * can still boot by pulling from the builtin registry; a path cannot.
 */
function tryResolveImageSelector(selector: string): ImageResolution {
	try {
		const resolved = resolveImageSelector(selector);
		const details = [
			resolved.source,
			resolved.arch ?? "unknown arch",
			resolved.buildId?.slice(0, 8) ?? "no build id",
		];
		return { ok: true, detail: `${details.join(", ")} -> ${resolved.assetDir}` };
	} catch (error) {
		const reason = (error as Error).message;
		if (classifyImageSelector(selector) === "path") {
			return {
				ok: false,
				registryResolvable: false,
				detail: `not a usable local asset directory, and paths are never downloaded (${reason})`,
			};
		}
		return {
			ok: false,
			registryResolvable: true,
			detail: `not in the local store; the boot will try the builtin registry (${reason})`,
		};
	}
}

/** One-line description of what a selector resolves to locally. */
function describeResolvedImage(selector: string): string {
	return tryResolveImageSelector(selector).detail;
}

/**
 * Name whatever gondolin boots when nothing pins an image.
 *
 * `ensureGuestAssets()` resolves `GONDOLIN_GUEST_DIR` before the default image
 * selector, so a guest-directory override outranks `GONDOLIN_DEFAULT_IMAGE` and
 * has to be reported as that rather than as a ref nobody set. Without this the
 * only env layer left in the ladder is invisible behind the words "gondolin
 * default".
 */
function gondolinDefaultImageLabel(): string {
	const guestDir = process.env.GONDOLIN_GUEST_DIR?.trim();
	if (guestDir) return `gondolin default (GONDOLIN_GUEST_DIR=${guestDir})`;
	const defaultImage = process.env.GONDOLIN_DEFAULT_IMAGE?.trim();
	if (defaultImage) return `gondolin default (GONDOLIN_DEFAULT_IMAGE=${defaultImage})`;
	return "gondolin default (alpine-base:latest)";
}

/**
 * Config files for a project cwd. Project first: a repo can pin its own image
 * over a personal default.
 *
 * The project path comes from the caller's cwd, not from the mount root. The
 * mount and every path mapping in `toGuestPath` are pinned to `localCwd`,
 * captured at extension load, because a guest mount must not move underneath a
 * running session. Config resolution is a different question and follows the
 * session's project instead.
 */
function imageConfigPaths(projectCwd: string): { project: string; user: string } {
	return {
		project: path.join(projectCwd, CONFIG_DIR_NAME, "gondolin.json"),
		user: path.join(getAgentDir(), "gondolin.json"),
	};
}

// ---------------------------------------------------------------------------
// Workspace visibility policy
// ---------------------------------------------------------------------------

/**
 * Files hidden from the guest when `hidePaths` is not set.
 *
 * Bare names match a single path segment at any depth, so `.env` covers
 * `packages/ai/.env` in a monorepo and not just the repo root.
 */
const DEFAULT_HIDE_PATHS = [
	".env",
	".env.*",
	".npmrc",
	".netrc",
	".git-credentials",
	"id_rsa",
	"id_ed25519",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
];

/**
 * Exempt from the dotenv wildcard.
 *
 * `.env.*` catches `.env.example`, which is the one member of the family that is
 * committed on purpose so a reader can see what the shape is. Hiding it breaks
 * exactly the task it exists for. An explicit `hidePaths` entry naming the file
 * still wins, so a project that treats its template as sensitive can hide it.
 */
const NEVER_HIDDEN_NAMES = [".env.example", ".env.sample", ".env.template", ".env.tpl"];

/** Directory shadowed at every depth when `hideNodeModules` is set. */
const NODE_MODULES_SEGMENT = "node_modules";

/** Repository metadata shadowed at every depth when `hideGit` is set. */
const GIT_SEGMENT = ".git";

/**
 * What the guest may see through the workspace mount.
 *
 * Paths are VFS paths: absolute and rooted at the mount, so the repo root is `/`
 * here, not `/workspace`.
 */
type WorkspacePolicy = {
	/** Hide host `node_modules` anywhere; guest writes go to the shadow layer instead. */
	hideNodeModules: boolean;
	/** Hide host `.git` anywhere; guest repo metadata lives in the shadow layer. */
	hideGit: boolean;
	/** Posix glob patterns hidden with reads and writes both reported as absent. */
	hidePaths: string[];
};

/** A resolved policy plus the scope each key came from. */
type WorkspacePolicyState = {
	policy: WorkspacePolicy;
	sources: { hidePaths: string; hideNodeModules: string; hideGit: string };
};

/**
 * Match a VFS path against one hide pattern, including through ancestors.
 *
 * A pattern without "/" is tested against *every* segment, not just the leaf.
 * Testing only the leaf leaks: hiding `.ssh` would drop it from `ls` while
 * `cat /.ssh/id_rsa` still read the host file, because the predicate was only
 * ever shown `id_rsa` and never the `.ssh` directory above it.
 *
 * A pattern with "/" is tested against each ancestor prefix, so `/secrets` also
 * hides `/secrets/tokens/api`. Those comparisons are against absolute prefixes,
 * which is why `createHidePredicate` normalizes patterns first — see
 * `normalizeHidePattern`.
 */
function matchesHidePattern(vfsPath: string, pattern: string): boolean {
	const segments = vfsPath.split("/").filter(Boolean);
	for (let depth = 1; depth <= segments.length; depth++) {
		if (!pattern.includes("/")) {
			if (path.posix.matchesGlob(segments[depth - 1] ?? "", pattern)) return true;
			continue;
		}
		const prefix = `/${segments.slice(0, depth).join("/")}`;
		if (prefix === pattern || prefix.startsWith(`${pattern}/`) || path.posix.matchesGlob(prefix, pattern)) {
			return true;
		}
	}
	return false;
}

/**
 * Root a hide pattern at the mount, the way gondolin roots shadow paths.
 *
 * Gondolin reads shadow paths as absolute VFS paths and normalizes `.env` to
 * `/.env`. `matchesHidePattern` compares slash patterns against absolute
 * prefixes, so an unnormalized `config/secrets.json` matches nothing at any
 * depth and the secret stays readable with no warning. Normalizing first makes
 * both spellings mean the same thing.
 *
 * Bare patterns stay bare on purpose: they match per segment at any depth, which
 * is the reason this predicate exists instead of gondolin's
 * `createShadowPathPredicate` — that one is exact-path only, so `[".env"]` hides
 * the repo-root file but not `packages/ai/.env`.
 *
 * `~` has no meaning inside the mount because the host home directory is not
 * mounted, so `~/.ssh` normalizes to `/~/.ssh` and matches nothing real.
 * `loadWorkspacePolicy` warns about those instead of letting them fail silently.
 */
function normalizeHidePattern(pattern: string): string {
	return pattern.includes("/") && !pattern.startsWith("/") ? `/${pattern}` : pattern;
}

/**
 * Shadow policy for secret-shaped files.
 *
 * Reads report ENOENT and writes report ENOENT too: `createWorkspaceProvider`
 * sets `denyWriteErrno` to ENOENT rather than the EACCES default, so a hidden
 * file is indistinguishable from an absent one whether the guest lists it, stats
 * it, or tries to create it. With the default, `touch .env` answers "permission
 * denied" where an absent file would have succeeded, which is a working probe for
 * what this list contains.
 *
 * The cost is that a legitimate write into a shadowed path reports "no such file
 * or directory" instead of a permission error.
 */
function createHidePredicate(patterns: string[]): ShadowPredicate {
	const normalized = patterns.map(normalizeHidePattern);
	return ({ path: vfsPath }) => {
		const name = path.posix.basename(vfsPath);
		// An entry naming this file explicitly outranks the template exemption.
		if (normalized.some((pattern) => pattern === name || pattern === vfsPath)) return true;
		if (NEVER_HIDDEN_NAMES.includes(name)) return false;
		return normalized.some((pattern) => matchesHidePattern(vfsPath, pattern));
	};
}

/** True when any path segment equals `segment`, at the root or in a subpackage. */
function hasSegment(vfsPath: string, segment: string): boolean {
	return vfsPath.split("/").filter(Boolean).includes(segment);
}

/**
 * Build the provider behind the `/workspace` mount.
 *
 * Layered per the gondolin VFS docs
 * (https://earendil-works.github.io/gondolin/vfs/): "put the most
 * security-sensitive policy closest to the real host filesystem provider". The
 * deny layer therefore sits directly on `RealFSProvider`, so the gate on real
 * host bytes is on the same path as those bytes, and any layer above it can only
 * change the guest's view rather than reach the host.
 *
 * The order shows up in writes, not reads. A path matching both layers — a
 * package's committed `node_modules/.env` — is redirected to the shadow layer by
 * the outer tmpfs layer instead of being refused. It still never reaches the host,
 * and the host copy stays unreadable.
 *
 * `denySymlinkBypass` stays at its default and does the work: the layer also runs
 * the policy against `realpath()`, so `ln -s .env link && cat link` inside the
 * repo resolves to `/.env` and is refused. `RealFSProvider` only blocks symlinks
 * that *escape* the exposed directory, so without this layer the same internal
 * link reads the secret straight through — that default is load-bearing here, not
 * belt-and-braces.
 */
function createWorkspaceProvider(hostDir: string, policy: WorkspacePolicy): VirtualProvider {
	let provider: VirtualProvider = new RealFSProvider(hostDir);
	if (policy.hidePaths.length > 0) {
		provider = new ShadowProvider(provider, {
			shouldShadow: createHidePredicate(policy.hidePaths),
			writeMode: "deny",
			// Hidden means absent for writes as well as reads; see createHidePredicate.
			denyWriteErrno: ERRNO.ENOENT,
		});
	}
	if (policy.hideNodeModules) {
		provider = new ShadowProvider(provider, {
			shouldShadow: ({ path: vfsPath }) => hasSegment(vfsPath, NODE_MODULES_SEGMENT),
			writeMode: "tmpfs",
		});
	}
	if (policy.hideGit) {
		provider = new ShadowProvider(provider, {
			shouldShadow: ({ path: vfsPath }) => hasSegment(vfsPath, GIT_SEGMENT),
			writeMode: "tmpfs",
		});
	}
	return provider;
}

/** Parse a `hidePaths` value, dropping blanks and non-strings. */
function parseHidePaths(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value
		.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
		.map((entry) => entry.trim());
}

/**
 * The gondolin.json files in merge order: user first, then project, so a later
 * layer overwrites keys set by an earlier one.
 */
function configLayers(projectCwd: string): Array<{ scope: string; path: string; file: ImageConfigFile }> {
	const { project, user } = imageConfigPaths(projectCwd);
	return [
		{ scope: "user config", path: user, file: readImageConfigFile(user) },
		{ scope: "project config", path: project, file: readImageConfigFile(project) },
	];
}

/**
 * Read the workspace policy from the gondolin.json files.
 *
 * Per-key merge with project scope winning, matching the `sandbox` and `preset`
 * examples. `hidePaths` replaces the built-in list rather than adding to it: a
 * single additive list would leave no way to make a file visible again short of
 * editing the extension, and `"hidePaths": []` is that way out.
 */
function loadWorkspacePolicy(projectCwd: string): WorkspacePolicyState {
	const layers = configLayers(projectCwd);

	let hidePaths = DEFAULT_HIDE_PATHS;
	let hidePathsSource = "defaults";
	let hideNodeModules = true;
	let hideNodeModulesSource = "defaults";
	let hideGit = false;
	let hideGitSource = "defaults";

	for (const layer of layers) {
		if (layer.file.kind !== "object") continue;
		const configuredPaths = layer.file.value.hidePaths;
		if (configuredPaths !== undefined) {
			const parsed = parseHidePaths(configuredPaths);
			if (!parsed) {
				console.warn(`[gondolin] ignoring non-array hidePaths in ${layer.path}`);
			} else {
				for (const entry of parsed) {
					if (entry.startsWith("~")) {
						console.warn(
							`[gondolin] hidePaths entry "${entry}" in ${layer.path} can never match: the host ` +
								"home directory is not mounted, so ~ has no meaning inside the workspace mount",
						);
					}
				}
				hidePaths = parsed;
				hidePathsSource = layer.scope;
			}
		}
		const configuredNodeModules = layer.file.value.hideNodeModules;
		if (typeof configuredNodeModules === "boolean") {
			hideNodeModules = configuredNodeModules;
			hideNodeModulesSource = layer.scope;
		}
		const configuredGit = layer.file.value.hideGit;
		if (typeof configuredGit === "boolean") {
			hideGit = configuredGit;
			hideGitSource = layer.scope;
		}
	}

	return {
		policy: { hideNodeModules, hideGit, hidePaths },
		sources: {
			hidePaths: hidePathsSource,
			hideNodeModules: hideNodeModulesSource,
			hideGit: hideGitSource,
		},
	};
}

/** Compact form used to diff the booted policy against the configured one. */
function policySummary(policy: WorkspacePolicy): string {
	return `hideNodeModules=${policy.hideNodeModules}, hideGit=${policy.hideGit}, hidePaths=${policy.hidePaths.join(",")}`;
}

/** How the node_modules layer is described in status output. */
function nodeModulesLabel(policy: WorkspacePolicy): string {
	return policy.hideNodeModules
		? "host node_modules hidden; guest installs land in the host-side shadow layer"
		: "host node_modules visible";
}

/** How the .git layer is described in status output. */
function gitLabel(policy: WorkspacePolicy): string {
	return policy.hideGit
		? "host .git hidden; guest repo metadata stays in the host-side shadow layer"
		: "host .git visible";
}

// ---------------------------------------------------------------------------
// Layered config resolution
// ---------------------------------------------------------------------------

/**
 * One candidate value for a single config key, tagged with the layer to blame.
 *
 * The tag is the point: resolution order is silent, and "which layer set this"
 * is the only way to answer why a value won.
 */
type ConfigCandidate = { source: string; value: unknown };

/**
 * Take the first candidate that is set, and stop there even when it is invalid.
 *
 * "First hit wins" has to mean first *hit*, not first *good* hit. The layer that
 * sets a key is the layer the caller believes is in charge, so a bad value there
 * is reported and the key falls back to the backend default rather than to a
 * lower layer nobody is looking at. Falling through is what made
 * `--gondolin-memory 8GB` unreadable: the flag looked ignored while a project
 * file quietly supplied the size.
 */
function firstConfigured<T>(
	candidates: ConfigCandidate[],
	parse: (value: unknown, source: string) => T | undefined,
): { value: T; source: string } | undefined {
	for (const candidate of candidates) {
		if (candidate.value === undefined) continue;
		const value = parse(candidate.value, candidate.source);
		return value === undefined ? undefined : { value, source: candidate.source };
	}
	return undefined;
}

/**
 * Candidates for one key from the gondolin.json layers, highest precedence first.
 *
 * `configLayers` returns merge order (user then project); first-hit resolution
 * wants the reverse, so the list is flipped here rather than reshaping the merge
 * helper around one caller. Layers that are missing or unparseable contribute no
 * candidate, which keeps them meaning "unset" rather than "invalid".
 */
function configuredCandidates(layers: ReturnType<typeof configLayers>, key: string): ConfigCandidate[] {
	const candidates: ConfigCandidate[] = [];
	for (const layer of [...layers].reverse()) {
		if (layer.file.kind !== "object") continue;
		const value = layer.file.value[key];
		// Unset and blank both mean "this layer does not set the key", so neither one
		// stops the ladder for the layers below it.
		if (value === undefined || (typeof value === "string" && value.trim() === "")) continue;
		candidates.push({ source: layer.scope, value });
	}
	return candidates;
}

// ---------------------------------------------------------------------------
// Guest resources
// ---------------------------------------------------------------------------

/**
 * Accepted `memory` spellings: digits plus a K/M/G/T suffix.
 *
 * Gondolin forwards this string to QEMU `-m` unchanged, and the krun backend
 * parses it with its own `^(\d+)([kKmMgGtT]?)$` regex where a bare number means
 * MiB — while QEMU reads a bare number as bytes. Requiring the suffix removes
 * that ambiguity instead of leaving a 1048576x difference to surface as a boot
 * failure on one backend and a useless VM on the other.
 */
const MEMORY_PATTERN = /^(\d+)([KkMmGgTt])$/;

const MEMORY_UNIT_BYTES: Record<string, number> = {
	K: 1024,
	M: 1024 * 1024,
	G: 1024 * 1024 * 1024,
	T: 1024 * 1024 * 1024 * 1024,
};

/**
 * Smallest guest gondolin can actually be given.
 *
 * Gondolin validates nothing between this value and the backend: `memory` goes
 * straight to `-m`, and the krun parser clamps with `Math.max(1, ceil(bytes /
 * MiB))`. Below 1 MiB that means a 1 MiB guest on krun and a rejected `-m`
 * argument on qemu, so the floor is taken from krun's own rounding boundary.
 */
const MIN_MEMORY_BYTES = 1024 * 1024;

/** QEMU `-smp` and the krun backend both cap the guest at 255 vCPUs. */
const MAX_CPUS = 255;

/** Digits only. `Number()` would read "0x10" as 16 and "1e2" as 100. */
const CPU_COUNT_PATTERN = /^\d+$/;

/** Gondolin's own defaults, used in status output when nothing is configured. */
const GONDOLIN_DEFAULT_MEMORY = "1G";
const GONDOLIN_DEFAULT_CPUS = 2;

/** Guest VM sizing. An absent key means "use gondolin's default". */
type ResourceConfig = {
	memory?: string;
	cpus?: number;
};

/** Resolved sizing, the scope each key came from, and what had to be dropped. */
type ResourceState = {
	resources: ResourceConfig;
	sources: { memory?: string; cpus?: string };
	/** Invalid values that were dropped, as human-readable sentences. */
	problems: string[];
};

/** Validate a `memory` value; a bad one is dropped and recorded in `problems`. */
function parseMemoryValue(value: unknown, source: string, problems: string[]): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = typeof value === "string" ? value.trim() : "";
	const match = MEMORY_PATTERN.exec(trimmed);
	if (!match) {
		problems.push(
			`ignoring memory from ${source}: expected a size like "2G" or "512M", got ${JSON.stringify(value)}`,
		);
		return undefined;
	}
	const bytes = Number(match[1]) * (MEMORY_UNIT_BYTES[match[2].toUpperCase()] ?? Number.NaN);
	if (!Number.isFinite(bytes) || bytes < MIN_MEMORY_BYTES) {
		problems.push(`ignoring memory from ${source}: "${trimmed}" is below the 1M minimum a guest can boot with`);
		return undefined;
	}
	return trimmed;
}

/** Validate a `cpus` value, accepting a JSON number or a decimal-digit string. */
function parseCpusValue(value: unknown, source: string, problems: string[]): number | undefined {
	if (value === undefined) return undefined;
	const numeric = typeof value === "string" && CPU_COUNT_PATTERN.test(value.trim()) ? Number(value.trim()) : value;
	if (typeof numeric !== "number" || !Number.isInteger(numeric) || numeric < 1 || numeric > MAX_CPUS) {
		problems.push(
			`ignoring cpus from ${source}: expected an integer between 1 and ${MAX_CPUS}, got ${JSON.stringify(value)}`,
		);
		return undefined;
	}
	return numeric;
}

/** Compact form used to diff the booted sizing against the configured sizing. */
function resourceSummary(resources: ResourceConfig): string {
	return `memory=${resources.memory ?? GONDOLIN_DEFAULT_MEMORY}, cpus=${resources.cpus ?? GONDOLIN_DEFAULT_CPUS}`;
}

/** Status wording for a sizing value that may be falling back to gondolin's default. */
function resourceValueLabel(
	value: string | number | undefined,
	fallback: string | number,
	source: string | undefined,
): string {
	if (value === undefined) return `${fallback} (gondolin default, ${source ?? "defaults"})`;
	return `${value} (${source ?? "defaults"})`;
}

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
	const relativePath = path.relative(root, value);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function hostPathToGuest(localCwd: string, hostPath: string): string {
	const relativePath = path.relative(localCwd, hostPath);
	if (!isInsideHostPath(localCwd, hostPath)) return toPosix(hostPath);
	return relativePath ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath)) : GUEST_WORKSPACE;
}

function toGuestPath(localCwd: string, inputPath: string): string {
	const trimmed = stripAtPrefix(inputPath.trim());
	if (!trimmed) return GUEST_WORKSPACE;
	if (path.isAbsolute(trimmed)) {
		if (isInsideHostPath(localCwd, trimmed)) return hostPathToGuest(localCwd, trimmed);
		return path.posix.resolve("/", toPosix(trimmed));
	}
	return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
	return {
		readFile: async (filePath) => vm.fs.readFile(toGuestPath(localCwd, filePath)),
		access: async (filePath) => {
			await vm.fs.access(toGuestPath(localCwd, filePath));
		},
		detectImageMimeType: async (filePath) => {
			const ext = path.posix.extname(toGuestPath(localCwd, filePath)).toLowerCase();
			if (ext === ".png") return "image/png";
			if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
			if (ext === ".gif") return "image/gif";
			if (ext === ".webp") return "image/webp";
			return null;
		},
	};
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			await vm.fs.writeFile(toGuestPath(localCwd, filePath), content, { encoding: "utf8" });
		},
		mkdir: async (dirPath) => {
			await vm.fs.mkdir(toGuestPath(localCwd, dirPath), { recursive: true });
		},
	};
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
	const readOps = createGondolinReadOps(vm, localCwd);
	const writeOps = createGondolinWriteOps(vm, localCwd);
	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: readOps.access,
	};
}

function createGondolinLsOps(vm: VM, localCwd: string): LsOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		stat: async (filePath) => vm.fs.stat(toGuestPath(localCwd, filePath)),
		readdir: async (dirPath) => vm.fs.listDir(toGuestPath(localCwd, dirPath)),
	};
}

async function walkGuestFiles(
	vm: VM,
	root: string,
	visit: (guestPath: string, relativePath: string) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const stat = await vm.fs.stat(root, { signal });
	if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

	const walkDirectory = async (dir: string, relativeDir: string): Promise<boolean> => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const entries = await vm.fs.listDir(dir, { signal });
		for (const entry of entries) {
			if (entry === ".git" || entry === "node_modules") continue;
			const guestPath = path.posix.join(dir, entry);
			const relativePath = relativeDir ? path.posix.join(relativeDir, entry) : entry;
			let entryStat: Awaited<ReturnType<VM["fs"]["stat"]>>;
			try {
				entryStat = await vm.fs.stat(guestPath, { signal });
			} catch {
				continue;
			}
			if (entryStat.isDirectory()) {
				if (!(await walkDirectory(guestPath, relativePath))) return false;
			} else if (!(await visit(guestPath, relativePath))) {
				return false;
			}
		}
		return true;
	};

	return walkDirectory(root, "");
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const normalizedPattern = toPosix(pattern);
	if (normalizedPattern.includes("/")) {
		return (
			path.posix.matchesGlob(relativePath, normalizedPattern) ||
			path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
		);
	}
	return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

function createGondolinFindOps(vm: VM, localCwd: string): FindOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		glob: async (pattern, cwd, options) => {
			const root = toGuestPath(localCwd, cwd);
			const results: string[] = [];
			await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
				if (results.length >= options.limit) return false;
				if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
				return results.length < options.limit;
			});
			return results;
		},
	};
}

function createLineMatcher(pattern: string, literal: boolean | undefined, ignoreCase: boolean | undefined) {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
	return (line: string) => regex.test(line);
}

function appendGrepBlock(params: {
	outputLines: string[];
	lines: string[];
	relativePath: string;
	lineIndex: number;
	contextLines: number;
}): boolean {
	let linesTruncated = false;
	const start = params.contextLines > 0 ? Math.max(0, params.lineIndex - params.contextLines) : params.lineIndex;
	const end =
		params.contextLines > 0
			? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
			: params.lineIndex;

	for (let index = start; index <= end; index++) {
		const rawLine = params.lines[index] ?? "";
		const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
		if (wasTruncated) linesTruncated = true;
		const separator = index === params.lineIndex ? ":" : "-";
		params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
	}
	return linesTruncated;
}

async function executeGondolinGrep(
	vm: VM,
	localCwd: string,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
	const root = toGuestPath(localCwd, params.path ?? ".");
	const rootStat = await vm.fs.stat(root, { signal });
	const rootIsDirectory = rootStat.isDirectory();
	const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
	const contextLines = params.context && params.context > 0 ? params.context : 0;
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const outputLines: string[] = [];
	const details: GrepToolDetails = {};
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;

	await walkGuestFiles(
		vm,
		root,
		async (guestPath, relativePath) => {
			if (matchCount >= effectiveLimit) return false;
			if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
			let content: string;
			try {
				content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
			} catch {
				return true;
			}
			const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
			for (let index = 0; index < lines.length; index++) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (!matcher(lines[index] ?? "")) continue;
				matchCount++;
				if (appendGrepBlock({ outputLines, lines, relativePath: displayPath, lineIndex: index, contextLines })) {
					linesTruncated = true;
				}
				if (matchCount >= effectiveLimit) {
					matchLimitReached = true;
					return false;
				}
			}
			return true;
		},
		signal,
	);

	if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const rawOutput = outputLines.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const notices: string[] = [];
	let output = truncation.content;

	if (matchLimitReached) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

function sanitizeEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
	if (!env) return undefined;
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

/**
 * Guest paths that need a git `safe.directory` entry.
 *
 * `RealFSProvider` passes host ownership through the mount unchanged, so
 * `/workspace` reports the host uid/gid (501/20 on macOS) while guest processes
 * run as root. Git refuses any repo not owned by the effective uid, so every repo
 * in the tree trips `fatal: detected dubious ownership`. Gondolin's VFS has no
 * uid remap, so this has to be git config rather than a mount option.
 *
 * Shadowing host `.git` is not an escape hatch. `ShadowProvider`'s tmpfs upper
 * layer is a host-side `MemoryProvider`, and its stats default uid/gid to the host
 * pi process's own ids rather than to the guest's, so a guest-side `git init`
 * under `hideGit` reports the host uid too and hits the same fatal. The
 * exception therefore applies whether or not host `.git` is shadowed.
 *
 * Both spellings are required: the tree is also reachable under the FUSE mount,
 * and git reports the repo under the path it was reached by, so a
 * `/workspace`-only entry still leaves `git -C /data/workspace status` failing.
 */
const SAFE_DIRECTORY_PATHS = [GUEST_WORKSPACE, `${GUEST_FUSE_MOUNT}${GUEST_WORKSPACE}`];

/**
 * First pair index the caller left unused.
 *
 * git reads `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` for every `n` below
 * `GIT_CONFIG_COUNT` and treats a missing pair as fatal: `GIT_CONFIG_COUNT=4`
 * with only pairs 2 and 3 present gives `missing config key GIT_CONFIG_KEY_0` /
 * `unable to parse command-line config` and kills the command. The range we hand
 * over therefore has to be contiguous from 0.
 *
 * Counting *complete* pairs keeps it contiguous whatever the caller left behind.
 * Deriving the index from a declared `GIT_CONFIG_COUNT` instead would extend a
 * range whose earlier pairs are not in the environment we forward, and stopping
 * only at a fully absent index would leave a half-present pair (key without
 * value) inside the range we declare. Both turn the caller's git into a no-op.
 */
function firstUnusedConfigIndex(env: NodeJS.ProcessEnv | undefined): number {
	const lookup = env ?? {};
	let index = 0;
	while (lookup[`GIT_CONFIG_KEY_${index}`] !== undefined && lookup[`GIT_CONFIG_VALUE_${index}`] !== undefined) {
		index++;
	}
	return index;
}

/**
 * Command-scope git config for guest commands, as environment variables.
 *
 * `GIT_CONFIG_COUNT` plus `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` (git >= 2.31)
 * is read as a config layer that outranks the repo's own, with no file writes.
 * Env is the only scope that works reliably here: on the agent bash path pi
 * forwards the host environment, so `$HOME` names the host home and does not
 * exist in the guest, which is exactly where `git config --global` would have to
 * write. The `!` user-bash path passes no env at all and keeps the guest's own
 * `$HOME`, but a layer that works on both paths beats one that works on one.
 *
 * Appends after the caller's complete pairs (see `firstUnusedConfigIndex`) so an
 * inherited layer survives; a caller count larger than its own pairs is dropped
 * rather than carried into a fatal.
 */
function gitSafeDirectoryEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
	const base = firstUnusedConfigIndex(env);
	const injected: Record<string, string> = {};
	SAFE_DIRECTORY_PATHS.forEach((safePath, index) => {
		injected[`GIT_CONFIG_KEY_${base + index}`] = "safe.directory";
		injected[`GIT_CONFIG_VALUE_${base + index}`] = safePath;
	});
	injected.GIT_CONFIG_COUNT = String(base + SAFE_DIRECTORY_PATHS.length);
	return injected;
}

function createGondolinBashOps(vm: VM, localCwd: string, shellPath: string): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) throw new Error("aborted");
			const guestCwd = toGuestPath(localCwd, cwd);
			// Injected unconditionally: the shadow layer reports host ownership too, so
			// a guest-created repo needs the exception as much as the mounted one does.
			const guestEnv = { ...sanitizeEnv(env), ...gitSafeDirectoryEnv(env) };
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			let timedOut = false;
			const timer =
				timeout && timeout > 0
					? setTimeout(() => {
							timedOut = true;
							controller.abort();
						}, timeout * 1000)
					: undefined;

			try {
				const proc = vm.exec([shellPath, "-lc", command], {
					cwd: guestCwd,
					env: guestEnv,
					signal: controller.signal,
					stdout: "pipe",
					stderr: "pipe",
				});
				for await (const chunk of proc.output()) onData(chunk.data);
				const result = await proc;
				return { exitCode: result.exitCode };
			} catch (error) {
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw error;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

export default function (pi: ExtensionAPI) {
	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localGrep = createGrepTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localLs = createLsTool(localCwd);

	pi.registerFlag("gondolin-image", {
		description: "Gondolin guest image selector: name:tag ref, build id, or built asset directory",
		type: "string",
	});
	pi.registerFlag("gondolin-memory", {
		description: "Guest VM memory size, digits plus K/M/G/T suffix (e.g. 2G). Overrides gondolin.json",
		type: "string",
	});
	pi.registerFlag("gondolin-cpus", {
		description: `Guest VM cpu count, 1-${MAX_CPUS}. Overrides gondolin.json`,
		type: "string",
	});

	/** A registered string flag, with a blank value treated as unset. */
	function stringFlag(name: string): string | undefined {
		const value = pi.getFlag(name);
		return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
	}

	let vm: VM | undefined;
	let vmStarting: Promise<VM> | undefined;
	let shellPath = "/bin/sh";
	/** The selection the running VM booted with, so status can diff it against config. */
	let bootedImage: ImageSelection | undefined;
	/** The visibility policy the running VM mounted with, for the same reason. */
	let bootedPolicy: WorkspacePolicyState | undefined;
	/** The sizing the running VM booted with, for the same reason. */
	let bootedResources: ResourceState | undefined;

	/**
	 * Resolve guest memory and CPU count. Per key, first hit wins:
	 * `--gondolin-memory` / `--gondolin-cpus` > project config > user config.
	 * Unset keys stay unset so gondolin's own defaults apply.
	 *
	 * Keys resolve independently, so a project pinning only `cpus` still inherits
	 * the user's `memory` — the same per-key merge `loadWorkspacePolicy` uses, and
	 * unlike `resolveImageSelection`, which replaces the whole value.
	 *
	 * A bad value stops the ladder for its key (see `firstConfigured`) and the key
	 * falls back to gondolin's default. Passing one through instead would put a bad
	 * size straight on QEMU's command line, where the whole boot fails and reads as
	 * "gondolin is broken" rather than "my config has a typo".
	 */
	function resolveResourceSelection(projectCwd: string): ResourceState {
		const layers = configLayers(projectCwd);
		const resources: ResourceConfig = {};
		const sources: { memory?: string; cpus?: string } = {};
		const problems: string[] = [];

		const memory = firstConfigured(
			[
				{ source: "--gondolin-memory", value: stringFlag("gondolin-memory") },
				...configuredCandidates(layers, "memory"),
			],
			(value, source) => parseMemoryValue(value, source, problems),
		);
		if (memory !== undefined) {
			resources.memory = memory.value;
			sources.memory = memory.source;
		}

		const cpus = firstConfigured(
			[{ source: "--gondolin-cpus", value: stringFlag("gondolin-cpus") }, ...configuredCandidates(layers, "cpus")],
			(value, source) => parseCpusValue(value, source, problems),
		);
		if (cpus !== undefined) {
			resources.cpus = cpus.value;
			sources.cpus = cpus.source;
		}

		return { resources, sources, problems };
	}

	/**
	 * Resolve the guest image selector for a VM start. First hit wins:
	 * `--gondolin-image` > project config > user config.
	 *
	 * Undefined means "let gondolin pick", which lands on `GONDOLIN_DEFAULT_IMAGE`
	 * (default `alpine-base:latest`) unless `GONDOLIN_GUEST_DIR` points at an asset
	 * directory. `gondolinDefaultImageLabel()` names whichever fallback applies so
	 * status output does not hide it behind the words "gondolin default".
	 *
	 * The image is read as a whole-value pin rather than merged: a project pin is
	 * meant to replace the user pin outright, not blend with it. The workspace
	 * policy and resource keys in the same files are merged per key, so a project
	 * that sets only `hideNodeModules` still inherits the user's `hidePaths`.
	 */
	function resolveImageSelection(projectCwd: string): ImageSelection | undefined {
		const selection = firstConfigured(
			[
				{ source: "--gondolin-image", value: stringFlag("gondolin-image") },
				...configuredCandidates(configLayers(projectCwd), "image"),
			],
			(value) => parseSelectorValue(value),
		);
		return selection === undefined ? undefined : { selector: selection.value, source: selection.source };
	}

	/** Locally imported image refs, for `/gondolin image` completions and usage text. */
	function localImageRefs(): string[] {
		try {
			return listImageRefs().map((ref) => ref.reference);
		} catch (error) {
			console.warn("[gondolin] could not list local image refs:", error);
			return [];
		}
	}

	const IMAGE_USAGE = "Usage: /gondolin image [selector|clear] [--user] [--force]";

	/**
	 * Report a config file this extension refused to overwrite.
	 *
	 * `writeImageConfigSelector` returns false when the file exists but is not
	 * readable as a JSON object. Overwriting it would destroy content this
	 * extension cannot see, so the only safe fix is a human editing the file.
	 */
	function notifyUnwritableConfig(configPath: string, ctx: ExtensionCommandContext): void {
		ctx.ui.notify(
			`Could not update ${configPath}: it exists but is not readable as a JSON object. Fix or remove it by hand.`,
			"error",
		);
	}

	/** Parsed `/gondolin image` arguments. */
	type ImageCommandArgs = {
		scope: "user" | "project";
		force: boolean;
		values: string[];
		unknownFlags: string[];
	};

	/**
	 * Split `/gondolin image` arguments into flags and values.
	 *
	 * A token that starts with "-" and is not a known flag lands in `unknownFlags`
	 * rather than `values`: silently pinning "--usr" as an image name is worse
	 * than refusing the command.
	 */
	function parseImageCommandArgs(args: string): ImageCommandArgs {
		const tokens = args.split(/\s+/).filter(Boolean);
		const knownFlags = new Set(["--user", "--force"]);
		const values = tokens.filter((token) => !knownFlags.has(token));
		return {
			scope: tokens.includes("--user") ? "user" : "project",
			force: tokens.includes("--force"),
			values,
			unknownFlags: values.filter((value) => value.startsWith("-")),
		};
	}

	/**
	 * `/gondolin image [selector|clear] [--user] [--force]`
	 *
	 * Writes the pin to a config file so later sessions pick it up without any
	 * flag or environment variable. The running VM keeps the image it booted with;
	 * this only affects the next start.
	 *
	 * The selector is resolved before anything is written. A pin is persisted and
	 * only bites at the next boot, so an unresolvable selector is reported here
	 * rather than stored away to fail later.
	 */
	function handleImageCommand(args: string, ctx: ExtensionCommandContext): void {
		const { scope, force, values, unknownFlags } = parseImageCommandArgs(args);
		const paths = imageConfigPaths(ctx.cwd);
		const targetPath = scope === "user" ? paths.user : paths.project;

		if (unknownFlags.length > 0) {
			ctx.ui.notify(`${IMAGE_USAGE}\nUnknown flag: ${unknownFlags.join(", ")}`, "warning");
			return;
		}

		if (values.length === 0) {
			const pinned = readImageConfigSelector(targetPath);
			ctx.ui.notify(
				pinned
					? `Pinned ${scope} image: ${pinned} (${targetPath})\n${describeResolvedImage(pinned)}`
					: `No ${scope} image pinned in ${targetPath}.`,
				"info",
			);
			return;
		}
		if (values.length > 1) {
			const refs = localImageRefs().join(", ") || "none imported yet";
			ctx.ui.notify(`${IMAGE_USAGE}\nLocal refs: ${refs}`, "warning");
			return;
		}

		const value = values[0] ?? "";
		if (value === "clear") {
			if (!writeImageConfigSelector(targetPath, undefined)) {
				notifyUnwritableConfig(targetPath, ctx);
				return;
			}
			const next = resolveImageSelection(ctx.cwd);
			ctx.ui.notify(
				`Cleared ${scope} image pin (${targetPath}). Next VM: ${
					next ? `${next.selector} (${next.source})` : gondolinDefaultImageLabel()
				}.`,
				"info",
			);
			return;
		}

		const resolution = tryResolveImageSelector(value);
		if (!resolution.ok && !force) {
			const refs = localImageRefs().join(", ") || "none imported yet";
			const hint = resolution.registryResolvable
				? "A ref or build id that is not imported yet can still boot by pulling from the " +
					"builtin registry. Re-run with --force to pin it anyway."
				: "Re-run with --force to pin it anyway.";
			ctx.ui.notify(
				[`Refused to pin ${value}: ${resolution.detail}`, hint, `Local refs: ${refs}`].join("\n"),
				"warning",
			);
			return;
		}

		if (!writeImageConfigSelector(targetPath, value)) {
			notifyUnwritableConfig(targetPath, ctx);
			return;
		}

		ctx.ui.notify(
			[
				`Pinned image ${value} in ${targetPath}.`,
				resolution.detail,
				`Applies to the next VM; this one keeps ${bootedImage ? bootedImage.selector : gondolinDefaultImageLabel()}.`,
			].join("\n"),
			resolution.ok ? "info" : "warning",
		);
	}

	/**
	 * Complete `/gondolin <TAB>` and `/gondolin image <TAB>`.
	 *
	 * The harness replaces the whole argument text with `item.value`, so every
	 * value repeats the `image ` subcommand.
	 */
	function imageArgumentCompletions(
		argumentText: string,
	): Array<{ value: string; label: string; description?: string }> | null {
		const spaceIndex = argumentText.search(/\s/);
		// Still typing the subcommand word itself.
		if (spaceIndex === -1) {
			return "image".startsWith(argumentText)
				? [{ value: "image", label: "image", description: "select the guest image" }]
				: null;
		}
		if (argumentText.slice(0, spaceIndex) !== "image") return null;
		// Split without trimming so a trailing space means "complete a new token" and
		// the already-typed tokens stay where they are.
		const tokens = argumentText.slice(spaceIndex + 1).split(/\s+/);
		const partial = tokens.at(-1) ?? "";
		const kept = tokens.slice(0, -1).filter(Boolean);
		const candidates = ["clear", "--user", "--force", ...localImageRefs()];
		return candidates
			.filter((candidate) => candidate.startsWith(partial) && !kept.includes(candidate))
			.map((candidate) => ({
				value: ["image", ...kept, candidate].join(" "),
				label: candidate,
			}));
	}

	async function startVm(ctx?: ExtensionContext): Promise<VM> {
		ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", `Gondolin: starting ${GUEST_WORKSPACE}`));
		// Retired rather than silently ignored: a pin in a shell profile that stops
		// working would drop the session onto a different image with no explanation.
		const retiredImageEnv = process.env.GONDOLIN_IMAGE?.trim();
		if (retiredImageEnv) {
			const message =
				`GONDOLIN_IMAGE=${retiredImageEnv} is no longer read. Use GONDOLIN_DEFAULT_IMAGE for a ` +
				"machine-wide default (it sits below the config files), or pin with /gondolin image.";
			console.warn(`[gondolin] ${message}`);
			ctx?.ui.notify(message, "warning");
		}
		const selection = resolveImageSelection(ctx?.cwd ?? localCwd);
		const policy = loadWorkspacePolicy(ctx?.cwd ?? localCwd);
		const resourceState = resolveResourceSelection(ctx?.cwd ?? localCwd);
		for (const problem of resourceState.problems) {
			console.warn(`[gondolin] ${problem}`);
			ctx?.ui.notify(`Gondolin: ${problem}. That key falls back to gondolin's default.`, "error");
		}
		const vmOptions: VMOptions = {
			sessionLabel: `pi ${path.basename(localCwd)}`,
			vfs: {
				mounts: {
					[GUEST_WORKSPACE]: createWorkspaceProvider(localCwd, policy.policy),
				},
			},
		};
		// Set at the top level rather than as `sandbox.memory`: `VM` copies the
		// top-level value into the sandbox only when the sandbox does not already set
		// it, so this cannot fight an explicit sandbox option, and it keeps
		// `vmOptions.sandbox` about the image alone.
		if (resourceState.resources.memory !== undefined) vmOptions.memory = resourceState.resources.memory;
		if (resourceState.resources.cpus !== undefined) vmOptions.cpus = resourceState.resources.cpus;
		// A string selector resolves against the local image store first and only
		// pulls from the builtin registry on a local miss.
		if (selection) vmOptions.sandbox = { imagePath: selection.selector };
		const created = await VM.create(vmOptions);
		// Only once the boot succeeded. Assigning this earlier leaves `/gondolin`
		// reporting an image that never booted if VM.create throws, or while a
		// registry pull is still in flight. Same for the policy: the provider stack
		// is fixed at mount time, so what is live is what this VM was built with.
		bootedImage = selection;
		bootedPolicy = policy;
		bootedResources = resourceState;
		// Before anything that could open a socket: a stale guest clock turns every
		// freshly minted cert into CERT_NOT_YET_VALID.
		const clock = await syncGuestClock(created);
		if (clock && Math.abs(clock.driftSeconds) > CLOCK_DRIFT_TOLERANCE_SECONDS) {
			const summary = `Gondolin guest clock was ${describeDrift(clock.driftSeconds)}`;
			ctx?.ui.notify(
				clock.applied
					? `${summary} — corrected from host.`
					: `${summary} — correction failed, TLS in the guest may still fail.`,
				clock.applied ? "info" : "warning",
			);
		}
		const bashProbe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
		shellPath = bashProbe.stdout.trim() || "/bin/sh";
		vm = created;
		ctx?.ui.setStatus(
			"gondolin",
			ctx.ui.theme.fg("accent", `Gondolin: ${created.id.slice(0, 8)} (${GUEST_WORKSPACE})`),
		);
		const imageNote = selection ? `image ${selection.selector}` : gondolinDefaultImageLabel();
		const readyNote = `Gondolin VM ready (${imageNote}, ${resourceSummary(resourceState.resources)}). ${localCwd} is mounted at ${GUEST_WORKSPACE}.`;
		const policyNotes = [nodeModulesLabel(policy.policy)];
		if (policy.policy.hideGit) policyNotes.push(gitLabel(policy.policy));
		ctx?.ui.notify(`${readyNote} ${policyNotes.join(". ")}.`, "info");
		return created;
	}

	async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
		if (vm) return vm;
		if (!vmStarting) {
			vmStarting = startVm(ctx).finally(() => {
				vmStarting = undefined;
			});
		}
		return vmStarting;
	}

	pi.on("session_start", async (_event, ctx) => {
		await ensureVm(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const activeVm = vm;
		vm = undefined;
		vmStarting = undefined;
		if (!activeVm) return;
		ctx.ui.setStatus("gondolin", ctx.ui.theme.fg("muted", "Gondolin: stopping"));
		try {
			await activeVm.close();
		} finally {
			ctx.ui.setStatus("gondolin", undefined);
		}
	});

	pi.registerCommand("gondolin", {
		description: "Show Gondolin VM status, or select the guest image",
		getArgumentCompletions: imageArgumentCompletions,
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "image" || trimmed.startsWith("image ")) {
				handleImageCommand(trimmed.slice("image".length).trim(), ctx);
				return;
			}
			const activeVm = await ensureVm(ctx);
			const clock = await syncGuestClock(activeVm);
			let driftLabel = "unknown";
			if (clock) {
				driftLabel =
					clock.driftSeconds === 0 ? "in sync with host" : `${describeDrift(clock.driftSeconds)} before this sync`;
				if (Math.abs(clock.driftSeconds) > CLOCK_DRIFT_TOLERANCE_SECONDS) {
					driftLabel += clock.applied ? " (corrected)" : " (correction failed)";
				}
			}
			// Show the booted image and the current config separately: they differ
			// whenever the pin changed after this VM started, and "which image am I in"
			// is otherwise unanswerable. The policy has the same split — the provider
			// stack is built at mount time, so editing gondolin.json mid-session
			// changes nothing until the next VM.
			const current = resolveImageSelection(ctx.cwd);
			const configuredPolicy = loadWorkspacePolicy(ctx.cwd);
			const active = bootedPolicy ?? configuredPolicy;
			const configuredResources = resolveResourceSelection(ctx.cwd);
			const activeResources = bootedResources ?? configuredResources;
			// Every source below is named by scope ("user config", "project config"),
			// so print the paths once here rather than repeating them on each line.
			const configPaths = imageConfigPaths(ctx.cwd);
			const lines = [
				`Gondolin VM: ${activeVm.id}`,
				`Host workspace: ${localCwd}`,
				`Guest workspace: ${GUEST_WORKSPACE}`,
				`Guest alt path: ${GUEST_FUSE_MOUNT}${GUEST_WORKSPACE} (same provider, same policy)`,
				`Shell: ${shellPath}`,
				`Config files: user ${configPaths.user}, project ${configPaths.project}`,
				`Image (booted): ${
					bootedImage ? `${bootedImage.selector} from ${bootedImage.source}` : gondolinDefaultImageLabel()
				}`,
				bootedImage ? describeResolvedImage(bootedImage.selector) : undefined,
				`Guest clock: ${driftLabel}`,
				`Memory: ${resourceValueLabel(
					activeResources.resources.memory,
					GONDOLIN_DEFAULT_MEMORY,
					activeResources.sources.memory,
				)}`,
				`CPUs: ${resourceValueLabel(
					activeResources.resources.cpus,
					GONDOLIN_DEFAULT_CPUS,
					activeResources.sources.cpus,
				)}`,
				`Node modules: ${nodeModulesLabel(active.policy)} (${active.sources.hideNodeModules})`,
				`Git metadata: ${gitLabel(active.policy)} (${active.sources.hideGit})`,
				`Hidden paths: ${active.policy.hidePaths.join(", ") || "none"} (${active.sources.hidePaths})`,
				"Swap: none (gondolin creates no swap device)",
			];
			if (current && current.selector !== bootedImage?.selector) {
				lines.push(`Image (configured): ${current.selector} from ${current.source} — applies to the next VM`);
			}
			if (policySummary(configuredPolicy.policy) !== policySummary(active.policy)) {
				lines.push(`Policy (configured): ${policySummary(configuredPolicy.policy)} — applies to the next VM`);
			}
			if (resourceSummary(configuredResources.resources) !== resourceSummary(activeResources.resources)) {
				lines.push(
					`Resources (configured): ${resourceSummary(configuredResources.resources)} — applies to the next VM`,
				);
			}
			for (const problem of configuredResources.problems) {
				lines.push(`Resource config: ${problem}`);
			}
			ctx.ui.notify(lines.filter((line): line is string => line !== undefined).join("\n"), "info");
		},
	});

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createReadTool(GUEST_WORKSPACE, {
				operations: createGondolinReadOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createWriteTool(GUEST_WORKSPACE, {
				operations: createGondolinWriteOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createEditTool(GUEST_WORKSPACE, {
				operations: createGondolinEditOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createBashTool(GUEST_WORKSPACE, {
				operations: createGondolinBashOps(activeVm, localCwd, shellPath),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createLsTool(GUEST_WORKSPACE, {
				operations: createGondolinLsOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createFindTool(GUEST_WORKSPACE, {
				operations: createGondolinFindOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			return executeGondolinGrep(activeVm, localCwd, params, signal);
		},
	});

	pi.on("user_bash", async (_event, ctx) => {
		const activeVm = await ensureVm(ctx);
		// `!cmd` runs without an agent turn, so before_agent_start never fires for it.
		// Without this, a bash command issued after a long idle still sees
		// CERT_NOT_YET_VALID on freshly minted proxy certs.
		await maybeSyncGuestClock(activeVm);
		return { operations: createGondolinBashOps(activeVm, localCwd, shellPath) };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const activeVm = await ensureVm(ctx);
		// One sync only covers the stretch that follows it — every pause re-arms the
		// drift, and session_start fires only once. Throttled so this costs at most
		// one exec per minute rather than one per turn.
		await maybeSyncGuestClock(activeVm);
		const localLine = `Current working directory: ${localCwd}`;
		const guestLine = `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM; host workspace mounted from ${localCwd})`;
		const systemPrompt = event.systemPrompt.includes(localLine)
			? event.systemPrompt.replace(localLine, guestLine)
			: `${event.systemPrompt}\n\n${guestLine}`;
		return { systemPrompt };
	});
}
