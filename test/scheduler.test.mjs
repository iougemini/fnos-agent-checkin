import assert from 'node:assert/strict';
import test from 'node:test';
import { beijingNow, createScheduler, jitterBounds, pickJitterSeconds, SLOTS } from '../src/scheduler.js';

function memoryStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getMeta: (key) => (map.has(key) ? map.get(key) : null),
    setMeta: (key, value) => map.set(key, String(value)),
    deleteMeta: (key) => map.delete(key),
  };
}

test('北京时间换算：UTC 00:10 是 08:10，UTC 02:20 是 10:20', () => {
  const morning = beijingNow(new Date(Date.UTC(2026, 10, 9, 0, 10)));
  assert.equal(morning.day, '2026-11-09');
  assert.equal(morning.hour, 8);
  assert.equal(morning.minute, 10);
  assert.equal(morning.minuteOfDay, SLOTS[0].minuteOfDay);

  const late = beijingNow(new Date(Date.UTC(2026, 10, 9, 2, 20)));
  assert.equal(late.hour, 10);
  assert.equal(late.minute, 20);
  assert.equal(late.minuteOfDay, SLOTS[1].minuteOfDay);

  const before = beijingNow(new Date(Date.UTC(2026, 10, 8, 23, 59)));
  assert.equal(before.day, '2026-11-09');
  assert.equal(before.hour, 7);
  assert.equal(before.minute, 59);
});

test('启动补跑只跑已经到点、且今天还没成功的轮次', async () => {
  const calls = [];
  const store = memoryStore({ 'cron:0810:2026-11-09': 'ok earlier' });
  const scheduler = createScheduler({
    store,
    enabled: true,
    catchup: true,
    schedule: () => ({ stop() {} }),
    now: () => ({ day: '2026-11-09', hour: 11, minute: 30, minuteOfDay: 11 * 60 + 30 }),
    run: async (slot) => {
      calls.push(slot.id);
      return true;
    },
  });
  await scheduler.whenIdle();
  assert.deepEqual(calls, ['1020']);
  assert.match(store.getMeta('cron:1020:2026-11-09'), /^ok /);
  scheduler.stop();
});

test('失败的一轮不会记成已完成，下次还能再跑', async () => {
  const store = memoryStore();
  const now = () => ({ day: '2026-11-09', hour: 8, minute: 10, minuteOfDay: 8 * 60 + 10 });
  const first = createScheduler({
    store,
    enabled: true,
    catchup: true,
    schedule: () => ({ stop() {} }),
    now,
    run: async () => false,
  });
  await first.whenIdle();
  first.stop();
  assert.equal(store.getMeta('cron:0810:2026-11-09'), null);

  const calls = [];
  const second = createScheduler({
    store,
    enabled: true,
    catchup: true,
    schedule: () => ({ stop() {} }),
    now,
    run: async (slot) => {
      calls.push(slot.id);
      return true;
    },
  });
  await second.whenIdle();
  second.stop();
  assert.deepEqual(calls, ['0810']);
});

test('抖动范围含两端，非法值退回 0–900', () => {
  assert.equal(pickJitterSeconds(0, 900, () => 0), 0);
  assert.equal(pickJitterSeconds(0, 900, () => 0.999), 900);
  assert.equal(pickJitterSeconds(5, 5, () => 0.2), 5);
  assert.deepEqual(jitterBounds(undefined, undefined), { min: 0, max: 900 });
  assert.deepEqual(jitterBounds('120', '30'), { min: 30, max: 120 });
  assert.deepEqual(jitterBounds('-1', 'nope'), { min: 0, max: 900 });
});

test('到点的定时会按抽到的秒数等待，启动补跑不进入等待', async () => {
  const sleeps = [];
  const calls = [];
  const scheduled = createScheduler({
    store: memoryStore(),
    enabled: true,
    catchup: false,
    jitterMinSec: 0,
    jitterMaxSec: 10,
    random: () => 0.99,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    schedule: (_expr, fn) => {
      fn();
      return { stop() {} };
    },
    now: () => ({ day: '2026-11-09', hour: 8, minute: 10, minuteOfDay: 8 * 60 + 10 }),
    run: async (slot, reason) => {
      calls.push(reason + ':' + slot.id);
      return true;
    },
  });
  await scheduled.whenIdle();
  scheduled.stop();
  assert.deepEqual(sleeps, [10000, 10000]);
  assert.deepEqual(calls, ['定时:0810', '定时:1020']);

  const catchupSleeps = [];
  const catchupCalls = [];
  const catchup = createScheduler({
    store: memoryStore(),
    enabled: true,
    catchup: true,
    jitterMinSec: 60,
    jitterMaxSec: 60,
    sleep: async (ms) => {
      catchupSleeps.push(ms);
    },
    schedule: () => ({ stop() {} }),
    now: () => ({ day: '2026-11-09', hour: 11, minute: 30, minuteOfDay: 11 * 60 + 30 }),
    run: async (slot, reason) => {
      catchupCalls.push(reason + ':' + slot.id);
      return true;
    },
  });
  await catchup.whenIdle();
  catchup.stop();
  assert.deepEqual(catchupSleeps, []);
  assert.deepEqual(catchupCalls, ['启动补跑:0810', '启动补跑:1020']);
});

test('reload 换掉旧的 cron 任务', async () => {
  const exprs = [];
  let stopped = 0;
  const calls = [];
  const scheduler = createScheduler({
    store: memoryStore(),
    enabled: true,
    catchup: false,
    schedule: (expr) => {
      exprs.push(expr);
      return { stop() { stopped += 1; } };
    },
    now: () => ({ day: '2026-11-09', hour: 7, minute: 0, minuteOfDay: 7 * 60 }),
    run: async (slot, reason) => {
      calls.push(reason + ':' + slot.id);
      return true;
    },
  });
  assert.deepEqual(exprs, ['10 8 * * *', '20 10 * * *']);
  scheduler.reload({
    enabled: true,
    catchup: true,
    times: ['09:30', '21:05'],
    jitterMinSec: 12,
    jitterMaxSec: 4,
  });
  await scheduler.whenIdle();
  assert.equal(stopped, 2);
  assert.deepEqual(exprs.slice(2), ['30 9 * * *', '5 21 * * *']);
  assert.equal(scheduler.status().jitterMinSec, 4);
  assert.equal(scheduler.status().jitterMaxSec, 12);
  assert.deepEqual(calls, []);
  assert.equal(scheduler.status().enabled, true);
  scheduler.reload({ enabled: false, catchup: true, times: ['09:30'], jitterMinSec: 0, jitterMaxSec: 0 });
  assert.equal(scheduler.status().enabled, false);
  assert.equal(exprs.length, 4);
  assert.equal(stopped, 4);
  scheduler.stop();
});

test('等待被中断时不签到', async () => {
  const calls = [];
  const scheduler = createScheduler({
    store: memoryStore(),
    enabled: true,
    catchup: false,
    jitterMinSec: 30,
    jitterMaxSec: 30,
    random: () => 0,
    schedule: (_expr, fn) => {
      fn();
      return { stop() {} };
    },
    now: () => ({ day: '2026-11-09', hour: 8, minute: 10, minuteOfDay: 8 * 60 + 10 }),
    run: async (slot) => {
      calls.push(slot.id);
      return true;
    },
  });
  scheduler.stop();
  await scheduler.whenIdle();
  assert.deepEqual(calls, []);
});

test('08:10 之前不补跑', async () => {
  const calls = [];
  const scheduler = createScheduler({
    store: memoryStore(),
    enabled: true,
    catchup: true,
    schedule: () => ({ stop() {} }),
    now: () => ({ day: '2026-11-09', hour: 7, minute: 0, minuteOfDay: 7 * 60 }),
    run: async (slot) => {
      calls.push(slot.id);
      return true;
    },
  });
  await scheduler.whenIdle();
  assert.deepEqual(calls, []);
  scheduler.stop();
});
