import { PolicyVersion } from './types';
import { iso } from './ids';

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

  snapshot(policyId: string, lossAt: string): PolicyVersion {
    const requested = iso(lossAt);
    const calendarDay = requested.slice(0, 10);
    const candidates = (this.versions.get(policyId) ?? []).filter((version) => {
      const fromDay = iso(version.effectiveFrom).slice(0, 10);
      const toDay = version.effectiveTo ? iso(version.effectiveTo).slice(0, 10) : undefined;
      const startsOnOrBefore = calendarDay >= fromDay;
      const endsOnOrAfter = !toDay || calendarDay <= toDay;
      return startsOnOrBefore && endsOnOrAfter;
    });
    const selected = candidates
      .slice()
      .sort((left, right) => left.version - right.version)
      .at(-1);
    if (!selected) {
      throw new Error(`no effective policy version for ${policyId} at ${lossAt}`);
    }
    return structuredClone({
      ...selected,
      coverages: [...selected.coverages],
      effectiveFrom: new Date(selected.effectiveFrom).toISOString(),
      effectiveTo: selected.effectiveTo ? new Date(selected.effectiveTo).toISOString() : undefined,
    });
  }
}
