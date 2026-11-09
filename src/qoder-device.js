/**
 * 国际版活动列表要带 Qoder 自己的 runtime-info 身份。
 * 没有 Cosy-MachineToken + Cosy-MachineType 时，接口仍返回 200，
 * 但只有营销卡（VIEW_DETAILS），不会出现「每天领 100 Credits」。
 * 这三件套必须来自同一次 runtime-info，环境参数国际版是 3、国内版是 0。
 */

function str(v) {
  return String(v ?? '').trim();
}

function pick(obj, keys) {
  for (const key of keys) {
    const value = str(obj?.[key]);
    if (value) return value;
  }
  return '';
}

/** runtime-info 的 JSON，或已经拆开的 { machineToken, machineCode, machineType }。 */
export function parseDevicePassport(input) {
  let obj = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) throw new Error('请粘贴 runtime-info 打印的 JSON');
    try {
      obj = JSON.parse(text);
    } catch {
      throw new Error('这不是 JSON。请粘贴 runtime-info 的整段输出');
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('通行证格式不对');
  }
  const src = pick(obj, ['machineToken', 'MachineToken']) ? obj
    : (obj.data && typeof obj.data === 'object' ? obj.data : obj);
  const token = pick(src, ['machineToken', 'MachineToken', 'token']);
  const code = pick(src, ['machineCode', 'MachineCode', 'code']);
  const type = pick(src, ['machineType', 'MachineType', 'type']);
  const machineId = pick(src, ['machineId', 'MachineId']);
  if (!token || !type) {
    throw new Error('JSON 里需要 machineToken 和 machineType。请用国际版 Qoder 的 runtime-info，参数是 3');
  }
  if (token.length > 8192 || code.length > 8192 || type.length > 128 || machineId.length > 256) {
    throw new Error('通行证字段过长');
  }
  return { token, code, type, machineId };
}

/**
 * 账号上保存的优先。环境变量只补给国际版，避免国内版账号误用国际版设备身份。
 */
export function campaignIdentity(acct, env) {
  const own = {
    token: str(acct?.machineToken),
    code: str(acct?.machineCode),
    type: str(acct?.machineType),
    machineId: str(acct?.machineIdFromPassport),
  };
  if (own.token && own.type) return { ...own, source: 'account' };
  const region = str(acct?.region).toLowerCase();
  const intl = region === 'global' || region === 'intl' || region === 'international';
  if (!intl) return { token: '', code: '', type: '', machineId: '', source: '' };
  const token = str(env?.QODER_MACHINE_TOKEN);
  const type = str(env?.QODER_MACHINE_TYPE);
  const code = str(env?.QODER_MACHINE_CODE);
  if (token && type) return { token, code, type, machineId: '', source: 'env' };
  return { token: '', code: '', type: '', machineId: '', source: '' };
}

export function identityReady(identity) {
  return !!(identity && identity.token && identity.type);
}

/** 有完整身份才附加。只带 type、不带 token，服务端会当成伪造，活动列表退化成营销卡。 */
export function identityHeaders(identity) {
  if (!identityReady(identity)) return {};
  const headers = {
    'cosy-machinetoken': identity.token,
    'cosy-machinetype': identity.type,
  };
  if (identity.code) headers['cosy-machinecode'] = identity.code;
  if (identity.machineId) headers['cosy-machineid'] = identity.machineId;
  return headers;
}

/**
 * 列表里没有可领的每日权益时，给用户看的那句话。
 * 营销卡的 CLAIMED 不能叫「今日已签」。
 */
export function campaignWaitMessage({ regionKey, deviceReady, hasBenefitRow, claimed, digest }) {
  const tail = digest ? ' ' + digest : '';
  if (regionKey === 'global' && !deviceReady) {
    return '国际版缺少设备通行证，活动接口只会返回营销卡。请在装有国际版 Qoder 的电脑上运行 runtime-info（参数 3），把 JSON 保存到这个账号后再签到。' + tail;
  }
  if (regionKey === 'global' && deviceReady && !hasBenefitRow) {
    return '已带上设备通行证，但列表里没有每日 Credits（CLAIM_BENEFIT）。请确认通行证来自国际版客户端（runtime-info 参数 3），不要用国内版的。' + tail;
  }
  if (claimed && hasBenefitRow) return '今日已领取（活动状态已是 CLAIMED）';
  if (claimed) return '今日没有签到活动，只有营销活动 · ' + (digest || '');
  return '没有可领取的活动 · ' + (digest || '');
}
