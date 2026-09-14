export * from '../../shared/schemas/profile-audit';
import type {
  AuditGroundTruth,
  ReplayConfiguration,
} from '../../shared/schemas/profile-audit';
import type { ExtractorProfile } from '../../db/repositories/extractor-profile-repo';
import type { ExtractionData } from '../../shared/schemas/onboarding';

export interface ExtractionOutcome {
  configuration: ReplayConfiguration;
  data: ExtractionData;
  raw?: any;
  conflicts?: Array<{
    field: string;
    selectorValue: string | null;
    structuredValue: string | null;
    resolution: string;
  }>;
  variantDecision?: {
    status: string;
    selectedVariantKey: string | null;
    reasonCodes: string[];
  } | null;
  admittedImages: string[];
  rejectedImages: string[];
  primaryImage: string | null;
  isEvidenceGap: boolean;
  evidenceGapReason?: string | null;
}

export interface ReplayRunnerOptions {
  artifactRoot?: string;
  expected?: {
    name?: string;
    brandHint?: string | null;
    price?: string | null;
    gtin?: string;
  };
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
  candidateUrls?: string[];
  candidateLimit?: number;
  samplesPerStratum?: number;
  splitSeed?: number;
  holdoutPercent?: number;
  holdoutFamilies?: string[];
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

