# 0043 — Input Price Authority and Manager Plain Language

Status: accepted.
**Supersedes:** price-extraction provisions in ADR 0031 and any earlier plan that permits third-party page prices to populate product prices.
The Store Manager is the primary user. Workflows must assume no technical background: explain what is happening and the next action in ordinary words, without requiring familiarity with AI, Git, syncing, or internal processing. Use the human-facing terms in CONTEXT's Store Manager Operating Model; reserve technical detail for diagnostics and setup screens.

Price is immutable input: the spreadsheet or manual onboarding price carries byte-for-byte to the draft and never changes. Third-party pages are never used to collect, validate, supplement, compare, or replace a price. Variant matching uses identity evidence only.
