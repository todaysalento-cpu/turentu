/** TURENTU POPBUS HTTP smoke — sola lettura, nessun worker e nessuna scrittura. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'segreto-di-test') {
    throw new Error('JWT_SECRET deve essere definito e diverso dal fallback di test');
  }
  process.env.POPBUS_AR_FINALIZATION_ENABLED = 'false';
  process.env.POPBUS_PIXEL_FIRST_ENABLED = 'false';
  process.env.POPBUS_RECON_WORKER_ENABLED = 'NO';
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { popbusRouter } = await import(pathToFileURL(path.resolve('routes/popbus.routes.js')).href);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/popbus', popbusRouter);
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1');
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(id, token) {
    const response = await fetch(`${base}/api/popbus/${id}/accetta`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? {authorization:`Bearer ${token}`} : {}) },
      body: '{}'
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    const unauth = await post('1');
    assert.equal(unauth.status, 401, JSON.stringify(unauth));
    console.log('PASS: senza token -> 401');
    const badToken = await post('1', 'non.un.jwt');
    assert.equal(badToken.status, 401, JSON.stringify(badToken));
    console.log('PASS: token invalido -> 401');
    const token = jwt.sign({ id: 2, role: 'autista' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const badId = await post('not-an-id', token);
    assert.equal(badId.status, 400, JSON.stringify(badId));
    console.log('PASS: identificativo offerta invalido -> 400');
    if (process.env.TURENTU_HTTP_SMOKE_READ_DB === 'YES') {
      // ID negativo non passa la validazione. ID positivo improbabile: sola SELECT.
      const missing = await post('2147483647', token);
      assert.equal(missing.status, 404, JSON.stringify(missing));
      console.log('PASS: offerta inesistente -> 404');
    } else {
      console.log('SKIP: test 404 DB (abilita con TURENTU_HTTP_SMOKE_READ_DB=YES)');
    }
    console.log('PASS: HTTP smoke non mutativo completato');
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}
main().catch(e => { console.error('FAIL:', e.stack || e); process.exitCode = 1; });
