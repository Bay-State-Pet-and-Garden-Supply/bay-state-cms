import { z } from 'zod';
import { ListingCompletenessStandardSchema, ListingRequirementSchema, type ListingCompletenessStandard, type ListingRequirement } from '../shared/schemas/item-evidence';
import { readListingStandardsFile, writeListingStandardsFile } from '../classification/config-store';
import { hashCanonicalJson } from '../shared/stable-id';
interface StandardsDocument { recordVersion: 1; standards: ListingCompletenessStandard[] }
const StandardsDocumentSchema = z.object({ recordVersion: z.literal(1), standards: z.array(ListingCompletenessStandardSchema) }).strict();


function parseDocument(content: string | null): StandardsDocument {
  if (content === null) return { recordVersion: 1, standards: [] };
  const parsed = StandardsDocumentSchema.parse(JSON.parse(content));
  if (new Set(parsed.standards.map(standard => `${standard.categoryId}\0${standard.productTypeId}`)).size !== parsed.standards.length ||
      parsed.standards.some(standard => new Set(standard.requirements.map(requirement => requirement.id)).size !== standard.requirements.length)) {
    throw new Error('Listing standards contain duplicate classification pairs or requirement IDs.');
  }
  return parsed;
}
export function listListingStandards(workspacePath: string): { standards: ListingCompletenessStandard[]; documentHash: string | null; bundleHash: string } {
  const current = readListingStandardsFile(workspacePath);
  return { ...parseDocument(current.content), documentHash: current.hash, bundleHash: current.bundleHash };
}

export function findListingStandard(workspacePath: string, categoryId: string, productTypeId: string): ListingCompletenessStandard | null {
  return listListingStandards(workspacePath).standards.find(standard => standard.categoryId === categoryId && standard.productTypeId === productTypeId) ?? null;
}

export function previewListingStandard(input: {
  workspacePath: string; actor: string; standardId: string; categoryId: string; productTypeId: string;
  requirements: ListingRequirement[];
}): { standard: ListingCompletenessStandard; documentHash: string | null; bundleHash: string } {
  const current = readListingStandardsFile(input.workspacePath);
  const document = parseDocument(current.content);
  if (document.standards.some(standard => standard.id !== input.standardId &&
    standard.categoryId === input.categoryId && standard.productTypeId === input.productTypeId)) {
    throw new Error('A listing standard already exists for this classification pair; update its existing standard ID.');
  }
  const previous = document.standards.find(standard => standard.id === input.standardId);
  for (const requirement of input.requirements) ListingRequirementSchema.parse(requirement);
  if (new Set(input.requirements.map(requirement => requirement.id)).size !== input.requirements.length) throw new Error('Listing standard requirement IDs must be unique.');
  const standardHash = hashCanonicalJson({
    categoryId: input.categoryId, productTypeId: input.productTypeId,
    requirements: [...input.requirements].sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, field, kind, required, exceptionEligible, allowedSourceRoles, applicableWhen }) =>
        ({ id, field, kind, required, exceptionEligible, allowedSourceRoles: [...allowedSourceRoles].sort(), applicableWhen })),
  });
  const standard = ListingCompletenessStandardSchema.parse({
    recordVersion: 1, id: input.standardId, revision: (previous?.revision ?? 0) + 1,
    categoryId: input.categoryId, productTypeId: input.productTypeId,
    requirements: input.requirements, standardHash, approvedBy: input.actor, approvedAt: new Date().toISOString(),
  });
  return { standard, documentHash: current.hash, bundleHash: current.bundleHash };
}

export async function applyListingStandard(input: {
  workspacePath: string; actor: string; expectedDocumentHash: string | null; expectedBundleHash: string;
  standardId: string; categoryId: string; productTypeId: string; requirements: ListingRequirement[];
}): Promise<{ standard: ListingCompletenessStandard; commitHash: string | null }> {
  const current = readListingStandardsFile(input.workspacePath);
  if (current.hash !== input.expectedDocumentHash || current.bundleHash !== input.expectedBundleHash) throw new Error('Listing standards changed since preview.');
  const preview = previewListingStandard({ ...input, actor: input.actor });
  const document = parseDocument(current.content);
  const standards = document.standards.filter(standard => standard.id !== preview.standard.id);
  standards.push(preview.standard);
  standards.sort((a, b) => a.categoryId.localeCompare(b.categoryId) || a.productTypeId.localeCompare(b.productTypeId));
  const content = `${JSON.stringify({ recordVersion: 1, standards }, null, 2)}\n`;
  const result = await writeListingStandardsFile(input.workspacePath, input.expectedBundleHash, input.expectedDocumentHash, content, `Update listing completeness standard ${preview.standard.id}`);
  return { standard: preview.standard, commitHash: result.commitHash };
}
