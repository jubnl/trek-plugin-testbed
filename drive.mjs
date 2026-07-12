/**
 * Headless walk-through of every scenario against the REAL services, a REAL SQLite DB and
 * REAL artifact downloads from GitHub. Proves the testbed works — and that the feature does
 * — before anyone clicks anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DIR = import.meta.dirname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-drive-'));

process.env.TREK_DB_FILE = path.join(tmp, 'trek.db');
process.env.TREK_PLUGINS_DIR = path.join(tmp, 'code');
process.env.TREK_PLUGINS_DATA_DIR = path.join(tmp, 'data');
process.env.TREK_PLUGINS_ENABLED = 'true';
process.env.TREK_PLUGIN_REGISTRY_URL = 'http://localhost:8788/index.json';
process.env.NODE_ENV = 'production';

// Must run as:  cd server && node --require tsconfig-paths/register <this file>
// tsconfig-paths is what resolves the MCP SDK's unresolvable exports map — same as `npm start`.
const require = createRequire('/home/jubnl/dev/TREK/server/index.js');
const S = '/home/jubnl/dev/TREK/server/dist';
require(`${S}/db/database.js`);
const { PluginRegistryService, __clearRegistryCacheForTests } = require(`${S}/nest/plugins/registry/registry.service.js`);
const { PluginsService } = require(`${S}/nest/plugins/plugins.service.js`);
const { PluginRuntimeService } = require(`${S}/nest/plugins/plugin-runtime.service.js`);

const registry = new PluginRegistryService();
const runtime = new PluginRuntimeService(registry);
const plugins = new PluginsService();

const setScenario = (s) => {
  fs.writeFileSync(path.join(DIR, 'scenario.txt'), `${s}\n`);
  __clearRegistryCacheForTests(); // what the "Rescan" button does
};
const row = (id) => plugins.list().plugins.find((p) => p.id === id);
const pass = [];
const fail = [];
const check = (label, got, want) => {
  const ok = got === want;
  (ok ? pass : fail).push(label);
  console.log(`  ${ok ? '✅' : '❌'} ${label}\n       got: ${got}${ok ? '' : `\n      want: ${want}`}`);
};
const codeOf = async (fn) => {
  try { await fn(); return 'OK'; } catch (e) { return e.code ?? `ERR(${e.message})`; }
};

console.log('\n═══ SCENARIO: base — install everything ═══');
setScenario('base');

check('sig-signed installs', await codeOf(() => registry.install('sig-signed')), 'OK');
check('  → badge state', `signed=${row('sig-signed').signed}`, 'signed=true');
check('  → fingerprint shown', row('sig-signed').keyFingerprint?.includes('…') ? 'yes' : 'no', 'yes');

check('sig-unsigned installs', await codeOf(() => registry.install('sig-unsigned')), 'OK');
check('  → badge state', `signed=${row('sig-unsigned').signed}`, 'signed=false');

check('sig-invalid REFUSED', await codeOf(() => registry.install('sig-invalid')), 'SIGNATURE_INVALID');
check('sig-incomplete REFUSED', await codeOf(() => registry.install('sig-incomplete')), 'SIGNATURE_INCOMPLETE');

check('sig-downgrade installs', await codeOf(() => registry.install('sig-downgrade')), 'OK');
check('sig-rotate installs (key A)', await codeOf(() => registry.install('sig-rotate')), 'OK');

console.log('\n═══ SCENARIO: downgrade — a signed plugin ships an unsigned update ═══');
setScenario('downgrade');
check('update REFUSED', await codeOf(() => runtime.update('sig-downgrade')), 'SIGNATURE_MISSING');
check('  → block recorded', row('sig-downgrade').updateBlock?.code, 'SIGNATURE_MISSING');
check('  → still on old version', row('sig-downgrade').version, '1.0.0');

console.log('\n═══ SCENARIO: rotate — author rotates key A → B ═══');
setScenario('rotate');
check('update REFUSED', await codeOf(() => runtime.update('sig-rotate')), 'SIGNATURE_KEY_CHANGED');
check('  → block recorded at the refused version', row('sig-rotate').updateBlock?.version, '2.0.0');
check('  → still pinned to A, still on v1', row('sig-rotate').version, '1.0.0');
check('  → plugin still healthy (NOT error)', row('sig-rotate').status !== 'error' ? 'healthy' : 'error', 'healthy');

console.log('\n─── D2: re-trust must refuse a NON-rotation ───');
const PUB = JSON.parse(fs.readFileSync(path.join(DIR, 'pubkeys.json'), 'utf8'));
// The real D2 case: sig-signed IS installed and healthy, its key never changed. There is
// nothing to re-trust, and calling the endpoint directly must not become a way to force an
// install. The UI hiding the button is a convenience — this is the control.
check(
  'retrust a plugin whose key did NOT change REFUSED',
  await codeOf(() => runtime.retrust('sig-signed', '1.0.0', PUB.A, { userId: 1 })),
  'RETRUST_NOT_APPLICABLE',
);
// And an INVALID signature is not overridable at all — it never installed, so there is not
// even a row to re-trust. Belt and braces: the server refuses on the condition, not the UI.
check(
  'retrust on sig-invalid (never installed) REFUSED',
  await codeOf(() => runtime.retrust('sig-invalid', '1.0.0', PUB.A, { userId: 1 })),
  'NOT_FOUND',
);
check(
  'retrust with the WRONG key (TOCTOU guard) REFUSED',
  await codeOf(() => runtime.retrust('sig-rotate', '2.0.0', PUB.A, { userId: 1 })),
  'RETRUST_KEY_MISMATCH',
);

console.log('\n─── D1: a blessed key must still SIGN the code ───');
setScenario('rotate-bad');
check(
  'retrust when the artifact does not verify under B REFUSED',
  await codeOf(() => runtime.retrust('sig-rotate', '2.0.0', PUB.B, { userId: 1 })),
  'SIGNATURE_INVALID',
);
check('  → old key A still pinned (never NULL)', row('sig-rotate').signed ? 'still pinned' : 'CLEARED!', 'still pinned');
check('  → still on v1', row('sig-rotate').version, '1.0.0');

console.log('\n─── the happy path: a genuine rotation, confirmed ───');
setScenario('rotate');
const fpBefore = row('sig-rotate').keyFingerprint;
check('retrust ACCEPTED', await codeOf(() => runtime.retrust('sig-rotate', '2.0.0', PUB.B, { userId: 1 })), 'OK');
check('  → moved to the new version', row('sig-rotate').version, '2.0.0');
check('  → re-pinned to a DIFFERENT key', row('sig-rotate').keyFingerprint !== fpBefore ? 'rotated' : 'unchanged', 'rotated');
check('  → still signed (never NULL)', `signed=${row('sig-rotate').signed}`, 'signed=true');
check('  → block cleared', String(row('sig-rotate').updateBlock), 'null');

console.log('\n═══ SCENARIO: stale — a newer version supersedes the recorded block ═══');
setScenario('base');
await registry.install('sig-downgrade', { version: '1.0.0' }).catch(() => {});
setScenario('downgrade');
await runtime.update('sig-downgrade').catch(() => {}); // re-block at 2.0.0
check('blocked at', row('sig-downgrade').updateBlock?.version, '2.0.0');
const blocked = row('sig-downgrade');
// The client hides the block once the offered latest is NEWER than the refused version.
const isCurrent = (p, latest) => !p.updateBlock ? false : (!latest || !p.updateBlock.version) ? true : latest === p.updateBlock.version;
check('  → block shown while 2.0.0 is still on offer', String(isCurrent(blocked, '2.0.0')), 'true');
check('  → block goes quiet once 3.0.0 is offered', String(isCurrent(blocked, '3.0.0')), 'false');

console.log(`\n${'─'.repeat(60)}`);
console.log(`${pass.length} passed, ${fail.length} failed`);
if (fail.length) fail.forEach((f) => console.log(`  ❌ ${f}`));
fs.rmSync(tmp, { recursive: true, force: true });
// The runtime holds the event loop open (supervisor + schedulers) — nothing to wind down
// in a throwaway driver, so leave deliberately.
await runtime.onModuleDestroy?.().catch(() => {});
process.exit(fail.length ? 1 : 0);
