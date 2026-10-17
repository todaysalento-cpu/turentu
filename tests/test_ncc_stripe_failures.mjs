// TURENTU NCC V2 — test deterministic Stripe failure injection
// Save as tests/test_ncc_stripe_failures.mjs
// Runs an isolated, temporary COPY of the worker. No Stripe requests, no DB writes.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';

const root = process.cwd();
const worker = resolve(root, 'services/payments/ncc.reconciliation.mjs');
const temp = join(dirname(worker), `ncc.reconciliation.failure-test.${process.pid}.mjs`);
const original = await readFile(worker, 'utf8');
const needle = "const stripe = new Stripe(secret, { timeout: 10000, maxNetworkRetries: 1 });";
if (original.split(needle).length !== 2) {
  throw new Error('STOP: worker V2 differs from expected version; no injection performed');
}
if (!original.includes("const apply = process.env.NCC_RECONCILE_APPLY === 'YES_TEST_ONLY';")) {
  throw new Error('STOP: apply guard not found');
}
if (!original.includes("c.origine_address LIKE 'TURENTU_NCC_STRIPE_TEST_%'")) {
  throw new Error('STOP: TEST ride filter not found');
}
const modes = [
  ['NETWORK_ERROR', "const stripe = { paymentIntents: { retrieve: async () => { const e = new Error('SIMULATED_STRIPE_NETWORK_ERROR'); e.code = 'SIMULATED_NETWORK'; throw e; } } };"],
  ['TIMEOUT', "const stripe = { paymentIntents: { retrieve: async () => { await new Promise(r => setTimeout(r, 150)); const e = new Error('SIMULATED_STRIPE_TIMEOUT'); e.code = 'SIMULATED_TIMEOUT'; throw e; } } };"],
];
try {
  for (const [mode, mock] of modes) {
    await writeFile(temp, original.replace(needle, mock), { flag: 'w' });
    console.log(`\n=== ${mode} (isolated READ ONLY copy) ===`);
    const result = spawnSync(process.execPath, ['--env-file=.env', temp], {
      cwd: root,
      env: { ...process.env, NCC_RECONCILE_APPLY: '' },
      encoding: 'utf8',
      timeout: 30000,
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) throw result.error;
    const summaries = [...(result.stdout || '').matchAll(/\{"ts":"[^"]+","event":"SUMMARY",([^\n]+)\}/g)];
    if (summaries.length !== 1) throw new Error(`${mode}: missing SUMMARY`);
    const summary = JSON.parse(`{${summaries[0][1]}}`);
    if (summary.scanned < 1 || summary.alerts !== summary.scanned || summary.repaired !== 0 || summary.matched !== 0) {
      throw new Error(`${mode}: unexpected summary ${JSON.stringify(summary)} (expected eligible TEST candidates)`);
    }
    if (result.status !== 1) throw new Error(`${mode}: expected exit code 1 due to alerts; got ${result.status}`);
    console.log(`PASS ${mode}: alerts=${summary.alerts}, DB updates=0, exit code=1`);
  }
  console.log('\nPASS: both simulated Stripe failure scenarios.');
  console.log('NEXT: run original worker READ ONLY to verify advisory lock released.');
} finally {
  await unlink(temp).catch(() => {});
}
