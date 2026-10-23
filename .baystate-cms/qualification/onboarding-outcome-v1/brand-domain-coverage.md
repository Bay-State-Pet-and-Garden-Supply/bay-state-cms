# Development brand-signal and domain coverage

Read-only inventory of the 169 rows in `inputs/development-input.json`, joined to operator-attested hints in `scratch/run-comparison.ts` and local `brand_sites` in `storage/catalog/.shopsite-cms/app.db`. The database was opened read-only. No dispatch, credentials, paid calls, or writes were used.

The brand signal column is the initial register-name token, uppercase; it is only a grouping signal, not brand truth. Attestation is determined solely from exact row-ID hints (`DEV-0015`/`0014` WOOF, `0019` BENEBONE, `0001`/`0002` KONG, `0005` DR MARTY). For attested rows, the attested spelling is the lookup candidate. For unattested rows, the signal token is only a tentative candidate for discovery; it does not become an attested brand. Domain matches normalize case and remove punctuation. Row counts count development rows grouped by signal.

| Brand signal / candidate | Attested? | Mapped domains in `brand_sites` | Rows |
|---|---|---|---:|
| ADAMS | No | — | 1 |
| BASKERVILLE | No | companyofanimals.com | 1 |
| BENEBONE | Yes | benebone.com | 6 |
| BETTER | No | — | 11 |
| BIRD | No | — | 4 |
| BLUE | No | bluebuffalo.com | 3 |
| BONIDE | No | bonide.com | 2 |
| BUTCHERS | No | — | 7 |
| CHARLEE | No | — | 2 |
| COOP | No | — | 1 |
| DR MARTY | Yes | drmartypets.com | 14 |
| EARTH | No | — | 6 |
| ECOCYCLE | No | — | 1 |
| FINLEYS | No | — | 1 |
| FIRSTMATE | No | firstmate.com | 1 |
| FRESH | No | — | 1 |
| HALTER | No | — | 2 |
| HONEST | No | — | 4 |
| HUMMZINGER | No | — | 2 |
| INSTINCT | No | instinctpetfood.com | 3 |
| JOLLY | No | — | 3 |
| KOHA | No | kohapet.com | 2 |
| KONG | Yes | kongcompany.com | 13 |
| LOVING | No | — | 5 |
| MEGA | No | — | 1 |
| MISSING | No | — | 1 |
| NUTRIGOOD | No | — | 1 |
| NYLABONE | No | nylabone.com | 4 |
| OC | No | — | 1 |
| OPEN | No | — | 7 |
| PAWNUT | No | — | 4 |
| POLKADOG | No | polkadog.com | 2 |
| PURE | No | — | 12 |
| PYRANHA | No | — | 1 |
| SAINT | No | — | 2 |
| SCIENCE | No | — | 1 |
| SEVIN | No | — | 1 |
| SLOW | No | — | 3 |
| SNIF | No | — | 6 |
| SPOT | No | ethicalpet.com | 1 |
| STELLA | No | — | 1 |
| TEMPTATIONS | No | temptationstreats.com | 2 |
| UNSWEETENED | No | — | 1 |
| WELLNESS | No | wellnesspetfood.com | 2 |
| WOOF | Yes | mywoof.com | 14 |
| YELLIW | No | — | 1 |
| YOW | No | — | 3 |
| ZYMOX | No | — | 1 |

**First-token risk:** Every “No” row is unattested, even where a candidate token matched a database spelling/domain. Do not promote these token-derived candidates to brand identity. In particular, `PURE` covers 12 rows but is not an attested brand signal; the source explicitly documents DEV-0039 “PURE” as actually NutriSource and deliberately supplies no hint. Thus the grouped PURE signal is not evidence for a PURE brand mapping. No hints were invented for other signals.
