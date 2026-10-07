# Generation-1 freeze plan (119 adjudicated rows)

Status: PLAN — familyIds joined from bank records; split proposed, not
applied. Application happens at freeze with peer receipt.

## Join results (verified 2026-10-07)

- All 119 SKUs resolve to bank familyIds; 119 distinct families, zero
  multi-row families, zero duplicate SKUs.
- Split rule: `sha256(familyId) mod 5 == 0 → holdout`, else dev
  (deterministic, family-atomic, kind-blind).
- Proposed: dev 93 (76 known + 17 no-fit) / holdout 26 (19 known + 7
  no-fit). Both kinds represented on both sides; no family spans splits.

## Freeze steps

1. Apply real familyIds + proposed splits to the three gold files
   (amendment commit, status notes).
2. Peer receipt: independent re-derivation of counts, hashes, and the
   split (v9 process: 0 model calls, hash-commits gold).
3. Subsequent batches (batch-3+) join the same generation ONLY if their
   families are disjoint from these 119 AND from the sealed holdout
   custody (55+ families across pilot/kong/wave2/drearth/petfood banks).
   Otherwise they open generation-2.
