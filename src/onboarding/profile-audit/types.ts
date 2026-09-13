export * from '../../shared/schemas/profile-audit';
import type {
  ReplayConfiguration,
  AuditManifestSample,
  AuditGroundTruth,
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
