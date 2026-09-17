export * from '../../shared/schemas/profile-audit';
import type {
  AuditGroundTruth,
  ReplayConfiguration,
  HybridConflict,
  HybridIdentityResolution,
} from '../../shared/schemas/profile-audit';
import type { ExtractorProfile } from '../../db/repositories/extractor-profile-repo';
import type { ExtractionData } from '../../shared/schemas/onboarding';

export interface ExtractionOutcome {
  configuration: ReplayConfiguration;
  data: ExtractionData;
  raw?: any;
  conflicts?: HybridConflict[];
  variantDecision?: {
    status: string;
    selectedVariantKey: string | null;
    reasonCodes: string[];
  } | null;
  identityResolution?: HybridIdentityResolution;
  admittedImages: string[];
  rejectedImages: string[];
  primaryImage: string | null;
  imageRejectionReasons?: Record<string, string>;
  duplicateContaminationCount?: number;
  duplicateContamination?: boolean;
  isEvidenceGap: boolean;
  evidenceGapReason?: string | null;
  latencyMs?: number;
  requestCount?: number;
}

export interface GateArithmeticOptions {
  minSamplesForPromote?: number;
  targetConfidence?: number;
  operatorMinutesOverride?: Record<string, Record<ReplayConfiguration, number>>;
  baseOperatorMinutes?: number;
  labelVersion?: string;
  partition?: 'all' | 'tuning' | 'holdout';
  reportHoldoutSeparately?: boolean;
}

export interface ReplayRunnerOptions {
  artifactRoot?: string;
  expected?: {
    name?: string;
    brandHint?: string | null;
    price?: string | null;
    gtin?: string;
  };
  recordLatency?: boolean;
  /**
   * Deterministic clock injection (fix #8): defaults to performance.now().
   * Tests or offline replays may supply a fixed clock; wall-clock latency is
   * transport timing and is ALWAYS excluded from scored-row identity via
   * getDeterministicScoredRowIdentity().
   */
  clock?: () => number;
}

export interface PilotAuditOptions {
  domain: string;
  artifactRoot?: string;
  manifest?: import('../../shared/schemas/profile-audit').AuditManifest;
  profile?: ExtractorProfile | null;
  sampleLimit?: number;
  /**
   * Wall-clock latency recording (fix #5). Default false: replay stays fully
   * deterministic (same-artifact-in → same-scored-row-out) for unit tests.
   * Production pilot runs (scripts/run-pilot-audit.ts) enable this so cost
   * columns are measured; when false, cost columns are marked unmeasured
   * instead of backfilled with fiat estimates.
   */
  recordLatency?: boolean;
  /** Measured operator-minutes override, threaded to the gate arithmetic. */
  operatorMinutesOverride?: Record<string, Record<ReplayConfiguration, number>>;
  /** Base upkeep override for the modeled operator-minutes formula. */
  baseOperatorMinutes?: number;
  /** Workspace flow measurements override per scope (#191/#192). */
  workspaceFlows?: Record<string, import('./adapter-strategy-report').WorkspaceFlowScopeInput>;
}

export interface BuildStratifiedManifestOptions {
  domain?: string;
  domains?: string[];
  artifactRoot?: string;
  suiteUrls?: string[];
  candidateUrls?: Array<string | {
    url: string;
    lastmod?: string | null;
    title?: string | null;
    brand?: string | null;
    sku?: string | null;
    upc?: string | null;
  }>;
  candidateLimit?: number;
  samplesPerStratum?: number;
  splitSeed?: number;
  holdoutPercent?: number;
  holdoutFamilies?: string[];
  sitemapLastmods?: Record<string, string | null>;
  onboardingItems?: Array<{
    id: string;
    sourceUrl?: string | null;
    name?: string;
    brandHint?: string | null;
    sourceType?: 'official_page' | 'distributor_record';
    stage?: string;
    stageStatus?: string;
    errorMessage?: string | null;
    updatedAt?: string;
    createdAt?: string;
  }>;
  groundTruthOverrides?: Record<string, Partial<AuditGroundTruth>>;
  labelVersion?: string;
  isReviewed?: boolean;
  includeSyntheticFixtures?: boolean;
}
