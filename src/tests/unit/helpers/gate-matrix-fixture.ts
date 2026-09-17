// Shared title-matrix fixture for the pure activation-gate suites
// (e07s01 evidence tests + #218 contract enforcement). One definition so
// the gate suites share matrix construction instead of cloning it.
export function titleMatrixFixture(domain: string, ids: string[], hashes: string[]) {
  return {
    domain,
    draftVersion: 'v6',
    createdAt: new Date().toISOString(),
    rows: ids.map((id, i) => ({
      sampleId: id,
      sampleUrl: `https://${domain}/${id}`,
      cells: [{ field: 'title', extracted: 'T', expected: 'T', provenance: 'test', artifactHash: hashes[i] ?? hashes[0], success: true, failureReason: null }],
    })),
  } as any;
}
