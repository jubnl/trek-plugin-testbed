# Plugin signature testbed

Exercises every state of the signature/trust surface against the **real** install pipeline —
real downloads, real Ed25519 verification, real TOFU pinning.

## How it's wired

Two halves, and the split is deliberate:

- **Artifacts** live in a throwaway GitHub repo (`jubnl/trek-plugin-testbed`, commit
  `9a3ec93`). They have to: `safeDownload()` hard-restricts artifact bytes to
  `github.com` / `codeload` / `*.githubusercontent.com`. No way around it, and no reason to
  want one.
- **The registry index** is served from **localhost:8788**. `fetchRegistry()` uses a plain
  `fetch()` with no allowlist, so the index can live anywhere — which means we can *rewrite*
  it to simulate an author rotating their signing key, and just hit **Rescan** in the UI.

Two Ed25519 authors: **A** (the original) and **B** (the rotated-to key). All signatures were
precomputed at build time, so **no private keys exist anywhere** — not on disk, not in the repo.

## Run it

```bash
# 0. get the testbed
git clone git@github.com:jubnl/trek-plugin-testbed.git ~/dev/trek-plugin-testbed

# 1. the fake registry (leave running)
cd ~/dev/trek-plugin-testbed
node registry.mjs

# 2. TREK, pointed at it — in another terminal
cd ~/dev/TREK
TREK_PLUGIN_REGISTRY_URL=http://localhost:8788/index.json \
TREK_PLUGINS_ENABLED=true \
TREK_PLUGINS_DEV_LINK=1 \
npm run dev
```

Then **Admin → Plugins**. Switch scenarios from `~/dev/trek-plugin-testbed`:

```bash
./scenario            # what's active now
./scenario rotate     # switch — then click Rescan in the UI
```

Valid: `base` `downgrade` `rotate` `rotate-bad` `stale`.

## The walkthrough

### `./scenario base` — install everything (Discover tab)

| Plugin | Expect |
|---|---|
| **Signed Plugin** | installs; **Signed** badge (quiet, neutral) |
| **Unsigned Plugin** | installs; **Unsigned** badge (amber note, not an alarm) |
| **Invalid Signature** | install **refused** → dialog explains, **no override button** |
| **Incomplete Signature** | install **refused** → no override |
| **Downgrade Plugin** | installs, signed by A |
| **Rotating Key** | installs, signed by A |

Discover cards carry the badge too, so you can see Signed/Unsigned *before* installing.

### `./scenario downgrade` → Rescan → update **Downgrade Plugin**

Was signed; the new version ships no signature. Refused (`SIGNATURE_MISSING`), **no override**.
The row now reads **"Update blocked — …"** and *keeps* reading it — that's the whole point,
the reason no longer dies with the toast. Plugin stays healthy on v1.0.0 (health dot is **not**
red — a blocked update is not a broken runtime).

**Toggle it off and on.** The block must survive: activating at the *old* version resolves
nothing, and letting an off/on toggle wipe the warning is exactly the silent-stops-updating
failure this exists to prevent.

### `./scenario rotate` → Rescan → update **Rotating Key**

The money case. Author rotated A → B; v2.0.0 carries a perfectly valid signature under B.

1. Update → refused, `SIGNATURE_KEY_CHANGED` → row shows **Update blocked**.
2. Click **Review** → the re-trust dialog: pinned fingerprint vs new fingerprint, and it says
   plainly that TREK *cannot* tell a real rotation from a takeover — confirm with the author
   out-of-band.
3. **Trust the new key & update** → one call. Plugin lands on v2.0.0, re-pinned to B, block
   cleared. No second `/update`.

Check `Admin → Audit log`: the re-trust is recorded with both key fingerprints.

### `./scenario rotate-bad` → Rescan → update → Review → confirm

Same rotation dialog — but the artifact does **not** actually verify under B. Confirming is
**refused**. A key an admin blesses must still *sign the code it ships*; otherwise "re-trust"
becomes a way to install anything. Old key A stays pinned, plugin stays on v1.0.0.

> Do this one **before** the happy-path rotate, or reinstall Rotating Key first — once it's
> re-pinned to B there's no rotation left to refuse.

### `./scenario stale` → Rescan

Registry now offers v3.0.0, but the recorded block described v2.0.0 — an artifact nobody is
offering anymore. The block **goes quiet** and the normal update button returns.

### Sideload — the precedence rule

Upload `out/dist/sig-signed-1.0.0.tar.gz` via the toolbar (or drag it onto the panel).
It shows **Sideloaded** and **no** trust badge — even though it has no key. Stacking
"Unsigned" on top of "Sideloaded" would double up on a plugin whose badge already says
something strictly stronger, and dilute the amber into wallpaper.

### Dev-link

With `TREK_PLUGINS_DEV_LINK=1`, link any built plugin dir → **Dev-Link** badge, no trust
badge. Same rule.

## Headless proof

With the registry running:

```bash
cd ~/dev/TREK/server
node --require tsconfig-paths/register ~/dev/trek-plugin-testbed/drive.mjs
```

Walks every case above against a temp DB (your dev DB is untouched) and asserts the exact
refusal code for each. **30/30 passing.** `tsconfig-paths` is what resolves the MCP SDK's
exports map — same as `npm start`.

`build.mjs` is the generator, kept for provenance: it made the tarballs and signed them.
You don't need to run it — re-running would mint new keys and invalidate every signature
pinned in `artifacts.json`.

## Teardown

```bash
gh repo delete jubnl/trek-plugin-testbed   # the artifacts
rm -rf server/data                          # dev DB, if it got messy
```
