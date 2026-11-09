import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openStore } from '../src/kv.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-kv-'));
}

test('put/get/delete 与过期时间', async () => {
  const dir = tempDir();
  const store = openStore(dir);
  await store.kv.put('trae:index:accounts', '[]');
  assert.equal(await store.kv.get('trae:index:accounts'), '[]');

  await store.kv.put('trae:login:abc', 'secret', { expirationTtl: 1 });
  assert.equal(await store.kv.get('trae:login:abc'), 'secret');
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(await store.kv.get('trae:login:abc'), null);

  await store.kv.put('wb:acct:1', 'keep');
  await store.kv.delete('wb:acct:1');
  assert.equal(await store.kv.get('wb:acct:1'), null);
  store.close();
});

test('list 按前缀过滤，并在重启后仍能读到', async () => {
  const dir = tempDir();
  const first = openStore(dir);
  await first.kv.put('trae:acct:a', 'A');
  await first.kv.put('wb:acct:b', 'B');
  await first.kv.put('qoder:acct:c', 'C');
  const listed = await first.kv.list({ prefix: 'trae:' });
  assert.deepEqual(listed.keys.map((k) => k.name), ['trae:acct:a']);
  first.close();

  const second = openStore(dir);
  assert.equal(await second.kv.get('qoder:acct:c'), 'C');
  second.close();
});

test('meta 不进 kv 前缀', () => {
  const dir = tempDir();
  const store = openStore(dir);
  store.setMeta('cron:0810:2026-11-09', 'ok');
  assert.equal(store.getMeta('cron:0810:2026-11-09'), 'ok');
  store.deleteMeta('cron:0810:2026-11-09');
  assert.equal(store.getMeta('cron:0810:2026-11-09'), null);
  store.close();
});
