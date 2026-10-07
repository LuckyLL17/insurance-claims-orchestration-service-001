import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';
import { ClaimReportedPayload } from '../src/domain/types';

const report = (overrides: Partial<ClaimReportedPayload> = {}): ClaimReportedPayload => ({
  policyId: 'P-100',
  lossAt: '2026-08-01T08:00:00Z',
  reportedAt: '2026-08-01T09:00:00Z',
  channel: 'mobile',
  participants: [{ kind: 'vehicle', id: 'car-1' }],
  loss: { currency: 'CNY', gross: 18000 },
  ...overrides,
});

test('selects the version in force at the exact loss instant with left-closed right-open boundaries', () => {
  const app = buildApp();
  // P-100 v1 covers [2025-01-01, 2026-07-01T00:00:00Z), v2 covers [2026-07-01T00:00:00Z, open)
  const justBefore = app.claims.create(report({ lossAt: '2026-06-30T23:59:59.999Z', reportedAt: '2026-07-01T08:00:00Z' }), 'test');
  assert.equal(justBefore.policy?.version, 1);
  assert.equal(justBefore.policy?.deductibleMinor, 100000);
  const atBoundary = app.claims.create(report({ lossAt: '2026-07-01T00:00:00Z', reportedAt: '2026-07-01T08:00:00Z' }), 'test');
  assert.equal(atBoundary.policy?.version, 2);
  assert.equal(atBoundary.policy?.deductibleMinor, 50000);
  assert.equal(atBoundary.policy?.limitMinor, 8000000);
});

test('does not leak a same-calendar-day later endorsement into an earlier loss', () => {
  const app = buildApp();
  // Endorsement v3 takes effect at noon; a morning loss on the same day stays on v2.
  app.policies.seed({ policyId: 'P-100', version: 3, effectiveFrom: '2026-10-01T12:00:00Z', coverages: ['collision'], deductibleMinor: 1000, limitMinor: 9900000 });
  const morning = app.claims.create(report({ lossAt: '2026-10-01T08:00:00Z', reportedAt: '2026-10-01T09:00:00Z' }), 'test');
  assert.equal(morning.policy?.version, 2);
  assert.equal(morning.policy?.deductibleMinor, 50000);
  const afternoon = app.claims.create(report({ lossAt: '2026-10-01T12:00:00Z', reportedAt: '2026-10-01T13:00:00Z' }), 'test');
  assert.equal(afternoon.policy?.version, 3);
  assert.equal(afternoon.policy?.deductibleMinor, 1000);
});

test('fails with a diagnosable error when no policy version covers the loss', () => {
  const app = buildApp();
  // Surrender at 2026-03-01, reinstatement at 2026-03-10: losses in the gap are uninsured.
  app.policies.seed({ policyId: 'P-900', version: 1, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-03-01T00:00:00Z', coverages: ['property'], deductibleMinor: 100, limitMinor: 1000 });
  app.policies.seed({ policyId: 'P-900', version: 2, effectiveFrom: '2026-03-10T00:00:00Z', coverages: ['property'], deductibleMinor: 100, limitMinor: 1000 });
  assert.throws(
    () => app.claims.create(report({ policyId: 'P-900', lossAt: '2026-03-05T10:00:00Z', reportedAt: '2026-03-05T11:00:00Z' }), 'test'),
    (error: any) => error.code === 'NO_EFFECTIVE_POLICY_VERSION'
      && error.details.policyId === 'P-900'
      && error.details.lossAt === '2026-03-05T10:00:00.000Z'
      && error.details.knownVersions.length === 2,
  );
  assert.throws(() => app.claims.create(report({ policyId: 'P-NOPE' }), 'test'), (error: any) => error.code === 'UNKNOWN_POLICY');
  assert.throws(
    () => app.claims.create(report({ lossAt: '2026-08-02T00:00:00Z', reportedAt: '2026-08-01T00:00:00Z' }), 'test'),
    (error: any) => error.code === 'REPORTED_BEFORE_LOSS',
  );
});

test('pins the liability snapshot so later endorsements cannot rewrite history', () => {
  const app = buildApp();
  const claim = app.claims.create(report(), 'test');
  assert.equal(claim.policy?.version, 2);
  assert.deepEqual(claim.snapshotBasis && { ...claim.snapshotBasis, decidedAt: '<any>' }, {
    policyId: 'P-100',
    lossAt: '2026-08-01T08:00:00.000Z',
    reportedAt: '2026-08-01T09:00:00.000Z',
    version: 2,
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    effectiveTo: undefined,
    boundaryRule: 'left-closed-right-open',
    decidedAt: '<any>',
  });
  // A retroactive endorsement published after the claim entered the pipeline would
  // govern a fresh selection, but must not change this claim's pinned basis.
  app.policies.seed({ policyId: 'P-100', version: 4, effectiveFrom: '2026-07-15T00:00:00Z', coverages: ['collision'], deductibleMinor: 1, limitMinor: 1 });
  const reloaded = app.claims.get(claim.id);
  assert.equal(reloaded.policy?.version, 2);
  assert.equal(reloaded.policy?.deductibleMinor, 50000);
  assert.equal(reloaded.policy?.limitMinor, 8000000);
  assert.deepEqual(reloaded.policy?.coverages, ['collision', 'theft', 'rental']);
  const replayed = app.replay.execute(claim.id);
  assert.equal(replayed.state.policy?.version, 2);
  assert.equal(replayed.state.policy?.deductibleMinor, 50000);
  assert.equal(replayed.state.snapshotBasis?.version, 2);
  // Injecting a replacement snapshot event is rejected at the service boundary.
  assert.throws(() => app.claims.addEvent(claim.id, 'policy.snapshot.created', { policy: {}, ruleSnapshot: {} }, 'ops'), /already pinned/);
});
