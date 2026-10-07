import { PolicySelectionBasis, PolicyVersion } from './types';
import { iso } from './ids';

export type PolicySelectionErrorCode = 'UNKNOWN_POLICY' | 'NO_EFFECTIVE_POLICY_VERSION' | 'REPORTED_BEFORE_LOSS';

export class PolicySelectionError extends Error {
  override readonly name = 'PolicySelectionError';
  constructor(readonly code: PolicySelectionErrorCode, readonly details: Record<string, unknown>, message: string) {
    super(message);
  }
}

const ms = (value: string): number => Date.parse(iso(value));
const intervalOf = (version: PolicyVersion): string => `v${version.version} [${iso(version.effectiveFrom)}, ${version.effectiveTo ? iso(version.effectiveTo) : 'open'})`;

export class PolicyCatalog {
  private readonly versions = new Map<string, PolicyVersion[]>();

  constructor() {
    this.seed({ policyId: 'P-100', version: 1, effectiveFrom: '2025-01-01T00:00:00Z', effectiveTo: '2026-07-01T00:00:00Z', coverages: ['collision', 'theft'], deductibleMinor: 100000, limitMinor: 5000000 });
    this.seed({ policyId: 'P-100', version: 2, effectiveFrom: '2026-07-01T00:00:00Z', coverages: ['collision', 'theft', 'rental'], deductibleMinor: 50000, limitMinor: 8000000 });
    this.seed({ policyId: 'P-200', version: 1, effectiveFrom: '2025-01-01T00:00:00Z', coverages: ['property'], deductibleMinor: 200000, limitMinor: 12000000 });
  }

  seed(policy: PolicyVersion): void {
    const versions = this.versions.get(policy.policyId) ?? [];
    versions.push(policy);
    versions.sort((a, b) => a.version - b.version);
    this.versions.set(policy.policyId, versions);
  }

  /**
   * Selects the liability version truly in force at the accident time.
   * All three timestamps participate in the decision: the loss time picks the
   * effective interval, the report time is validated against the loss time, and
   * endorsement effectiveFrom/effectiveTo are compared at full precision using a
   * uniform left-closed right-open rule: effectiveFrom <= lossAt < effectiveTo.
   */
  select(policyId: string, lossAt: string, reportedAt: string): { policy: PolicyVersion; basis: PolicySelectionBasis } {
    const lossIso = iso(lossAt);
    const reportedIso = iso(reportedAt);
    if (Date.parse(reportedIso) < Date.parse(lossIso)) {
      throw new PolicySelectionError('REPORTED_BEFORE_LOSS', { policyId, lossAt: lossIso, reportedAt: reportedIso }, `claim reported at ${reportedIso} is before the loss at ${lossIso}`);
    }
    const versions = this.versions.get(policyId) ?? [];
    if (versions.length === 0) {
      throw new PolicySelectionError('UNKNOWN_POLICY', { policyId, lossAt: lossIso, reportedAt: reportedIso }, `no policy versions registered for ${policyId}`);
    }
    const lossMs = Date.parse(lossIso);
    const covering = versions.filter((version) => {
      const fromMs = ms(version.effectiveFrom);
      const toMs = version.effectiveTo ? ms(version.effectiveTo) : Number.POSITIVE_INFINITY;
      return fromMs <= lossMs && lossMs < toMs;
    });
    // On overlapping intervals the endorsement whose interval starts closest
    // before the loss governs; version number only breaks exact ties.
    const selected = covering.sort((a, b) => ms(a.effectiveFrom) - ms(b.effectiveFrom) || a.version - b.version).at(-1);
    if (!selected) {
      const knownVersions = versions.map((version) => ({ version: version.version, effectiveFrom: iso(version.effectiveFrom), effectiveTo: version.effectiveTo ? iso(version.effectiveTo) : undefined }));
      throw new PolicySelectionError('NO_EFFECTIVE_POLICY_VERSION', { policyId, lossAt: lossIso, reportedAt: reportedIso, knownVersions }, `no effective policy version for ${policyId} at loss time ${lossIso}; known intervals: ${versions.map(intervalOf).join(', ')}`);
    }
    const policy = structuredClone({
      ...selected,
      coverages: [...selected.coverages],
      effectiveFrom: iso(selected.effectiveFrom),
      effectiveTo: selected.effectiveTo ? iso(selected.effectiveTo) : undefined,
    });
    const basis: PolicySelectionBasis = { policyId, lossAt: lossIso, reportedAt: reportedIso, version: policy.version, effectiveFrom: policy.effectiveFrom, effectiveTo: policy.effectiveTo, boundaryRule: 'left-closed-right-open', decidedAt: iso() };
    return { policy, basis };
  }

  snapshot(policyId: string, lossAt: string, reportedAt: string = lossAt): PolicyVersion {
    return this.select(policyId, lossAt, reportedAt).policy;
  }
}
