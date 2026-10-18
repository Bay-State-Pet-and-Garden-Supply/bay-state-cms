import type { CSSProperties } from 'react';
import type { ClassificationDraftProjectionPreview } from '../../shared/schemas/classification';
type ProjectionRefusals = NonNullable<ClassificationDraftProjectionPreview['projection']>['refusals'];
const sectionStyle: CSSProperties = {
  marginTop: 16,
  padding: 12,
  background: 'var(--surface-muted, #f8fafc)',
  border: '1px solid var(--border-subtle, #e2e8f0)',
  borderRadius: 8,
  color: 'var(--text-primary, #1e293b)',
  fontSize: 13,
};

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--text-primary, #1e293b)',
};

const noteStyle: CSSProperties = {
  margin: '4px 0 12px',
  color: 'var(--text-muted, #475569)',
  lineHeight: 1.45,
};

const groupStyle: CSSProperties = {
  marginTop: 12,
};

const groupHeadingStyle: CSSProperties = {
  margin: '0 0 6px',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--text-primary, #1e293b)',
};

function fieldLabel(target: string): string {
  const shopSiteField = /^ProductField(\d+)$/i.exec(target);
  return shopSiteField ? `Product Field ${shopSiteField[1]}` : target.replace(/[-_]+/g, ' ');
}

function AssignmentList({ assignments }: { assignments: Record<string, string> }) {
  const entries = Object.entries(assignments);
  if (entries.length === 0) {
    return <p style={{ ...noteStyle, margin: 0 }}>No field assignments.</p>;
  }

  return (
    <dl style={{ margin: 0, display: 'grid', gap: 4 }}>
      {entries.map(([target, value]) => (
        <div key={target} style={{ display: 'grid', gridTemplateColumns: 'minmax(7rem, 0.4fr) minmax(0, 1fr)', gap: 8 }}>
          <dt style={{ color: 'var(--text-muted, #475569)' }}>{fieldLabel(target)}</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{value === '' ? 'Cleared' : value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PageChanges({ label, pages }: { label: string; pages: string[] }) {
  if (pages.length === 0) return null;
  return (
    <div style={groupStyle}>
      <h5 style={groupHeadingStyle}>{label}</h5>
      <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-primary, #1e293b)' }}>
        {pages.map(page => <li key={page} style={{ overflowWrap: 'anywhere' }}>{page}</li>)}
      </ul>
    </div>
  );
}

function RefusalList({ refusals }: { refusals: ProjectionRefusals }) {
  if (refusals.length === 0) return null;
  return (
    <div role="status" style={{ ...groupStyle, color: 'var(--warning-text, #7c2d12)' }}>
      <h5 style={groupHeadingStyle}>Projection needs review</h5>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {refusals.map(refusal => (
          <li key={`${refusal.proposalId}:${refusal.targetId ?? ''}`}>
            {refusal.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ClassificationDraftProjectionCard({
  preview,
}: {
  preview: ClassificationDraftProjectionPreview | null | undefined;
}) {
  if (!preview) return null;
  if (preview.status === 'failed') {
    return (
      <section aria-label="Current draft projection" style={sectionStyle}>
        <h4 style={headingStyle}>Draft projection</h4>
        <p role="alert" style={{ ...noteStyle, color: 'var(--error-text, #991b1b)', marginBottom: 0 }}>
          {preview.error ?? 'The current draft projection is unavailable.'}
        </p>
      </section>
    );
  }

  const projection = preview.projection;
  if (!projection) return null;
  const hasApprovedChanges = Object.keys(projection.fieldAssignments).length > 0
    || projection.pageAssignments.length > 0
    || projection.removedPages.length > 0;
  const hasProvisionalChanges = Object.keys(projection.provisionalFieldAssignments).length > 0
    || projection.pendingPageAssignments.length > 0
    || projection.pendingRemovedPages.length > 0;

  return (
    <section aria-label="Current draft projection" style={sectionStyle}>
      <h4 style={headingStyle}>Draft projection</h4>
      <p style={noteStyle}>
        Accepted decisions appear in the reviewed draft. Pending suggestions are shown separately as provisional and are not applied.
      </p>
      {projection.title && (
        <div style={groupStyle}>
          <h5 style={groupHeadingStyle}>Curated title</h5>
          <div style={{ overflowWrap: 'anywhere' }}>{projection.title.value}</div>
          <div style={{ color: 'var(--text-muted, #475569)', fontSize: 12 }}>Source: {projection.title.source}</div>
        </div>
      )}
      <div style={groupStyle}>
        <h5 style={groupHeadingStyle}>Reviewed draft</h5>
        {hasApprovedChanges ? (
          <>
            <AssignmentList assignments={projection.fieldAssignments} />
            <PageChanges label="Category Page additions" pages={projection.pageAssignments} />
            <PageChanges label="Category Page removals" pages={projection.removedPages} />
          </>
        ) : (
          <p style={{ ...noteStyle, margin: 0 }}>No approved field or Category Page changes.</p>
        )}
        <RefusalList refusals={projection.refusals} />
      </div>
      {hasProvisionalChanges && (
        <div style={groupStyle}>
          <h5 style={groupHeadingStyle}>Provisional · not approved</h5>
          <AssignmentList assignments={projection.provisionalFieldAssignments} />
          <PageChanges label="Category Page additions" pages={projection.pendingPageAssignments} />
          <PageChanges label="Category Page removals" pages={projection.pendingRemovedPages} />
          <RefusalList refusals={projection.provisionalRefusals} />
        </div>
      )}
      {preview.status === 'abstained' && preview.message && (
        <p style={{ ...noteStyle, color: 'var(--warning-text, #7c2d12)', marginBottom: 0 }}>{preview.message}</p>
      )}
    </section>
  );
}
