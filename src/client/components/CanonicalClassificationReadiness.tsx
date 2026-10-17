import type { CanonicalClassificationReadinessResult, RequiredValueGap } from '../../shared/schemas/classification';

const STATUS_LABEL: Record<RequiredValueGap['status'], string> = {
  missing: 'Missing (required)',
  valued: 'Valued',
  not_applicable: 'Not applicable',
  optional_unvalued: 'Optional — no value',
  required_unknown: 'Required — applicability unknown',
  optional_unknown: 'Optional — applicability unknown',
};

function humanizeId(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}

export function CanonicalClassificationReadiness({
  result,
}: {
  result: CanonicalClassificationReadinessResult | null | undefined;
}) {
  if (!result) return null;

  return (
    <section className="rv-field" aria-label="Classification readiness">
      <div className="rv-field-label">Classification readiness</div>
      <p role="status" className="rv-meta-note">
        <strong>{result.ok ? 'Ready' : 'Not ready'}</strong> — {result.reason}
      </p>
      {result.details.profileId && (
        <p className="rv-meta-note">Attribute Profile: {humanizeId(result.details.profileId)}</p>
      )}
      {result.details.requiredValues.length > 0 && (
        <ul aria-label="Classification attribute readiness" className="rv-readiness-list">
          {result.details.requiredValues.map(value => (
            <li key={value.attributeId} className="rv-readiness-row">
              <span className="rv-abstention-target">{humanizeId(value.attributeId)}</span>
              <span>{STATUS_LABEL[value.status]}</span>
              {value.catalogField && <span className="rv-meta-note">{value.catalogField}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
