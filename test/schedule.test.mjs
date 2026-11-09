import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeScheduleConfig, normalizeTimes } from '../src/schedule-config.js';
import { slotsFromTimes } from '../src/scheduler.js';
import { startServer } from '../src/server.js';

test('时间点校验：格式、重复、上下限', () => {
  assert.deepEqual(normalizeTimes(['8:10', '10:20']).times, ['08:10', '10:20']);
  assert.equal(normalizeTimes([]).ok, false);
  assert.match(normalizeTimes(['25:00']).error, /超出范围/);
  assert.match(normalizeTimes(['08:10', '8:10']).error, /重复/);
  assert.match(normalizeTimes(Array.from({ length: 9 }, (_, i) => '08:' + String(i).padStart(2, '0'))).error, /最多/);
  const slots = slotsFromTimes(['09:05']);
  assert.equal(slots[0].cron, '5 9 * * *');
  assert.equal(slots[0].minuteOfDay, 9 * 60 + 5);
  const swapped = normalizeScheduleConfig({
    enabled: true,
    catchup: false,
    times: ['18:00', '09:05'],
    jitterMinSec: 20,
    jitterMaxSec: 5,
  });
  assert.equal(swapped.ok, true);
  assert.deepEqual(swapped.config.times, ['09:05', '18:00']);
  assert.equal(swapped.config.jitterMinSec, 5);
  assert.equal(swapped.config.jitterMaxSec, 20);
  assert.equal(swapped.config.catchup, false);
});

test('定时设置接口要登录，保存后热更新并在重启后还在', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-sch-'));
  const boot = () => startServer({
    dataDir: dir,
    port: 0,
    hostname: '127.0.0.1',
    cron: false,
    catchup: false,
    env: {
      MASTER_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
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
  const first = await boot();
  const base = `http://127.0.0.1:${first.port}`;
  const headers = { 'content-type': 'application/json', 'X-Admin-Token': 'admin' };
  try {
    const denied = await fetch(base + '/api/schedule');
    assert.equal(denied.status, 401);
    const initial = await fetch(base + '/api/schedule', { headers }).then((r) => r.json());
    assert.equal(initial.fromEnv, true);
    assert.deepEqual(initial.times, ['08:10', '10:20']);
    assert.equal(initial.enabled, false);

    const bad = await fetch(base + '/api/schedule', {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: true, catchup: false, times: ['08:10', '08:10'], jitterMinSec: 0, jitterMaxSec: 10 }),
    });
    assert.equal(bad.status, 400);

    const saved = await fetch(base + '/api/schedule', {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: true, catchup: false, times: ['23:50', '9:15'], jitterMinSec: 30, jitterMaxSec: 10 }),
    }).then((r) => r.json());
    assert.equal(saved.fromEnv, false);
    assert.deepEqual(saved.times, ['09:15', '23:50']);
    assert.equal(saved.jitterMinSec, 10);
    assert.equal(saved.jitterMaxSec, 30);
    assert.deepEqual(saved.slots.map((slot) => slot.time), ['09:15', '23:50']);

    const health = await fetch(base + '/health').then((r) => r.json());
    assert.equal(health.cron.enabled, true);
    assert.deepEqual(health.cron.slots.map((slot) => slot.time), ['09:15', '23:50']);
    assert.equal(health.cron.jitterMinSec, 10);
  } finally {
    await first.close();
  }

  const second = await boot();
  try {
    const again = await fetch(`http://127.0.0.1:${second.port}/api/schedule`, { headers }).then((r) => r.json());
    assert.equal(again.fromEnv, false);
    assert.deepEqual(again.times, ['09:15', '23:50']);
    assert.equal(again.enabled, true);
  } finally {
    await second.close();
  }
});
