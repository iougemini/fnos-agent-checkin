import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openStore } from '../src/kv.js';
import { startServer } from '../src/server.js';

function masterKey() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
}

async function sealAccount(masterB64, obj) {
  const enc = new TextEncoder();
  const master = Buffer.from(masterB64, 'base64');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('qoder-signin/v1/account') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  const b64 = (buf) => Buffer.from(new Uint8Array(buf)).toString('base64');
  return JSON.stringify({ v: 1, s: b64(salt), i: b64(iv), d: b64(ct) });
}

test('国际版没通行证只看到营销卡；保存 runtime-info 后才去领 CLAIM_BENEFIT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-intl-'));
  const key = masterKey();
  const acct = {
    id: 'intl01',
    label: 'Intl',
    region: 'global',
    accessToken: 'device-token',
    refreshToken: 'refresh-token',
    userId: 'user-1',
    machineId: 'random-login-machine',
    createdAt: Date.now(),
    lastState: 'new',
    lastMsg: '',
    totalCredit: 0,
    totalSigned: 0,
    cooldownUntil: 0,
  };
  const store = openStore(dir);
  await store.kv.put('qoder:index:accounts', JSON.stringify([{ id: acct.id, label: acct.label, createdAt: acct.createdAt }]));
  await store.kv.put('qoder:acct:' + acct.id, await sealAccount(key, acct));
  store.close();

  const app = await startServer({
    dataDir: dir,
    port: 0,
    hostname: '127.0.0.1',
    cron: false,
    catchup: false,
    env: {
      MASTER_KEY: key,
      ADMIN_TOKEN: 'admin',
      CRON_SECRET: 'cron',
      TG_BOT_TOKEN: '',
      TG_CHAT_ID: '',
      TG_API_BASE: '',
      QQ_APP_ID: '',
      QQ_APP_SECRET: '',
      QQ_OPENID: '',
      QQ_SANDBOX: '',
      QODER_MACHINE_TOKEN: '',
      QODER_MACHINE_CODE: '',
      QODER_MACHINE_TYPE: '',
    },
  });
  const base = `http://127.0.0.1:${app.port}`;
  const origFetch = globalThis.fetch;
  const calls = [];
  let benefit = false;
  globalThis.fetch = async (url, opts = {}) => {
    const target = String(url);
    if (target.startsWith(base)) return origFetch(url, opts);
    calls.push({ url: target, headers: opts.headers || {}, body: opts.body });
    if (target.includes('/claim')) {
      return new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const campaigns = benefit
      ? [
          { actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED', title: '营销' },
          { campaignId: 'daily-1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 }, title: '每天领 100 Credits' },
        ]
      : [{ actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED', title: '营销' }];
    return new Response(JSON.stringify({ campaigns }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const run = () => origFetch(base + '/qoder/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Admin-Token': 'admin' },
    body: '{}',
  }).then((r) => r.json());

  try {
    const first = await run();
    assert.match(first.results[0].msg, /设备通行证/);
    assert.equal(first.results[0].state, 'wait');
    assert.equal(calls[0].headers['cosy-machinetoken'], undefined);
    assert.equal(calls[0].headers['cosy-machineid'], 'random-login-machine');

    const saved = await origFetch(base + '/qoder/api/device', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Admin-Token': 'admin' },
      body: JSON.stringify({
        id: 'intl01',
        text: JSON.stringify({ machineToken: 'P1gA-real-token', machineCode: 'code-1', machineType: '3' }),
      }),
    });
    assert.equal(saved.status, 200);

    calls.length = 0;
    const second = await run();
    assert.match(second.results[0].msg, /已带上设备通行证/);
    assert.equal(second.results[0].state, 'wait');
    assert.equal(calls[0].headers['cosy-machinetoken'], 'P1gA-real-token');
    assert.equal(calls[0].headers['cosy-machinetype'], '3');
    assert.equal(calls[0].headers['cosy-machinecode'], 'code-1');
    assert.equal(calls[0].headers['cosy-machineid'], undefined);
    assert.equal(calls[0].url.includes('openapi.qoder.sh'), true);

    benefit = true;
    calls.length = 0;
    const third = await run();
    assert.equal(third.results[0].state, 'checked');
    assert.match(third.results[0].msg, /\+100/);
    const claim = calls.find((c) => c.url.includes('/claim'));
    assert.ok(claim);
    assert.equal(claim.url.includes('/campaigns/daily-1/claim'), true);
    assert.equal(claim.body, '');
    assert.equal(claim.headers['cosy-machinetoken'], 'P1gA-real-token');
  } finally {
    globalThis.fetch = origFetch;
    await app.close();
  }
});
