/**
 * 控制台里的定时签到配置。
 * 没在数据库保存过时，用环境变量的开关和抖动，时间点用默认的 08:10 / 10:20。
 */
import { jitterBounds } from './scheduler.js';

export const DEFAULT_TIMES = ['08:10', '10:20'];
export const MAX_SCHEDULE_SLOTS = 8;
export const SCHEDULE_KV_KEY = 'cron:config';

function flag(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return !/^(0|false|no|off)$/i.test(String(value));
}

/** 校验并规范化 HH:MM 列表。成功时按时间排序。 */
export function normalizeTimes(times) {
  if (!Array.isArray(times) || times.length === 0) {
    return { ok: false, error: '至少保留一个签到时间' };
  }
  if (times.length > MAX_SCHEDULE_SLOTS) {
    return { ok: false, error: '最多 ' + MAX_SCHEDULE_SLOTS + ' 个签到时间' };
  }
  const out = [];
  const seen = new Set();
  for (const raw of times) {
    const text = String(raw ?? '').trim();
    const match = text.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return { ok: false, error: '时间格式应为 HH:MM，例如 08:10' };
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return { ok: false, error: '时间超出范围：' + text };
    const label = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
    if (seen.has(label)) return { ok: false, error: '时间重复：' + label };
    seen.add(label);
    out.push(label);
  }
  out.sort();
  return { ok: true, times: out };
}

export function normalizeScheduleConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '配置格式不对' };
  }
  const times = normalizeTimes(input.times);
  if (!times.ok) return times;
  const jitter = jitterBounds(input.jitterMinSec, input.jitterMaxSec);
  return {
    ok: true,
    config: {
      enabled: flag(input.enabled, true),
      catchup: flag(input.catchup, true),
      times: times.times,
      jitterMinSec: jitter.min,
      jitterMaxSec: jitter.max,
    },
  };
}

/** 数据库里还没有配置时用的默认值。options 优先于环境变量，方便测试关掉定时。 */
export function defaultScheduleConfig(env = {}, options = {}) {
  const jitter = jitterBounds(
    options.jitterMinSec ?? env.CRON_JITTER_MIN_SEC,
    options.jitterMaxSec ?? env.CRON_JITTER_MAX_SEC,
  );
  return {
    enabled: options.cron != null ? !!options.cron : flag(env.CRON_ENABLED, true),
    catchup: options.catchup != null ? !!options.catchup : flag(env.CRON_CATCHUP, true),
    times: DEFAULT_TIMES.slice(),
    jitterMinSec: jitter.min,
    jitterMaxSec: jitter.max,
  };
}

export async function loadScheduleConfig(kv, env, options) {
  const fallback = defaultScheduleConfig(env, options);
  let raw = null;
  try {
    raw = await kv.get(SCHEDULE_KV_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return { config: fallback, fromEnv: true };
  try {
    const parsed = normalizeScheduleConfig(JSON.parse(raw));
    if (!parsed.ok) return { config: fallback, fromEnv: true };
    return { config: parsed.config, fromEnv: false };
  } catch {
    return { config: fallback, fromEnv: true };
  }
}

export async function saveScheduleConfig(kv, config) {
  await kv.put(SCHEDULE_KV_KEY, JSON.stringify(config));
}
