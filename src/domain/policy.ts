import { PolicyVersion } from './types';
import { iso } from './ids';

export type PolicyRejectionReason = 'not-yet-effective' | 'expired-before-loss' | 'unpublished-at-report';

export interface PolicyVersionRejection {
  version: number;
  effectiveFrom: string;
  effectiveTo?: string;
  publishedAt?: string;
  reason: PolicyRejectionReason;
}

export class NoEffectivePolicyVersionError extends Error {
  readonly code = 'NO_EFFECTIVE_POLICY_VERSION';

  constructor(readonly details: { policyId: string; lossAt: string; reportedAt: string; rejections: PolicyVersionRejection[] }) {
    super(
      `no effective policy version for ${details.policyId} at lossAt=${details.lossAt} reportedAt=${details.reportedAt}` +
        (details.rejections.length
          ? `; known versions rejected: ${details.rejections
              .map((r) => `v${r.version} [${r.effectiveFrom}, ${r.effectiveTo ?? 'open'}) ${r.reason}`)
              .join(', ')}`
          : '; policy has no registered versions'),
    );
    this.name = 'NoEffectivePolicyVersionError';
  }
}

export class PolicyCatalog {
  private readonly versions = new Map<string, PolicyVersion[]>();

  constructor() {
    this.seed({ policyId: 'P-100', version: 1, effectiveFrom: '2025-01-01T00:00:00Z', effectiveTo: '2026-07-01T00:00:00Z', publishedAt: '2025-01-01T00:00:00Z', coverages: ['collision', 'theft'], deductibleMinor: 100000, limitMinor: 5000000 });
    this.seed({ policyId: 'P-100', version: 2, effectiveFrom: '2026-07-01T00:00:00Z', publishedAt: '2026-06-15T00:00:00Z', coverages: ['collision', 'theft', 'rental'], deductibleMinor: 50000, limitMinor: 8000000 });
    this.seed({ policyId: 'P-200', version: 1, effectiveFrom: '2025-01-01T00:00:00Z', publishedAt: '2025-01-01T00:00:00Z', coverages: ['property'], deductibleMinor: 200000, limitMinor: 12000000 });
  }

  seed(policy: PolicyVersion): void {
    const normalized: PolicyVersion = {
      ...policy,
      effectiveFrom: iso(policy.effectiveFrom),
      effectiveTo: policy.effectiveTo ? iso(policy.effectiveTo) : undefined,
      publishedAt: iso(policy.publishedAt ?? policy.effectiveFrom),
      coverages: [...policy.coverages],
    };
    const versions = this.versions.get(policy.policyId) ?? [];
    versions.push(normalized);
    versions.sort((a, b) => a.version - b.version);
    this.versions.set(policy.policyId, versions);
  }

  /**
   * 选取事故发生时真正生效、且报案时已发布的保单版本。
   *
   * 三个时间分别参与判断，边界统一左闭右开：
   * - 事故时间 lossAt 必须落在 [effectiveFrom, effectiveTo) 责任窗口内；
   * - 批改发布时间 publishedAt 必须不晚于报案时间 reportedAt，
   *   报案之后才发布的批改不回溯影响已报案案件；
   * - 多个版本同时命中时（如追溯批改造成窗口重叠），取 effectiveFrom 最新、
   *   版本号最高者，即事故点上最后生效的责任版本。
   *
   * 选择只依赖 (policyId, lossAt, reportedAt)，之后发布新批改不会改变结果。
   */
  snapshot(policyId: string, lossAt: string, reportedAt: string): PolicyVersion {
    const loss = iso(lossAt);
    const reported = iso(reportedAt);
    const eligible: PolicyVersion[] = [];
    const rejections: PolicyVersionRejection[] = [];
    for (const version of this.versions.get(policyId) ?? []) {
      const reason = this.rejectionReason(version, loss, reported);
      if (reason) {
        rejections.push({ version: version.version, effectiveFrom: version.effectiveFrom, effectiveTo: version.effectiveTo, publishedAt: version.publishedAt, reason });
      } else {
        eligible.push(version);
      }
    }
    eligible.sort((a, b) => (a.effectiveFrom === b.effectiveFrom ? a.version - b.version : a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    const selected = eligible.at(-1);
    if (!selected) throw new NoEffectivePolicyVersionError({ policyId, lossAt: loss, reportedAt: reported, rejections });
    return structuredClone(selected);
  }

  private rejectionReason(version: PolicyVersion, lossAt: string, reportedAt: string): PolicyRejectionReason | undefined {
    if (lossAt < version.effectiveFrom) return 'not-yet-effective';
    if (version.effectiveTo && lossAt >= version.effectiveTo) return 'expired-before-loss';
    if (version.publishedAt && version.publishedAt > reportedAt) return 'unpublished-at-report';
    return undefined;
  }
}
