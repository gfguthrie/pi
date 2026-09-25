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
 *     2. GONDOLIN_IMAGE=<selector>
 *     3. <cwd>/.pi/gondolin.json      { "image": "<selector>" }
 *     4. <agent-dir>/gondolin.json    { "image": "<selector>" }
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
 * Local patch — guest clock sync. See syncGuestClock() below. The guest clock is
 * frozen while the VM is paused between requests and nothing re-syncs it on
 * resume, which breaks TLS after enough idle time. The host is the time
 * authority, so the extension pushes host time into the guest on start and
 * periodically after.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listImageRefs, RealFSProvider, resolveImageSelector, VM, type VMOptions } from "@earendil-works/gondolin";
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

/** Read the pinned `image` selector from a Gondolin config file. */
function readImageConfigSelector(configPath: string): string | undefined {
	const file = readImageConfigFile(configPath);
	if (file.kind !== "object") return undefined;
	const image = file.value.image;
	if (typeof image !== "string" || image.trim() === "") return undefined;
	return image.trim();
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

function createGondolinBashOps(vm: VM, localCwd: string, shellPath: string): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) throw new Error("aborted");
			const guestCwd = toGuestPath(localCwd, cwd);
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
					env: sanitizeEnv(env),
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

	let vm: VM | undefined;
	let vmStarting: Promise<VM> | undefined;
	let shellPath = "/bin/sh";
	/** The selection the running VM booted with, so status can diff it against config. */
	let bootedImage: ImageSelection | undefined;

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

	/**
	 * Resolve the guest image selector for a VM start. First hit wins:
	 * `--gondolin-image` > `GONDOLIN_IMAGE` > project config > user config.
	 * Undefined means "let gondolin use its own default".
	 *
	 * First-wins-per-file is deliberate while this config is single-key: a project
	 * pin is meant to replace the user pin outright, not blend with it. If a second
	 * key is ever added to gondolin.json, switch to a merge (as the `sandbox` and
	 * `preset` examples do) or a project pin will silently discard the user's
	 * other settings.
	 */
	function resolveImageSelection(projectCwd: string): ImageSelection | undefined {
		const flag = pi.getFlag("gondolin-image");
		if (typeof flag === "string" && flag.trim() !== "") {
			return { selector: flag.trim(), source: "--gondolin-image" };
		}
		const envSelector = process.env.GONDOLIN_IMAGE;
		if (envSelector && envSelector.trim() !== "") {
			return { selector: envSelector.trim(), source: "GONDOLIN_IMAGE" };
		}
		const { project, user } = imageConfigPaths(projectCwd);
		const projectSelector = readImageConfigSelector(project);
		if (projectSelector) return { selector: projectSelector, source: project };
		const userSelector = readImageConfigSelector(user);
		if (userSelector) return { selector: userSelector, source: user };
		return undefined;
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
					next ? `${next.selector} (${next.source})` : "gondolin default"
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
				`Applies to the next VM; this one keeps ${bootedImage ? bootedImage.selector : "the gondolin default"}.`,
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
		const selection = resolveImageSelection(ctx?.cwd ?? localCwd);
		const vmOptions: VMOptions = {
			sessionLabel: `pi ${path.basename(localCwd)}`,
			vfs: {
				mounts: {
					[GUEST_WORKSPACE]: new RealFSProvider(localCwd),
				},
			},
		};
		// A string selector resolves against the local image store first and only
		// pulls from the builtin registry on a local miss.
		if (selection) vmOptions.sandbox = { imagePath: selection.selector };
		const created = await VM.create(vmOptions);
		// Only once the boot succeeded. Assigning this earlier leaves `/gondolin`
		// reporting an image that never booted if VM.create throws, or while a
		// registry pull is still in flight.
		bootedImage = selection;
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
		const imageNote = selection ? `image ${selection.selector}` : "gondolin default image";
		ctx?.ui.notify(`Gondolin VM ready (${imageNote}). ${localCwd} is mounted at ${GUEST_WORKSPACE}.`, "info");
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
			// is otherwise unanswerable.
			const current = resolveImageSelection(ctx.cwd);
			const lines = [
				`Gondolin VM: ${activeVm.id}`,
				`Host workspace: ${localCwd}`,
				`Guest workspace: ${GUEST_WORKSPACE}`,
				`Shell: ${shellPath}`,
				`Image (booted): ${
					bootedImage ? `${bootedImage.selector} from ${bootedImage.source}` : "gondolin default"
				}`,
				bootedImage ? describeResolvedImage(bootedImage.selector) : undefined,
				`Guest clock: ${driftLabel}`,
			];
			if (current && current.selector !== bootedImage?.selector) {
				lines.push(`Image (configured): ${current.selector} from ${current.source} — applies to the next VM`);
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
