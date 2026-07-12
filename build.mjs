/**
 * Build the plugin-signature testbed.
 *
 * Produces, into ./out:
 *   dist/<id>-<version>.tar.gz   — the artifacts (committed to the GitHub testbed repo,
 *                                  because the installer's host allowlist means the BYTES
 *                                  must come from a github host)
 *   keys.json                    — two Ed25519 keypairs (author A and author B)
 *   artifacts.json               — sha256 + signature-under-A / signature-under-B per file
 *
 * Signing is raw Ed25519 over the artifact bytes, base64 — which is exactly one of the
 * forms verify-signature.ts accepts (a bare 32-byte pubkey / 64-byte signature), so no
 * minisign binary is needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, createPrivateKey, generateKeyPairSync, sign as edSign } from 'node:crypto';

const OUT = path.join(import.meta.dirname, 'out');
const DIST = path.join(OUT, 'dist');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// ── keys ─────────────────────────────────────────────────────────────────────
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    priv: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}
const keys = { A: keypair(), B: keypair() };
const signWith = (which, bytes) => {
  const key = createPrivateKey({ key: Buffer.from(keys[which].priv, 'base64'), format: 'der', type: 'pkcs8' });
  return edSign(null, bytes, key).toString('base64');
};

// ── minimal tar.gz ───────────────────────────────────────────────────────────
function tarHeader(name, size, typeflag = '0') {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0); h.write('0000644', 100); h.write('0000000', 108); h.write('0000000', 116);
  h.write(size.toString(8).padStart(11, '0'), 124); h.write('00000000000', 136);
  h.write('        ', 148); h.write(typeflag, 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
function tarGz(files) {
  const parts = [];
  for (const f of files) {
    const body = Buffer.from(f.data ?? '');
    parts.push(tarHeader(f.name, f.dir ? 0 : body.length, f.dir ? '5' : '0'));
    if (!f.dir) {
      parts.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts));
}

/** A tiny but REAL plugin: valid manifest + a server entry the supervisor can fork. */
function artifact(id, version, label) {
  const root = `${id}-${version}`;
  const manifest = {
    id, name: label, version, type: 'widget', apiVersion: 1, trek: '>=3.0.0',
    description: `Signature testbed — ${label} v${version}`,
    permissions: ['db:own'],
    capabilities: { widget: { slot: 'sidebar' } },
  };
  const server = `module.exports = {
  async onLoad(ctx) { ctx.log?.info?.('${id} v${version} loaded'); },
  routes: [{ method: 'GET', path: '/ping', auth: false, async handler() {
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: '${id}', version: '${version}' }) };
  }}],
};\n`;
  return tarGz([
    { name: `${root}/`, dir: true },
    { name: `${root}/trek-plugin.json`, data: JSON.stringify(manifest, null, 2) },
    { name: `${root}/server/`, dir: true },
    { name: `${root}/server/index.js`, data: server },
  ]);
}

// Every (plugin, version) the scenarios need.
const BUILDS = [
  ['sig-signed', '1.0.0', 'Signed Plugin'],
  ['sig-unsigned', '1.0.0', 'Unsigned Plugin'],
  ['sig-invalid', '1.0.0', 'Invalid Signature'],
  ['sig-incomplete', '1.0.0', 'Incomplete Signature'],
  ['sig-downgrade', '1.0.0', 'Downgrade Plugin'],
  ['sig-downgrade', '2.0.0', 'Downgrade Plugin'],
  ['sig-rotate', '1.0.0', 'Rotating Key'],
  ['sig-rotate', '2.0.0', 'Rotating Key'],
  ['sig-rotate', '3.0.0', 'Rotating Key'],
];

const artifacts = {};
for (const [id, version, label] of BUILDS) {
  const bytes = artifact(id, version, label);
  const file = `${id}-${version}.tar.gz`;
  fs.writeFileSync(path.join(DIST, file), bytes);
  artifacts[`${id}@${version}`] = {
    file,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sigA: signWith('A', bytes),
    sigB: signWith('B', bytes),
    // A signature made by B over DIFFERENT bytes: well-formed, but it does not verify.
    // This is what proves a re-trusted key must still actually sign the code it ships.
    sigBadB: signWith('B', Buffer.concat([bytes, Buffer.from('tampered')])),
    sigBadA: signWith('A', Buffer.concat([bytes, Buffer.from('tampered')])),
  };
}

fs.writeFileSync(path.join(OUT, 'keys.json'), JSON.stringify(keys, null, 2));
fs.writeFileSync(path.join(OUT, 'artifacts.json'), JSON.stringify(artifacts, null, 2));
console.log(`built ${BUILDS.length} artifacts into ${DIST}`);
console.log(`author A pubkey: ${keys.A.pub}`);
console.log(`author B pubkey: ${keys.B.pub}`);
