// fallow-ignore-file unused-export

import { z } from 'zod';


export const ChangeSetSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().min(1, 'Title is required'),
  description: z.string().nullable().default(null),
  status: z.enum(['draft', 'reviewing', 'approved', 'pushed', 'discarded']).default('draft'),
  baseCommit: z.string(),
  approvedCommit: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  approvedAt: z.string().nullable().default(null),
});

export const ChangeSetItemSchema = z.object({
  id: z.string(),
  changeSetId: z.string(),
  sku: z.string().min(1, 'SKU is required'),
  operation: z.enum(['create', 'update', 'archive']),
  draftJson: z.string(),
  baseJson: z.string().nullable().default(null),
  draftHash: z.string(),
  validationStatus: z.enum(['unknown', 'valid', 'blocked', 'warning']).default('unknown'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ── Linked/consistency-group approval manifest (issue #363) ────────────────
// Structural contract only: full changed-product write set + unchanged-member
// read dependencies with true approved bases, exact product/native-reference
// hashes, and workspace ownership. No model or family semantics.

export const LinkedManifestWriteSchema = z.object({
  sku: z.string(),
  operation: z.string(),
  filePath: z.string(),
  draftHash: z.string(),
  productHash: z.string(),
  nativeReferenceHash: z.string(),
  baseHash: z.string().nullable(),
  baseApprovedCommit: z.string().nullable(),
  pageNames: z.array(z.string()),
});

export const LinkedManifestReadSchema = z.object({
  sku: z.string(),
  filePath: z.string(),
  productHash: z.string(),
  nativeReferenceHash: z.string(),
  lastApprovedCommit: z.string().nullable(),
});

export const LinkedManifestSchema = z.object({
  version: z.literal(1),
  changeSetId: z.string(),
  workspaceId: z.string(),
  baseCommit: z.string(),
  writes: z.array(LinkedManifestWriteSchema),
  reads: z.array(LinkedManifestReadSchema),
  createdAt: z.string(),
});

export type LinkedManifest = z.infer<typeof LinkedManifestSchema>;
export type LinkedManifestWrite = z.infer<typeof LinkedManifestWriteSchema>;
export type LinkedManifestRead = z.infer<typeof LinkedManifestReadSchema>;

export type ChangeSet = z.infer<typeof ChangeSetSchema>;
export type ChangeSetItem = z.infer<typeof ChangeSetItemSchema>;
