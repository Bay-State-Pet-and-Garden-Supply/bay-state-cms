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
}

export interface PilotAuditOptions {
  domain: string;
  artifactRoot?: string;
  manifest?: import('../../shared/schemas/profile-audit').AuditManifest;
  profile?: ExtractorProfile | null;
  sampleLimit?: number;
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
}

