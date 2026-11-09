import assert from 'node:assert/strict';
import test from 'node:test';
import {
  campaignIdentity,
  campaignWaitMessage,
  identityHeaders,
  parseDevicePassport,
} from '../src/qoder-device.js';

const passport = {
  machineToken: 'P1gA-real-token',
  machineCode: 'code-real',
  machineType: '3',
  machineId: 'desktop-machine',
};

test('解析 runtime-info JSON，半套 type 不当成通行证', () => {
  const parsed = parseDevicePassport(JSON.stringify(passport));
  assert.equal(parsed.token, passport.machineToken);
  assert.equal(parsed.code, passport.machineCode);
  assert.equal(parsed.type, '3');
  assert.equal(parsed.machineId, 'desktop-machine');
  assert.throws(() => parseDevicePassport('{"machineType":"3"}'), /machineToken/);
  assert.deepEqual(identityHeaders({ token: '', type: '3', code: '', machineId: '' }), {});
});

test('国际版用环境变量补通行证，国内版不用', () => {
  const env = {
    QODER_MACHINE_TOKEN: 'env-token',
    QODER_MACHINE_CODE: 'env-code',
    QODER_MACHINE_TYPE: '3',
  };
  const intl = campaignIdentity({ region: 'global' }, env);
  assert.equal(intl.source, 'env');
  assert.equal(identityHeaders(intl)['cosy-machinetoken'], 'env-token');
  assert.equal(identityHeaders(intl)['cosy-machinecode'], 'env-code');
  const cn = campaignIdentity({ region: 'cn', machineId: 'login-uuid' }, env);
  assert.equal(cn.source, '');
  assert.deepEqual(identityHeaders(cn), {});
  const own = campaignIdentity({ region: 'global', machineToken: 'acct', machineType: '9', machineCode: '' }, env);
  assert.equal(own.source, 'account');
  assert.equal(identityHeaders(own)['cosy-machinetoken'], 'acct');
  assert.equal(identityHeaders(own)['cosy-machinecode'], undefined);
});

test('营销卡 CLAIMED 不是已签，缺通行证时说明原因', () => {
  const missing = campaignWaitMessage({
    regionKey: 'global',
    deviceReady: false,
    hasBenefitRow: false,
    claimed: true,
    digest: '返回 1 条：VIEW_DETAILS / CLAIMED',
  });
  assert.match(missing, /设备通行证/);
  assert.doesNotMatch(missing, /今日已领取/);
  const sent = campaignWaitMessage({
    regionKey: 'global',
    deviceReady: true,
    hasBenefitRow: false,
    claimed: true,
    digest: '返回 1 条：VIEW_DETAILS / CLAIMED',
  });
  assert.match(sent, /已带上设备通行证/);
  assert.match(sent, /参数 3/);
});
