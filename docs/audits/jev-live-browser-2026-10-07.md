# Live-browser full-path verification — #302 bullet 1 (2026-10-07)

Read-only pass (no approvals, no promotions, no writes). Dev servers:
API 127.0.0.1:3030 (200), Vite 127.0.0.1:5173 (200). Real Chromium tab.

## What was verified live

1. **Overview**: 22,108 SKUs, 94 in-sync; pipeline stages render.
2. **Settings → General**: ShopSite CGI connection configured
   (baystatepet endpoint, merchant ID set, password configured).
3. **Settings → AI Routes**: provider connections live —
   DeepSeek Cloud online (auth, 2 models), Ollama local online
   (5 models), OpenAI Cloud online (auth, 133 models), TypeSafe Jev
   ×2 online (auth, typed-judgment, api.typesafe.ai pinned).
   Catalog Default → DeepSeek (`deepseek-v4-flash`); privacy
   boundaries set (Cloud Allowed for text + packaging images).
4. **Onboarding → Jev Canary — goldset-16** (active, RUNNING,
   12 products): stage counts Identify 0 / Find page 0 / Collect 0 /
   Prepare 6 / Review 6 / Drafts 0.
5. **Review listings (6 needing review)**: family grouping (👪),
   official-page sourcing, warning flags, readiness fractions;
   Needs review (6) / Reviewed (0) / Approved (0).
6. **Review detail** (QUAL-DOG-KIBBLE-02): Product Identification
   (UPC, register name, more-info file, source), Product Listing
   (name/brand/weight/price/quantity, primary image), action bar
   (Looks Good & Next, Prev, Next, Send to Curation).

## Not done here (owner-gated)

No review approvals, no promotions, no route changes — final human
sign-off and canary progression (bullet 6) remain owner actions.
Live candidate capture needs owner-provisioned TYPESAFE_API_KEY
(absent in this environment); deterministic floor only.
