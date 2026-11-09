import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { masterKeyOk, startServer } from '../src/server.js';

const ADMIN = 'test-admin-token';
const CRON = 'test-cron-secret';
const TG_TOKEN = '123456:SUPERSECRETTOKEN';

function masterKey() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-api-'));
}

async function boot(dir, extra = {}) {
  return startServer({
    dataDir: dir,
    port: 0,
    hostname: '127.0.0.1',
    cron: false,
    catchup: false,
    env: {
      MASTER_KEY: extra.MASTER_KEY || masterKey(),
      ADMIN_TOKEN: extra.ADMIN_TOKEN ?? ADMIN,
      CRON_SECRET: extra.CRON_SECRET ?? CRON,
      TG_BOT_TOKEN: '',
      TG_CHAT_ID: '',
      QQ_APP_ID: '',
      QQ_APP_SECRET: '',
      QQ_OPENID: '',
      QQ_SANDBOX: '',
      QODER_MACHINE_TOKEN: '',
      QODER_MACHINE_CODE: '',
      QODER_MACHINE_TYPE: '',
      ...extra,
    },
  });
}

async function api(base, urlPath, { token = ADMIN, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: {
      'X-Admin-Token': token,
      ...(body != null ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { res, data, text };
}

function b64decode(str) {
  const bin = atob(String(str).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function openSealed(masterB64, packed, info) {
  const box = JSON.parse(packed);
  const master = b64decode(masterB64);
  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: b64decode(box.s), info: new TextEncoder().encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(box.i) }, key, b64decode(box.d));
  return JSON.parse(new TextDecoder().decode(pt));
}

function readKv(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare('SELECT key, value FROM kv ORDER BY key').all();
  db.close();
  return rows;
}

test('masterKeyOk 只接受 32 字节', () => {
  assert.equal(masterKeyOk(masterKey()), true);
  assert.equal(masterKeyOk(Buffer.from('short').toString('base64')), false);
  assert.equal(masterKeyOk('@@@'), false);
});

test('控制台、健康检查、三个平台前缀和管理接口', async () => {
  const dir = tempDir();
  const key = masterKey();
  const app = await boot(dir, { MASTER_KEY: key });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const home = await fetch(base + '/');
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(html, /签到控制台/);
    assert.match(html, /Trae/);
    assert.match(html, /WorkBuddy/);
    assert.match(html, /Qoder/);
    assert.match(html, /fnos-2026-11-09-sched/);
    assert.match(html, /id="schOpen"/);
    assert.match(html, /设备通行证/);
    assert.match(html, /添加账号（国际版）/);
    assert.match(html, /tgApiBase/);

    const health = await (await fetch(base + '/health')).json();
    assert.equal(health.ok, true);
    assert.equal(health.ready, true);
    assert.equal(health.storage, 'sqlite');
    assert.equal(health.timezone, 'Asia/Shanghai');
    assert.equal(health.cron.enabled, false);
    assert.equal(health.cron.slots.length, 2);
    assert.equal(health.cron.slots[0].time, '08:10');
    assert.equal(health.cron.slots[1].time, '10:20');

    const noAuth = await api(base, '/api/ping', { token: '' });
    assert.equal(noAuth.res.status, 401);
    const bad = await api(base, '/api/ping', { token: 'nope' });
    assert.equal(bad.res.status, 401);
    const ping = await api(base, '/api/ping');
    assert.equal(ping.res.status, 200);
    assert.equal(ping.data.ok, true);

    const bearer = await fetch(base + '/api/ping', { headers: { Authorization: 'Bearer ' + ADMIN } });
    assert.equal(bearer.status, 200);

    for (const prefix of ['/trae/api/list', '/wb/api/list', '/qoder/api/list']) {
      const listed = await api(base, prefix);
      assert.equal(listed.res.status, 200, prefix);
      assert.equal(listed.data.count, 0);
      assert.ok(Array.isArray(listed.data.accounts));
    }

    const cronDenied = await fetch(base + '/cron', { method: 'POST' });
    assert.equal(cronDenied.status, 401);
    const cron = await fetch(base + '/cron', { method: 'POST', headers: { 'X-Cron-Secret': CRON } });
    const cronBody = await cron.json();
    assert.equal(cron.status, 200);
    assert.ok(cronBody.at.includes('+08:00'));
    assert.equal(cronBody.trae.accounts, 0);
    assert.equal(cronBody.wb.accounts, 0);
    assert.equal(cronBody.qoder.count, 0);

    const cronQuery = await fetch(base + '/cron?key=' + encodeURIComponent(CRON), { method: 'POST' });
    assert.equal(cronQuery.status, 200);

    const runAll = await api(base, '/api/run-all?force=1', { method: 'POST', body: {} });
    assert.equal(runAll.res.status, 200);
    assert.ok(runAll.data.trae && runAll.data.wb && runAll.data.qoder);

    const probe = await fetch(base + '/oauth/probe');
    assert.equal(probe.status, 200);
    assert.equal(await probe.text(), 'ok');
    const callback = await fetch(base + '/oauth/callback');
    assert.equal(callback.status, 200);

    const helper = await fetch(base + '/qq/openid-helper.mjs');
    assert.equal(helper.status, 200);
    assert.match(await helper.text(), /WebSocket/);

    const missing = await api(base, '/no-such');
    assert.equal(missing.res.status, 404);

    const claim = await api(base, '/trae/api/login/claim', {
      method: 'POST',
      body: { url: 'http://127.0.0.1:17388/authorize?foo=1' },
    });
    assert.equal(claim.res.status, 400);
    assert.match(claim.data.error, /authCodeInfo/);

    const traeLogin = await api(base, '/trae/api/login/start', { method: 'POST', body: {} });
    assert.equal(traeLogin.res.status, 200);
    assert.ok(traeLogin.data.trace);
    assert.match(traeLogin.data.authUrl, /trae\.cn/);

    const qoderLogin = await api(base, '/qoder/api/login/start', { method: 'POST', body: {} });
    assert.equal(qoderLogin.res.status, 200);
    assert.equal(qoderLogin.data.region, 'cn');
    assert.match(qoderLogin.data.authUrl, /^https:\/\/qoder\.com\.cn\/device\/selectAccounts\?/);
    assert.equal(qoderLogin.data.authUrl.includes('client_id='), false);

    const qoderGlobal = await api(base, '/qoder/api/login/start', { method: 'POST', body: { region: 'global' } });
    assert.equal(qoderGlobal.res.status, 200);
    assert.equal(qoderGlobal.data.region, 'global');
    assert.equal(qoderGlobal.data.regionName, '国际版');
    const globalUrl = new URL(qoderGlobal.data.authUrl);
    assert.equal(globalUrl.hostname, 'qoder.com');
    assert.equal(globalUrl.pathname, '/device/selectAccounts');
    assert.equal(globalUrl.searchParams.get('client_id'), 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb');
    assert.equal(globalUrl.searchParams.get('redirect_uri'), null);
    assert.equal(globalUrl.searchParams.has('machine_id'), true);

    const saved = await api(base, '/api/notify', {
      method: 'POST',
      body: {
        telegram: { enabled: true, token: TG_TOKEN, chatId: '998877' },
        qq: { enabled: false, appId: '', secret: '', openid: '', sandbox: false },
      },
    });
    assert.equal(saved.res.status, 200);

    const view = await api(base, '/api/notify');
    assert.equal(view.data.telegram.token, TG_TOKEN);
    assert.equal(view.data.telegram.chatId, '998877');
  } finally {
    await app.close();
  }

  const rows = readKv(path.join(dir, 'checkin.sqlite'));
  const notify = rows.find((row) => row.key === 'notify:config');
  assert.ok(notify, '通知配置应该落盘');
  assert.equal(notify.value.includes(TG_TOKEN), false);
  assert.match(notify.value, /"v":1/);
  const opened = await openSealed(key, notify.value, 'notify/v1/config');
  assert.equal(opened.telegram.token, TG_TOKEN);

  const traeSession = rows.find((row) => row.key.startsWith('trae:login:') && row.key !== 'trae:login:latest');
  assert.ok(traeSession);
  assert.equal(traeSession.value.includes('BEGIN PRIVATE KEY'), false);
  const session = await openSealed(key, traeSession.value, 'trae-signin/v1/account');
  assert.match(session.privateKeyPem, /BEGIN PRIVATE KEY/);

  const qoderSessions = [];
  for (const row of rows) {
    if (!row.key.startsWith('qoder:login:')) continue;
    qoderSessions.push(await openSealed(key, row.value, 'qoder-signin/v1/account'));
  }
  assert.ok(qoderSessions.some((sess) => sess.region === 'cn' && sess.verifier));
  assert.ok(qoderSessions.some((sess) => sess.region === 'global' && sess.verifier));

  const again = await boot(dir, { MASTER_KEY: key });
  const base2 = `http://127.0.0.1:${again.port}`;
  try {
    const poll = await api(base2, '/trae/api/login/poll?trace=' + encodeURIComponent(session.trace));
    assert.equal(poll.res.status, 200);
    assert.equal(poll.data.status, 'pending');
    const notifyAgain = await api(base2, '/api/notify');
    assert.equal(notifyAgain.data.telegram.token, TG_TOKEN);
    const lists = await api(base2, '/wb/api/list');
    assert.equal(lists.data.count, 0);
  } finally {
    await again.close();
  }
});

test('MASTER_KEY 长度不对时加密会失败，而不是把明文写进去', async () => {
  const dir = tempDir();
  const app = await boot(dir, { MASTER_KEY: Buffer.from('not-32-bytes').toString('base64') });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const started = await api(base, '/trae/api/login/start', { method: 'POST', body: {} });
    assert.equal(started.res.status, 500);
    assert.match(started.data.error, /32 字节/);
  } finally {
    await app.close();
  }
});

test('Telegram API 地址留空走官方，填了就改到反代根路径', async () => {
  const dir = tempDir();
  const app = await boot(dir);
  const base = `http://127.0.0.1:${app.port}`;
  const origFetch = globalThis.fetch;
  const hits = [];
  globalThis.fetch = async (url, opts) => {
    const target = String(url);
    if (target.includes('/bot')) {
      hits.push(target);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return origFetch(url, opts);
  };
  try {
    const saved = await api(base, '/api/notify', {
      method: 'POST',
      body: {
        telegram: { enabled: true, token: TG_TOKEN, chatId: '998877', apiBase: 'https://user-proxy.example/tg/' },
        qq: { enabled: false, appId: '', secret: '', openid: '' },
      },
    });
    assert.equal(saved.res.status, 200);
    const view = await api(base, '/api/notify');
    assert.equal(view.data.telegram.apiBase, 'https://user-proxy.example/tg');

    const sent = await api(base, '/api/notify/test', { method: 'POST', body: {} });
    assert.equal(sent.res.status, 200);
    assert.equal(hits.length, 1);
    assert.equal(hits[0], 'https://user-proxy.example/tg/bot' + TG_TOKEN + '/sendMessage');

    const cleared = await api(base, '/api/notify', {
      method: 'POST',
      body: {
        telegram: { enabled: true, token: TG_TOKEN, chatId: '998877', apiBase: '' },
        qq: { enabled: false, appId: '', secret: '', openid: '' },
      },
    });
    assert.equal(cleared.res.status, 200);
    hits.length = 0;
    const official = await api(base, '/api/notify/test', { method: 'POST', body: {} });
    assert.equal(official.res.status, 200);
    assert.equal(hits[0], 'https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage');

    const bad = await api(base, '/api/notify', {
      method: 'POST',
      body: {
        telegram: { enabled: true, token: TG_TOKEN, chatId: '998877', apiBase: 'ftp://files.example/tg' },
        qq: { enabled: false },
      },
    });
    assert.equal(bad.res.status, 400);
    assert.match(bad.data.error, /http/);
  } finally {
    globalThis.fetch = origFetch;
    await app.close();
  }
});

test('没配 ADMIN_TOKEN 时接口说明原因', async () => {
  const dir = tempDir();
  const app = await boot(dir, { ADMIN_TOKEN: '', CRON_SECRET: '' });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const ping = await api(base, '/api/ping', { token: 'x' });
    assert.equal(ping.res.status, 500);
    assert.match(ping.data.error, /ADMIN_TOKEN/);
    const cron = await fetch(base + '/cron', { method: 'POST' });
    const body = await cron.json();
    assert.equal(cron.status, 500);
    assert.match(body.error, /CRON_SECRET/);
  } finally {
    await app.close();
  }
});
