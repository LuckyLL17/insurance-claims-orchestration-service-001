import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';
import { NoEffectivePolicyVersionError, PolicyCatalog } from '../src/domain/policy';

const baseInput = { channel: 'mobile', participants: [] as { kind: 'person'; id: string }[], loss: { currency: 'CNY', gross: 5000 } };

test('selects the version truly in force at an intraday endorsement boundary (left-closed right-open)', () => {
  const policies = new PolicyCatalog();
  policies.seed({ policyId: 'P-900', version: 1, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-07-01T12:00:00Z', coverages: ['collision'], deductibleMinor: 100000, limitMinor: 1000000 });
  policies.seed({ policyId: 'P-900', version: 2, effectiveFrom: '2026-07-01T12:00:00Z', coverages: ['collision', 'rental'], deductibleMinor: 50000, limitMinor: 2000000 });

  // 事故发生在批改生效当天上午：仍属旧版本，免赔额与上限必须反映历史事实
  const morning = policies.snapshot('P-900', '2026-07-01T08:00:00Z', '2026-07-02T00:00:00Z');
  assert.equal(morning.version, 1);
  assert.equal(morning.deductibleMinor, 100000);
  assert.equal(morning.limitMinor, 1000000);

  // 边界时刻恰好等于生效时间：左闭，归新版本
  const exact = policies.snapshot('P-900', '2026-07-01T12:00:00Z', '2026-07-02T00:00:00Z');
  assert.equal(exact.version, 2);

  // 边界时刻恰好等于终止时间：右开，旧版本不再覆盖
  const beforeEnd = policies.snapshot('P-900', '2026-07-01T11:59:59.999Z', '2026-07-02T00:00:00Z');
  assert.equal(beforeEnd.version, 1);
});

test('applies the same left-closed right-open rule at midnight boundaries', () => {
  const policies = new PolicyCatalog();
  assert.equal(policies.snapshot('P-100', '2026-06-30T23:59:59.999Z', '2026-07-02T00:00:00Z').version, 1);
  assert.equal(policies.snapshot('P-100', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z').version, 2);
});

test('gives a diagnosable error in the cancellation gap and honors reinstatement', () => {
  const policies = new PolicyCatalog();
  policies.seed({ policyId: 'P-300', version: 1, effectiveFrom: '2025-01-01T00:00:00Z', effectiveTo: '2026-03-01T00:00:00Z', coverages: ['property'], deductibleMinor: 200000, limitMinor: 12000000 });
  policies.seed({ policyId: 'P-300', version: 2, effectiveFrom: '2026-05-01T00:00:00Z', coverages: ['property'], deductibleMinor: 100000, limitMinor: 15000000 });

  // 退保生效时刻起保障即终止（右开），退保当天白天的事故没有有效版本
  let caught: unknown;
  try {
    policies.snapshot('P-300', '2026-03-01T10:00:00Z', '2026-03-02T00:00:00Z');
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof NoEffectivePolicyVersionError);
  const failure = caught as NoEffectivePolicyVersionError;
  assert.equal(failure.code, 'NO_EFFECTIVE_POLICY_VERSION');
  assert.match(failure.message, /P-300/);
  assert.match(failure.message, /2026-03-01T10:00:00\.000Z/);
  assert.deepEqual(
    failure.details.rejections.map((r) => `v${r.version}:${r.reason}`),
    ['v1:expired-before-loss', 'v2:not-yet-effective'],
  );

  // 复效之后的事故命中复效版本
  assert.equal(policies.snapshot('P-300', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z').version, 2);
});

test('report time participates: endorsements published after the report never rewrite its basis', () => {
  const policies = new PolicyCatalog();
  const lossAt = '2026-08-01T08:00:00Z';
  const reportedAt = '2026-08-01T09:00:00Z';
  const before = policies.snapshot('P-100', lossAt, reportedAt);
  assert.equal(before.version, 2);

  // 事后发布的追溯批改（报案时系统尚不知情）
  policies.seed({ policyId: 'P-100', version: 3, effectiveFrom: '2026-07-15T00:00:00Z', publishedAt: '2026-09-01T00:00:00Z', coverages: ['collision'], deductibleMinor: 1, limitMinor: 1 });

  // 同样的 (lossAt, reportedAt) 重新选择，结果不变 —— 历史重放确定
  assert.deepEqual(policies.snapshot('P-100', lossAt, reportedAt), before);

  // 但报案时间晚于批改发布的案件会使用新批改
  assert.equal(policies.snapshot('P-100', lossAt, '2026-10-01T00:00:00Z').version, 3);

  // 报案时间恰好等于发布时间：左闭，视为已发布
  assert.equal(policies.snapshot('P-100', lossAt, '2026-09-01T00:00:00Z').version, 3);
});

test('failed claim creation writes no events and surfaces the diagnosable error', () => {
  const app = buildApp();
  app.policies.seed({ policyId: 'P-300', version: 1, effectiveFrom: '2025-01-01T00:00:00Z', effectiveTo: '2026-03-01T00:00:00Z', coverages: ['property'], deductibleMinor: 1, limitMinor: 1 });
  const eventsBefore = app.events.size();

  assert.throws(
    () => app.claims.create({ ...baseInput, policyId: 'P-300', lossAt: '2026-03-01T10:00:00Z', reportedAt: '2026-03-01T12:00:00Z' }, 'test'),
    (error: unknown) => {
      assert.ok(error instanceof NoEffectivePolicyVersionError);
      assert.equal(error.code, 'NO_EFFECTIVE_POLICY_VERSION');
      assert.equal(error.details.policyId, 'P-300');
      return true;
    },
  );
  assert.equal(app.events.size(), eventsBefore, 'no half-created claim events may remain');

  assert.throws(
    () => app.claims.create({ ...baseInput, policyId: 'P-999', lossAt: '2026-03-01T10:00:00Z', reportedAt: '2026-03-01T12:00:00Z' }, 'test'),
    /policy has no registered versions/,
  );
  assert.equal(app.events.size(), eventsBefore);
});

test('pins policy and rule basis once investigation starts; replay is immune to later endorsements', () => {
  const app = buildApp();
  const claim = app.claims.create({ ...baseInput, policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z' }, 'test');
  assert.equal(claim.policy?.version, 2);
  assert.equal(claim.ruleSnapshot?.version, '2026.10');

  // 案件进入调查阶段
  app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: 'photo' }, 'test');
  assert.equal(app.claims.get(claim.id).status, 'investigating');

  // 事后发布追溯批改与新规则版本
  app.policies.seed({ policyId: 'P-100', version: 3, effectiveFrom: '2026-07-15T00:00:00Z', publishedAt: '2026-09-01T00:00:00Z', coverages: ['collision'], deductibleMinor: 1, limitMinor: 1 });
  app.rules.publish('2026.11', []);

  // 历史重放不改变原始责任结论
  const replayed = app.replay.execute(claim.id).state;
  assert.equal(replayed.policy?.version, 2);
  assert.equal(replayed.policy?.deductibleMinor, 50000);
  assert.equal(replayed.policy?.limitMinor, 8000000);
  assert.equal(replayed.ruleSnapshot?.version, '2026.10');

  // 进入调查阶段后，即使注入新的快照事件也无法改写已固定的依据
  app.claims.addEvent(
    claim.id,
    'policy.snapshot.created',
    { policy: { ...claim.policy!, version: 3, deductibleMinor: 1 }, ruleSnapshot: { version: '2026.11', frozenAt: new Date().toISOString(), ruleIds: [] } },
    'ops',
  );
  const after = app.claims.get(claim.id);
  assert.equal(after.policy?.version, 2);
  assert.equal(after.policy?.deductibleMinor, 50000);
  assert.equal(after.ruleSnapshot?.version, '2026.10');
});

test('liability amounts on the claim reflect the historical version, not the latest one', () => {
  const app = buildApp();
  app.policies.seed({ policyId: 'P-900', version: 1, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-07-01T12:00:00Z', coverages: ['collision'], deductibleMinor: 100000, limitMinor: 1000000 });
  app.policies.seed({ policyId: 'P-900', version: 2, effectiveFrom: '2026-07-01T12:00:00Z', publishedAt: '2026-07-01T12:00:00Z', coverages: ['collision', 'rental'], deductibleMinor: 50000, limitMinor: 2000000 });

  const claim = app.claims.create({ ...baseInput, policyId: 'P-900', lossAt: '2026-07-01T08:00:00Z', reportedAt: '2026-07-01T09:00:00Z' }, 'test');
  assert.equal(claim.policy?.version, 1);
  assert.equal(claim.policy?.deductibleMinor, 100000);
  assert.equal(claim.policy?.limitMinor, 1000000);
  assert.deepEqual(claim.policy?.coverages, ['collision']);
});
