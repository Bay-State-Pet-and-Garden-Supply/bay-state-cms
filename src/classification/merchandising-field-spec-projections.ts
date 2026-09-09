import type {
  MerchandisingFieldReadModel,
  CatalogFieldSummary,
  ProductFieldCurationCandidate,
} from '../shared/schemas/merchandising-field-spec';
import { canonicalForm } from './controlled-value-identity';

export function inferValueMode(field: {
  distinctCount: number;
  nonEmptyCount: number;
}): 'controlled' | 'freeText' | 'measured' | 'unknown' {
  if (field.nonEmptyCount === 0) return 'unknown';
  const ratio = field.distinctCount / field.nonEmptyCount;
  if (ratio <= 0.15 && field.distinctCount <= 100) return 'controlled';
  if (ratio > 0.8) return 'freeText';
  return 'measured';
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  const seen = new Map<string, string>();
  for (const raw of values) {
    const value = canonicalForm(String(raw ?? ''));
    if (!value) continue;
    if (!seen.has(value)) seen.set(value, value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export function projectCurationFieldCandidates(
  model: MerchandisingFieldReadModel,
): ProductFieldCurationCandidate[] {
  // Settings universe:
  // Registry entries with kind === 'custom' or xmlField starting with 'ProductField',
  // plus discovered 'ProductField' keys absent from that filtered registry.
  const filteredSpecs = model.fieldSpecs.filter(spec => {
    const isRegistry = spec.origins.includes('registry');
    const isDiscovered = spec.origins.includes('discovered');

    if (isRegistry) {
      return spec.display.kind === 'custom' || spec.catalogField.startsWith('ProductField');
    }
    if (isDiscovered) {
      return spec.catalogField.startsWith('ProductField');
    }
    return false;
  });

  const candidates: ProductFieldCurationCandidate[] = filteredSpecs.map(spec => {
    const primaryBinding = spec.bindings[0] ?? null;
    const primaryTarget = spec.targets[0]?.target ?? null;
    const configured = primaryBinding?.configured ?? null;

    const attributeId = primaryBinding?.attributeId ?? primaryTarget?.attributeId ?? null;
    const isControlled = configured ? configured.valueMode === 'controlled' : true;

    let values: string[] = [];
    if (isControlled) {
      const rawLiveValues =
        spec.observed.liveOptions.status === 'available' ? spec.observed.liveOptions.data : [];
      const liveValues: string[] = [];
      for (const lv of rawLiveValues) {
        if (lv && lv.includes('|')) {
          for (const part of lv.split('|')) {
            const can = canonicalForm(part);
            if (can) liveValues.push(can);
          }
        } else if (lv) {
          const can = canonicalForm(lv);
          if (can) liveValues.push(can);
        }
      }
      const sampleValues = spec.observed.parsedRegistrySamples;
      const configuredValues = configured?.allowedValues ?? [];
      values = uniqueSorted([...liveValues, ...sampleValues, ...configuredValues]);
    }

    return {
      catalogField: spec.catalogField,
      label: spec.display.label || spec.catalogField,
      dataType: (spec.display.dataType as string) || 'string',
      values,
      target: primaryTarget ? { ...primaryTarget } : null,
      attributeId,
    };
  });

  // Sort by numeric suffix so ProductField24 comes after ProductField5,
  // not lexicographically.
  candidates.sort((a, b) => {
    const numA = parseInt(a.catalogField.replace(/\D/g, ''), 10) || 0;
    const numB = parseInt(b.catalogField.replace(/\D/g, ''), 10) || 0;
    return numA - numB || a.catalogField.localeCompare(b.catalogField);
  });

  return candidates;
}

export function projectCatalogFieldSummaries(
  model: MerchandisingFieldReadModel,
  view: 'catalog' | 'legacy-client-fallback',
): CatalogFieldSummary[] {
  // If registry is completely unavailable in fallback, return empty list
  if (view === 'legacy-client-fallback' && model.provenance.sourceAvailability.registry === 'unavailable') {
    return [];
  }

  // Catalog universe: registry entries only, in original registry order
  const registrySpecs = model.fieldSpecs.filter(s => s.origins.includes('registry'));

  if (view === 'legacy-client-fallback') {
    return registrySpecs.map(spec => {
      const isDirectTarget = spec.targets.some(t =>
        t.associationReasons.includes('direct_catalog_field'),
      );
      const isUnlabeled = !spec.display.label || spec.display.label === spec.catalogField;

      return {
        xmlField: spec.catalogField,
        label: spec.display.label || spec.catalogField,
        kind: (spec.display.kind as any) || 'custom',
        dataType: (spec.display.dataType as any) || 'string',
        uiGroup: spec.display.uiGroup,
        nonEmptyCount: 0,
        distinctCount: 0,
        inferredValueMode: 'unknown' as const,
        mappedAttributeId: spec.bindings[0]?.attributeId ?? null,
        isCurationTarget: isDirectTarget,
        isStale: false, // Legacy fallback default quirk
        warning: isUnlabeled ? 'Unlabeled field' : null,
      };
    });
  }

  // view === 'catalog'
  return registrySpecs.map(spec => {
    const stats =
      spec.observed.rawCatalogStats?.status === 'available'
        ? spec.observed.rawCatalogStats.data
        : { nonEmptyCount: 0, distinctCount: 0 };

    const isDirectTarget = spec.targets.some(t =>
      t.associationReasons.includes('direct_catalog_field'),
    );
    const primaryBinding = spec.bindings[0] ?? null;
    const isStale = primaryBinding?.isStale ?? false;

    let warning: string | null = null;
    if (
      spec.display.kind === 'custom' &&
      (!spec.display.label || spec.display.label === spec.catalogField)
    ) {
      warning = 'Unlabeled field';
    } else if (isStale) {
      warning = 'Stale mapping — field not in latest pull';
    }

    return {
      xmlField: spec.catalogField,
      label: spec.display.label || spec.catalogField,
      kind: (spec.display.kind as any) || 'custom',
      dataType: (spec.display.dataType as any) || 'string',
      uiGroup: spec.display.uiGroup,
      nonEmptyCount: stats.nonEmptyCount,
      distinctCount: stats.distinctCount,
      inferredValueMode: inferValueMode(stats),
      mappedAttributeId: primaryBinding?.attributeId ?? null,
      isCurationTarget: isDirectTarget,
      isStale,
      warning,
    };
  });
}
