/**
 * 替代 Cloudflare Cron Triggers。
 * 原文档的两轮（UTC 00:10 与 02:20）换成北京时间 08:10 与 10:20。
 * 每轮调用方传入的 run() 应等价于 POST /cron（不强制、跑完可通知）。
 * 当天某轮已经成功过会记在 meta 里；容器重启后只补跑还没成功的轮次。
 */
import cron from 'node-cron';

export const TIMEZONE = 'Asia/Shanghai';

export const DEFAULT_TIMES = ['08:10', '10:20'];

/** 把 ['08:10', '10:20'] 变成 node-cron 用的时间点。时间应已是合法的 HH:MM。 */
export function slotsFromTimes(times) {
  const list = Array.isArray(times) && times.length ? times : DEFAULT_TIMES;
  return list.map((label) => {
    const [hour, minute] = String(label).split(':').map(Number);
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    const text = hh + ':' + mm;
    return {
      id: hh + mm,
      label: text,
      cron: minute + ' ' + hour + ' * * *',
      minuteOfDay: hour * 60 + minute,
    };
  });
}

export const SLOTS = slotsFromTimes(DEFAULT_TIMES);

export function beijingNow(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const bag = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  const minute = Number(bag.minute);
  return {
    day: `${bag.year}-${String(bag.month).padStart(2, '0')}-${String(bag.day).padStart(2, '0')}`,
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
  };
}

export function slotKey(slotId, day) {
  return `cron:${slotId}:${day}`;
}

/** 定时触发后的随机等待。默认 0–900 秒（最多晚 15 分钟）。启动补跑和手动请求不用它。 */
export const DEFAULT_JITTER_MIN_SEC = 0;
export const DEFAULT_JITTER_MAX_SEC = 900;

function normalizeJitterSec(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function jitterBounds(minRaw, maxRaw) {
  let min = normalizeJitterSec(minRaw, DEFAULT_JITTER_MIN_SEC);
  let max = normalizeJitterSec(maxRaw, DEFAULT_JITTER_MAX_SEC);
  if (min > max) {
    const swap = min;
    min = max;
    max = swap;
  }
  return { min, max };
}

/** 含两端。random 返回 [0, 1)。 */
export function pickJitterSeconds(min, max, random = Math.random) {
  if (max <= min) return min;
  const span = max - min + 1;
  return min + Math.floor(random() * span);
}

function defaultSchedule(expr, fn, opts) {
  if (typeof cron.schedule !== 'function') {
    throw new Error('node-cron 没有 schedule');
  }
  return cron.schedule(expr, fn, opts);
}

export function createScheduler({
  store,
  run,
  enabled = true,
  catchup = true,
  schedule = defaultSchedule,
  now = beijingNow,
  jitterMinSec,
  jitterMaxSec,
  slots,
  random = Math.random,
  sleep,
}) {
  let tasks = [];
  const waits = new Set();
  let stopped = false;
  let chain = Promise.resolve();
  const state = {
    enabled: !!enabled,
    catchup: !!catchup,
    slots: Array.isArray(slots) && slots.length ? slots : SLOTS,
    bounds: jitterBounds(jitterMinSec, jitterMaxSec),
  };

  function defaultSleep(ms) {
    if (stopped) return Promise.resolve(false);
    if (ms <= 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const entry = {
        timer: null,
        resolve,
      };
      entry.timer = setTimeout(() => {
        waits.delete(entry);
        resolve(!stopped);
      }, ms);
      waits.add(entry);
    });
  }

  const wait = sleep || defaultSleep;

  function enqueue(slot, reason) {
    const job = chain.then(() => runSlot(slot, reason));
    chain = job.then(
      () => {},
      () => {}
    );
    return job;
  }

  function alreadyRan(slot) {
    const clock = now();
    const key = slotKey(slot.id, clock.day);
    const prev = store.getMeta(key);
    return { key, done: !!(prev && prev.startsWith('ok')) };
  }

  async function runSlot(slot, reason) {
    const first = alreadyRan(slot);
    if (first.done) {
      console.log(`[cron] ${slot.label} 今天已经跑过，跳过（${reason}）`);
      return { skipped: true, slot: slot.id };
    }
    let delaySec = 0;
    if (reason === '定时') {
      delaySec = pickJitterSeconds(state.bounds.min, state.bounds.max, random);
      console.log(
        `[cron] ${slot.label} 抽到延迟 ${delaySec} 秒（范围 ${state.bounds.min}–${state.bounds.max} 秒），到点后再签到`
      );
      if (delaySec > 0) {
        const finished = await wait(delaySec * 1000);
        if (finished === false || stopped) {
          console.log(`[cron] ${slot.label} 等待被中断，这次不签到`);
          return { skipped: true, slot: slot.id, interrupted: true };
        }
      }
      const again = alreadyRan(slot);
      if (again.done) {
        console.log(`[cron] ${slot.label} 等待期间今天已经跑过，跳过`);
        return { skipped: true, slot: slot.id };
      }
    }
    console.log(`[cron] 开始 ${slot.label}（${reason}）`);
    try {
      const ok = await run(slot, reason);
      if (ok) {
        const clock = now();
        store.setMeta(slotKey(slot.id, clock.day), `ok ${new Date().toISOString()}`);
        console.log(`[cron] ${slot.label} 完成`);
        return { ok: true, slot: slot.id, delaySec };
      }
      console.error(`[cron] ${slot.label} 未成功，下次启动或到点会再试`);
      return { ok: false, slot: slot.id };
    } catch (err) {
      console.error(`[cron] ${slot.label} 失败：`, err && err.stack ? err.stack : err);
      return { ok: false, slot: slot.id, error: String(err && err.message ? err.message : err) };
    }
  }

  function clearTasks() {
    for (const task of tasks) {
      if (task && typeof task.stop === 'function') task.stop();
    }
    tasks = [];
  }

  function apply(next, { catchupNow, via }) {
    clearTasks();
    state.enabled = !!next.enabled;
    state.catchup = !!next.catchup;
    state.slots = next.slots;
    state.bounds = next.bounds;
    if (!state.enabled) {
      console.log(via === 'reload' ? '[cron] 控制台已关闭定时签到' : '[cron] 已关闭（CRON_ENABLED=0）');
      return;
    }
    for (const slot of state.slots) {
      const task = schedule(
        slot.cron,
        () => {
          enqueue(slot, '定时');
        },
        { timezone: TIMEZONE }
      );
      tasks.push(task);
    }
    const labels = state.slots.map((slot) => slot.label).join('、');
    const verb = via === 'reload' ? '已按控制台重新挂上定时' : '已设定';
    console.log(
      `[cron] ${verb}：Asia/Shanghai 每天 ${labels}，触发后再随机等 ${state.bounds.min}–${state.bounds.max} 秒。启动补跑和手动请求不等待`
    );
    if (catchupNow && state.catchup) {
      const clock = now();
      for (const slot of state.slots) {
        if (clock.minuteOfDay >= slot.minuteOfDay) enqueue(slot, '启动补跑');
      }
    }
  }

  apply(state, { catchupNow: state.catchup, via: 'start' });

  return {
    enqueue,
    whenIdle: () => chain,
    get jitter() {
      return state.bounds;
    },
    status() {
      return {
        enabled: state.enabled,
        catchup: state.catchup,
        jitterMinSec: state.bounds.min,
        jitterMaxSec: state.bounds.max,
        slots: state.slots.map((slot) => ({ ...slot })),
      };
    },
    reload(config) {
      const nextSlots = slotsFromTimes(config.times);
      const nextBounds = jitterBounds(config.jitterMinSec, config.jitterMaxSec);
      apply(
        {
          enabled: config.enabled !== false,
          catchup: config.catchup !== false,
          slots: nextSlots,
          bounds: nextBounds,
        },
        { catchupNow: config.enabled !== false && config.catchup !== false, via: 'reload' }
      );
      return this.status();
    },
    stop() {
      stopped = true;
      for (const entry of waits) {
        clearTimeout(entry.timer);
        entry.resolve(false);
      }
      waits.clear();
      clearTasks();
    },
  };
}
