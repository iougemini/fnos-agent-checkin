/**
 * Node 入口：Hono 接收 HTTP，把 Web Request 交给原来的 Worker fetch。
 * 存储是 SQLite（env.KV），定时是 Asia/Shanghai 的 node-cron。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import worker from './worker.js';
import { openStore } from './kv.js';
import { beijingNow, createScheduler, slotKey, slotsFromTimes } from './scheduler.js';
import { loadScheduleConfig, normalizeScheduleConfig, saveScheduleConfig } from './schedule-config.js';

const ENV_KEYS = [
  'MASTER_KEY',
  'ADMIN_TOKEN',
  'CRON_SECRET',
  'TG_BOT_TOKEN',
  'TG_CHAT_ID',
  'TG_API_BASE',
  'QQ_APP_ID',
  'QQ_APP_SECRET',
  'QQ_OPENID',
  'QQ_SANDBOX',
  'QODER_MACHINE_TOKEN',
  'QODER_MACHINE_CODE',
  'QODER_MACHINE_TYPE',
];

export function loadEnv(source = process.env) {
  const env = {};
  for (const key of ENV_KEYS) env[key] = String(source[key] || '').trim();
  return env;
}

export function masterKeyOk(raw) {
  try {
    const bin = atob(String(raw || '').trim().replace(/\s+/g, ''));
    return bin.length === 32;
  } catch {
    return false;
  }
}

function flagOn(value, fallback) {
  if (value == null || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value));
}

function warnConfig(env) {
  if (!env.MASTER_KEY) {
    console.warn('[config] 未设置 MASTER_KEY。控制台能打开，但账号无法加密保存。');
  } else if (!masterKeyOk(env.MASTER_KEY)) {
    console.warn('[config] MASTER_KEY 必须是 32 字节随机值的 base64（一般 44 字符、以 = 结尾）。');
  }
  if (!env.ADMIN_TOKEN) {
    console.warn('[config] 未设置 ADMIN_TOKEN。控制台无法登录。');
  }
  if (!env.CRON_SECRET) {
    console.log('[config] 未设置 CRON_SECRET，/cron 将回退使用 ADMIN_TOKEN。');
  }
}

function summarize(result) {
  if (!result || typeof result !== 'object') return '';
  const bits = [];
  for (const key of ['trae', 'wb', 'qoder']) {
    const part = result[key];
    if (!part) continue;
    if (part.error) {
      bits.push(`${key}=失败`);
      continue;
    }
    const n = part.accounts ?? part.count ?? (Array.isArray(part.results) ? part.results.length : 0);
    bits.push(`${key}=${n}`);
  }
  if (result.notifyError) bits.push('通知失败');
  return bits.join(' ');
}

export async function runScheduled(env, reason = 'manual') {
  return enqueueSignin(async () => {
    const pending = [];
    const ctx = {
      waitUntil(p) {
        pending.push(Promise.resolve(p));
      },
    };
    try {
      const result = await worker.scheduled(
        { cron: reason, scheduledTime: Date.now(), origin: 'http://127.0.0.1' },
        env,
        ctx
      );
      await Promise.allSettled(pending);
      console.log(`[cron] ${reason} 结果 ${summarize(result)} @ ${result && result.at ? result.at : ''}`);
      return true;
    } catch (err) {
      console.error('[cron] 执行失败：', err && err.stack ? err.stack : err);
      return false;
    }
  });
}

const SIGNIN_PATHS = new Set(['/cron', '/api/run-all', '/trae/api/run', '/wb/api/run', '/qoder/api/run']);

let signinChain = Promise.resolve();

/** 签到会轮换刷新令牌，同一进程里串行，避免定时和手动同时打同一账号。 */
function enqueueSignin(fn) {
  const job = signinChain.then(fn, fn);
  signinChain = job.then(
    () => {},
    () => {}
  );
  return job;
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a ?? ''));
  const y = new TextEncoder().encode(String(b ?? ''));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function adminGate(request, env) {
  const url = new URL(request.url);
  const given =
    request.headers.get('X-Admin-Token') ||
    (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') ||
    url.searchParams.get('token');
  if (!env.ADMIN_TOKEN) return { ok: false, status: 500, error: '未配置 ADMIN_TOKEN' };
  if (!safeEqual(given, env.ADMIN_TOKEN)) return { ok: false, status: 401, error: '登录密码不正确' };
  return { ok: true };
}

function describeSchedule(store, scheduler, config, fromEnv) {
  const clock = beijingNow();
  const status = scheduler.status();
  return {
    enabled: status.enabled,
    catchup: status.catchup,
    times: config.times,
    jitterMinSec: status.jitterMinSec,
    jitterMaxSec: status.jitterMaxSec,
    fromEnv,
    timezone: 'Asia/Shanghai',
    slots: status.slots.map((slot) => ({
      id: slot.id,
      time: slot.label,
      cron: slot.cron,
      today: store.getMeta(slotKey(slot.id, clock.day)),
    })),
  };
}

export async function startServer(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.DATA_DIR ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
  const port = options.port ?? Number(process.env.PORT || 8787);
  const hostname = options.hostname || process.env.HOST || '0.0.0.0';
  const env = options.env ? { ...loadEnv({}), ...options.env } : loadEnv();
  const cronEnabled = options.cron ?? flagOn(process.env.CRON_ENABLED, true);
  const catchup = options.catchup ?? flagOn(process.env.CRON_CATCHUP, true);

  const store = openStore(dataDir);
  env.KV = store.kv;
  warnConfig(env);

  const loaded = await loadScheduleConfig(store.kv, process.env, {
    cron: cronEnabled,
    catchup,
    jitterMinSec: options.jitterMinSec ?? process.env.CRON_JITTER_MIN_SEC,
    jitterMaxSec: options.jitterMaxSec ?? process.env.CRON_JITTER_MAX_SEC,
  });
  let scheduleState = loaded;

  const scheduler = createScheduler({
    store,
    enabled: loaded.config.enabled,
    catchup: loaded.config.catchup,
    slots: slotsFromTimes(loaded.config.times),
    jitterMinSec: loaded.config.jitterMinSec,
    jitterMaxSec: loaded.config.jitterMaxSec,
    run: () => runScheduled(env, 'scheduler'),
  });

  function healthBody() {
    const view = describeSchedule(store, scheduler, scheduleState.config, scheduleState.fromEnv);
    const clock = beijingNow();
    return {
      ok: true,
      ready: masterKeyOk(env.MASTER_KEY) && !!env.ADMIN_TOKEN,
      service: 'trae-workbuddy-qoder-checkin',
      storage: 'sqlite',
      timezone: 'Asia/Shanghai',
      now: `${clock.day} ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
      cron: {
        enabled: view.enabled,
        catchup: view.catchup,
        jitterMinSec: view.jitterMinSec,
        jitterMaxSec: view.jitterMaxSec,
        slots: view.slots,
      },
    };
  }

  const app = new Hono();
  app.all('*', async (c) => {
    const path = new URL(c.req.url).pathname.replace(/\/+$/, '') || '/';
    if (path === '/health') return c.json(healthBody());
    if (path === '/api/schedule' && (c.req.method === 'GET' || c.req.method === 'POST')) {
      const gate = adminGate(c.req.raw, env);
      if (!gate.ok) return c.json({ error: gate.error }, gate.status);
      if (c.req.method === 'GET') {
        return c.json(describeSchedule(store, scheduler, scheduleState.config, scheduleState.fromEnv));
      }
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const parsed = normalizeScheduleConfig(body);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      await saveScheduleConfig(store.kv, parsed.config);
      scheduler.reload(parsed.config);
      scheduleState = { config: parsed.config, fromEnv: false };
      console.log('[cron] 控制台已保存定时设置：' + parsed.config.times.join('、'));
      return c.json(describeSchedule(store, scheduler, parsed.config, false));
    }
    const pending = [];
    const ctx = {
      waitUntil(p) {
        pending.push(Promise.resolve(p));
      },
    };
    const dispatch = async () => {
      try {
        const res = await worker.fetch(c.req.raw, env, ctx);
        if (pending.length) Promise.allSettled(pending);
        return res;
      } catch (err) {
        return c.json({ error: err && err.message ? err.message : String(err) }, 500);
      }
    };
    const method = c.req.method.toUpperCase();
    if (method === 'POST' && SIGNIN_PATHS.has(path)) return enqueueSignin(dispatch);
    return dispatch();
  });

  const server = serve({ fetch: app.fetch, port, hostname });
  await new Promise((resolve, reject) => {
    if (server.listening) resolve();
    else {
      server.once('listening', resolve);
      server.once('error', reject);
    }
  });

  const address = server.address();
  const bound = address && typeof address === 'object' ? address.port : port;

  return {
    port: bound,
    hostname,
    dataDir,
    file: store.file,
    env,
    store,
    scheduler,
    server,
    async close() {
      scheduler.stop();
      await scheduler.whenIdle();
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
      store.close();
    },
  };
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  let handle;
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[server] 收到 ${signal}，正在退出`);
    try {
      if (handle) await handle.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  startServer()
    .then((started) => {
      handle = started;
      console.log(`[server] 签到控制台 http://${started.hostname}:${started.port}`);
      console.log(`[server] 数据文件 ${started.file}`);
    })
    .catch((err) => {
      console.error('[server] 启动失败：', err && err.stack ? err.stack : err);
      process.exit(1);
    });
}
