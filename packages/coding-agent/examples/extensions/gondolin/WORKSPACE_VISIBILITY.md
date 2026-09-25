# Gondolin Workspace Visibility

What the guest may see through the `/workspace` mount.

The implementation is the **"Workspace visibility policy"** section of [`index.ts`](./index.ts).
This document is the inventory behind it — which host directories are non-portable, which
credential-shaped files turn up inside project trees, and what the config should become if
the current three keys stop being enough.

Upstream reference: <https://earendil-works.github.io/gondolin/vfs/>

---

## 1. Mechanics

Three things determine what a guest can reach:

| Layer | Mode | Effect |
| --- | --- | --- |
| `ShadowProvider` (secrets) | `deny`, `denyWriteErrno: ENOENT` | Reads *and* writes report "no such file". Hidden is indistinguishable from absent for `ls`, `stat`, `cat`, `touch`, `mkdir`. |
| `ShadowProvider` (`node_modules`) | `tmpfs` | Host bytes unreadable; guest writes land in the shadow layer and never reach the host. |
| `ShadowProvider` (`.git`, opt-in) | `tmpfs` | Same, for repository metadata. |

Ordering follows the gondolin rule — *"put the most security-sensitive policy closest to the
real host filesystem provider"* — so the deny layer sits directly on `RealFSProvider`.

Other properties worth knowing:

- **Paths are VFS paths rooted at the mount.** The repo root is `/` inside a pattern, not
  `/workspace`.
- **The tree is also visible at `/data/workspace`** (gondolin's default FUSE mount point).
  Same provider instance behind a bind mount, so the policy applies there too.
- **The policy is fixed at mount time.** Editing `gondolin.json` mid-session changes nothing
  until the next VM; `/gondolin` shows the booted policy and the configured policy
  separately.
- **The shadow layer lives in the host pi process**, not guest RAM. `MemoryProvider` is a
  host-side JavaScript object served over FUSE; it is dropped when the session closes.
- **Symlink bypass is blocked** by the shadow layer's default `denySymlinkBypass`.
  `RealFSProvider` alone only blocks links that *escape* the exposed directory, so an
  internal `ln -s .env link` needs the shadow layer to be refused.

---

## 2. Non-portable build directories

Definition: output of an install or build on one OS/architecture that is (a) not runnable or
readable on another, (b) large, (c) regenerable inside the guest. These are candidates for
`tmpfs` shadowing — hide the host's copy, let the guest build its own.

| Ecosystem | Paths | Why non-portable | Covered today |
| --- | --- | --- | --- |
| Node — npm / pnpm / Bun / yarn `nodeLinker: node-modules` | `node_modules/` and everything under it: `.bin/`, `.pnpm/`, `.cache/` | Native addons (`*.node`) and `node-gyp` output are built for the host OS/arch: `dlopen` of a wrong-arch addon errors, and host-built binaries in `.bin` fail with `ENOEXEC` | **Yes** — `hideNodeModules` (default on), segment match at any depth |
| Node — Yarn Berry / PnP | `.pnp.cjs`, `.pnp.loader.mjs`, `.yarn/cache/`, `.yarn/unplugged/`, `.yarn/install-state.gz` | `.yarn/unplugged` holds compiled native modules built for the host; the rest is the package store and resolver | **No** — see below |
| Python | `.venv/`, `venv/`, `env/`, `.tox/`, `.nox/`, `*.egg-info/`, `build/`, `dist/`, `__pycache__/` | A venv pins an interpreter path and arch; C-extension wheels in `site-packages` are host-built | No |
| Rust | `target/` | Compiled artifacts, linker caches, build scripts — host arch throughout | No |
| Ruby | `vendor/bundle/`, `.bundle/` | Bundler compiles native gems into the bundle | No |
| PHP | `vendor/` | Composer may build native extensions; opcache state | No |
| .NET | `bin/`, `obj/` | IL/native output, RID-specific | No |
| Elixir | `_build/`, `deps/` | BEAM beams are portable but NIFs and compiled deps are not | No |
| Terraform | `.terraform/` | Provider plugins are per-OS/arch binaries; the dir also caches cloud credentials | No |
| JVM (project-local) | `.gradle/`, `build/`, `target/` | `.gradle/` holds daemon state with absolute host paths; class caches | No |
| Go | `$GOPATH/pkg/mod`, `~/.cache/go-build` | Rarely a problem — Go cross-compiles, and both live outside the workspace | N/A (outside mount) |

### Notes on the two that need judgement

**Yarn PnP is the one real gap.** `hideNodeModules` never fires for a PnP repo because the
layout has no `node_modules`. But shadowing does not fix it either:

- `.yarn/releases/` is committed deliberately — PnP pins the yarn binary into the repo.
  Hiding it means the guest cannot run yarn at all.
- `.yarn/cache/` *is* the package store. Hiding it forces a re-download of every zip per
  session, which is worse than npm's from-scratch install and defeats PnP's offline property.
- `.pnp.cjs` is the resolver. Hiding it breaks module resolution with no way for the guest
  to regenerate it without the release and the cache.

So the only defensible entry is `.yarn/unplugged`, and even that leaves the guest resolving
against host-built packages it cannot execute. Treat PnP as a documented limitation
("guest needs its own `yarn install` with cache access") rather than a partial shadow.

**Terraform is the closest analogue to `node_modules`** — arch-specific plugin binaries *and*
cached credentials — but it is not default-hidden because a guest without `.terraform` cannot
plan at all, and `terraform init` needs provider access. Opt-in per project.

---

## 3. Credential-shaped files that appear inside project trees

Most credential material lives in `$HOME` and is never visible through this mount. These are
the ones that genuinely turn up in repositories and would be candidates for `hidePaths`:

| File | Typically holds | In `DEFAULT_HIDE_PATHS` |
| --- | --- | --- |
| `.env`, `.env.*` | App secrets | Yes (`.env.example`/`.sample`/`.template`/`.tpl` exempt) |
| `.npmrc` | Registry auth tokens — *also* repo policy like `save-exact` | Yes |
| `.netrc`, `.git-credentials` | Git/HTTP credentials | Yes |
| `*.pem`, `*.key`, `*.p12`, `*.pfx` | Keys and certs | Yes |
| `.git/config` | HTTPS remotes with embedded PATs, `insteadOf` rewrites | No — covered by `hideGit`, not by the path list |
| `.pypirc` | PyPI upload token | No |
| `*.tfstate` | Full infrastructure state, routinely contains secrets | No |
| `terraform.tfvars`, `*.tfvars` | Variables including secrets | No |
| `.docker/config.json` | Registry auth (base64) | No |
| `.kube/config`, `*.kubeconfig` | Cluster admin certificates | No |
| `.composer/auth.json` | Packagist / private repo tokens | No |
| `.cargo/credentials` | crates.io token | No |

`.git/config` is worth calling out separately: the default list hides `.git-credentials` but
not the per-repo `.git/config`, which in many setups is where the token actually lives.
`hideGit` covers it, but only as part of hiding all of `.git`.

---

## 4. What must not be hidden

| Path | Reason |
| --- | --- |
| `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `Cargo.lock`, `poetry.lock`, `go.sum` | Source of truth, not build output |
| `.env.example`, `.env.sample`, `.env.template`, `.env.tpl` | Committed on purpose so a reader can see the shape; already exempted in code |
| `.yarn/releases/` | PnP's pinned yarn binary; hiding it makes yarn unrunnable in the guest |
| `.gitignore`, `.editorconfig`, CI configs | The agent needs them to reason about the repo |

---

## 5. Pattern language gotchas

Verified against `path.posix.matchesGlob` (Node 22.5+):

| Pattern | Matches | Notes |
| --- | --- | --- |
| `.env` | `.env` at **any** depth | Bare names are tested against every path segment, not just the leaf |
| `.env.*` | `.env.local`, `pkg/.env.prod` | Template names exempt unless named explicitly |
| `config/secrets.json` | `/config/secrets.json` | Slash patterns are normalized to VFS-absolute before matching |
| `/config/*.json` | `/config/app.json` | Absolute form works directly |
| `**/.git/config` | `.git/config` at any depth | Use `**/` for nested targeted hiding |
| `~/.ssh` | nothing | The host home is not mounted. `loadWorkspacePolicy` warns about these |

**The dotfile rule bites.** `*` and `**` do not match dot-prefixed segments:

```
**/node_modules/**  matches /a/node_modules/foo      true
**/node_modules/**  matches /a/node_modules/.bin     false
```

This is why the `node_modules` and `.git` layers use `hasSegment()` — plain segment equality,
dot-agnostic — instead of a glob. Prefer `hasSegment()` semantics for any directory whose
children may start with a dot.

---

## 6. Proposed shape if this keeps growing

### Current state

Three top-level keys, merged per key with project scope winning:

```json
{
  "hideNodeModules": true,
  "hideGit": false,
  "hidePaths": [".env", ".env.*", ".npmrc"]
}
```

### Why flags beat a flat list (for now)

A flag names an **intent with behavior attached**; a list names **paths**. Each entry needs
three things a flat list cannot carry:

1. **Write mode.** `node_modules` must be `tmpfs` — the guest has to create its own. `.env`
   must be `deny` — the guest must not create it. One flat list forces a single mode for
   everything, or grows into a list of objects, which is flags with worse ergonomics.
2. **Different default and different breakage.** `hideNodeModules` is nearly free:
   `npm install` works in-guest. `hideGit` removes the agent's repository context entirely.
   One list means one all-or-nothing decision across things with very different costs.
3. **Explanation surface.** `/gondolin` prints a human label plus the config file each value
   came from, per key. A glob list has nowhere to attach "why is this hidden" or "what breaks
   if I turn it off" — the gap that kept the `~/.ssh` no-op invisible.

### Where flags lose

They multiply. `hideNodeModules`, `hideGit`, `hideVenv`, `hideTarget`, `hideBuild`,
`hideDist` — each needs parse, merge, label, status line, and docs. Past about four it is
worse than a list, and non-standard layouts become unexpressible.

### Proposed: presets plus raw entries

**Switch point: the third ecosystem request.** At that point:

```json
{
  "shadow": [
    { "preset": "node", "mode": "tmpfs" },
    { "preset": "git",  "mode": "off" },
    { "pattern": "**/.venv",     "mode": "tmpfs" },
    { "pattern": "**/*.tfstate", "mode": "deny" }
  ]
}
```

Rules:

- A **preset** carries the path set, its default mode, and its status label. Presets are the
  place the inventory in §2 lives, so widening one does not add a top-level key.
- A **raw entry** covers layouts the presets do not. `pattern` uses the §5 language; `mode`
  is `tmpfs` or `deny`.
- **Merge by name**, project scope over user scope, so a project can flip one entry without
  restating the rest. Raw entries merge by `pattern`.
- **`hideNodeModules` and `hideGit` become aliases** for the `node` and `git` preset entries,
  so existing configs keep working during a transition and can be removed later.
- **Status output becomes per-entry**: `node (preset, tmpfs, from project config)`, so the
  booted-vs-configured diff keeps working unchanged.

### Not proposed

A single `hidePaths` that also carries modes inline, or a `visibility: "strict" | "loose"`
preset switch. The first collapses two orthogonal decisions into one structure; the second
hides which specific things are being given up, which is the property worth preserving.

---

## 7. Verification status

Verified against the real gondolin `ShadowProvider` / `RealFSProvider` stack (0.12.0) driven
over a temp fixture tree — 48 assertions, all passing:

- hidden reads, `stat`, `access` → `ENOENT`; hidden writes and `mkdir` → `ENOENT` (not
  `EACCES`, per `denyWriteErrno`)
- shadowed entries absent from `readdir` at root and in subdirectories
- bare-name patterns match at any depth; `.env.example` exempt; an explicit entry outranks
  the exemption
- relative slash patterns hide after normalization
- internal symlink to a hidden file refused; symlinks escaping the root refused by
  `RealFSProvider`'s jail
- `node_modules` and `.git`: host bytes unreadable, guest writes land in the shadow layer,
  host files unchanged, listings show only guest entries
- overlap case (`node_modules/.env`): read refused, write redirected, host never written
- `hidePaths: []` reveals everything; `hideGit: false` exposes host `.git`

Also: `tsc --strict` clean on `index.ts`, and the module imports under Node type stripping.

Not verified here: `npm run check` cannot run inside the guest (biome and tsgo ship
`darwin-arm64` binaries only), and `packages/coding-agent/examples/extensions/gondolin/**` is
excluded from the root `tsconfig.json`, so this file is not covered by the repo type-check.
End-to-end behavior with the new mount policy also needs a fresh VM boot — a session started
before the change still has the old provider stack.
