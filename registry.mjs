/**
 * The fake TREK plugin registry, served on http://localhost:8788/index.json.
 *
 * Why local: `fetchRegistry()` uses a plain fetch with no host allowlist, so the INDEX can
 * live anywhere — while `safeDownload()` locks the ARTIFACT bytes to GitHub hosts. That
 * split is the whole trick. It means we can rewrite the index between requests to simulate
 * an author rotating their signing key, and just hit "Rescan" in the admin UI — no
 * republishing, no waiting on a CDN.
 *
 * The scenario is re-read from scenario.txt on EVERY request, so switching is:
 *     ./scenario rotate      (then click Rescan in the UI)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const DIR = import.meta.dirname;
const REPO = 'jubnl/trek-plugin-testbed';
const SHA = fs.readFileSync(path.join(DIR, 'commit.txt'), 'utf8').trim();
const ART = JSON.parse(fs.readFileSync(path.join(DIR, 'artifacts.json'), 'utf8'));
const PUB = JSON.parse(fs.readFileSync(path.join(DIR, 'pubkeys.json'), 'utf8'));

const url = (file) => `https://raw.githubusercontent.com/${REPO}/${SHA}/dist/${file}`;

/**
 * One registry version. `sig` selects which precomputed signature to attach:
 *   'A' / 'B'        — a VALID signature by that author over these exact bytes
 *   'badB'           — well-formed, made by B, but over DIFFERENT bytes: it will not verify
 *   null             — no signature at all
 */
function version(id, v, sig) {
  const a = ART[`${id}@${v}`];
  const signature = sig === 'A' ? a.sigA : sig === 'B' ? a.sigB : sig === 'badB' ? a.sigBadB : sig === 'badA' ? a.sigBadA : undefined;
  return {
    version: v, gitTag: `v${v}`, commitSha: SHA, downloadUrl: url(a.file),
    sha256: a.sha256, size: a.size, minTrekVersion: '3.0.0', apiVersion: 1,
    publishedAt: '2026-07-01T00:00:00Z',
    ...(signature ? { signature } : {}),
  };
}

const plugin = (id, name, description, authorKey, versions) => ({
  id, name, author: 'Testbed Author', description, repo: REPO, type: 'widget',
  reviewedAt: null, downloadCount: 0,
  ...(authorKey ? { authorPublicKey: PUB[authorKey] } : {}),
  versions,
});

/** Each scenario is the whole registry as the author would be publishing it at that moment. */
const SCENARIOS = {
  // Install these first. Two install cleanly (one Signed, one Unsigned); three are refused,
  // each with a different non-overridable code.
  base: () => [
    plugin('sig-signed', 'Signed Plugin', 'Installs clean, signed by author A.', 'A', [version('sig-signed', '1.0.0', 'A')]),
    plugin('sig-unsigned', 'Unsigned Plugin', 'Installs clean. No key, no signature.', null, [version('sig-unsigned', '1.0.0', null)]),
    plugin('sig-invalid', 'Invalid Signature', 'Signature does not verify → SIGNATURE_INVALID.', 'A', [version('sig-invalid', '1.0.0', 'badA')]),
    plugin('sig-incomplete', 'Incomplete Signature', 'Key declared, version unsigned → SIGNATURE_INCOMPLETE.', 'A', [version('sig-incomplete', '1.0.0', null)]),
    plugin('sig-downgrade', 'Downgrade Plugin', 'Signed now; later ships an unsigned update.', 'A', [version('sig-downgrade', '1.0.0', 'A')]),
    plugin('sig-rotate', 'Rotating Key', 'Signed by A now; later rotates to B.', 'A', [version('sig-rotate', '1.0.0', 'A')]),
  ],

  // The money case. sig-rotate now offers v2.0.0 signed by a DIFFERENT author key (B), with
  // a perfectly valid signature under B. Updating it → SIGNATURE_KEY_CHANGED → blocked row
  // → Review → re-trust dialog → confirm → installs v2.0.0 and re-pins to B.
  rotate: () => [
    ...SCENARIOS.base().filter((p) => p.id !== 'sig-rotate'),
    plugin('sig-rotate', 'Rotating Key', 'Now signed by author B (a key rotation).', 'B', [
      version('sig-rotate', '2.0.0', 'B'),
      version('sig-rotate', '1.0.0', 'A'),
    ]),
  ],

  // The rotation is offered, but the artifact does NOT actually verify under the new key.
  // Confirming the re-trust must be REFUSED — a key an admin blesses still has to sign the
  // code it ships. This is the downgrade hole the design exists to close.
  'rotate-bad': () => [
    ...SCENARIOS.base().filter((p) => p.id !== 'sig-rotate'),
    plugin('sig-rotate', 'Rotating Key', 'Offers key B, but the signature is bogus.', 'B', [
      version('sig-rotate', '2.0.0', 'badB'),
      version('sig-rotate', '1.0.0', 'A'),
    ]),
  ],

  // A NEWER version than the one that was refused. The recorded block described v2.0.0, so
  // it now describes an artifact nobody is being offered — the row should go quiet.
  stale: () => [
    ...SCENARIOS.base().filter((p) => p.id !== 'sig-rotate'),
    plugin('sig-rotate', 'Rotating Key', 'Now offers v3.0.0 — the old block is stale.', 'B', [
      version('sig-rotate', '3.0.0', 'B'),
      version('sig-rotate', '2.0.0', 'B'),
      version('sig-rotate', '1.0.0', 'A'),
    ]),
  ],

  // Was signed when installed; the update ships no signature at all. TREK must refuse to
  // quietly accept the downgrade → SIGNATURE_MISSING, non-overridable.
  downgrade: () => [
    ...SCENARIOS.base().filter((p) => p.id !== 'sig-downgrade'),
    plugin('sig-downgrade', 'Downgrade Plugin', 'The new version dropped its signature.', null, [
      version('sig-downgrade', '2.0.0', null),
      version('sig-downgrade', '1.0.0', 'A'),
    ]),
  ],
};

const scenario = () => fs.readFileSync(path.join(DIR, 'scenario.txt'), 'utf8').trim();

http
  .createServer((req, res) => {
    const name = scenario();
    const build = SCENARIOS[name];
    if (!build) {
      res.writeHead(500).end(`unknown scenario "${name}"`);
      return;
    }
    const body = JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), plugins: build() }, null, 2);
    console.log(`[registry] ${req.url} → scenario "${name}" (${build().length} plugins)`);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
  })
  .listen(8788, () => console.log(`registry on http://localhost:8788/index.json — scenario "${scenario()}"`));
