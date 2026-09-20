import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { profileInspectRoutes } from '../../server/routes/profile-inspect-routes';
import { unlinkSync } from 'node:fs';

describe('Profile Inspect Routes - Domain Implied Brand Context', () => {
  const testDbPath = '/tmp/baystate-cms-profile-inspect-routes-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  beforeEach(() => {
    const db = getDb();
    db.query('DELETE FROM brand_sites').run();
  });

  it('POST /domains/:domain/profile/inspect resolves brand from brand_sites DB context when brandHint is omitted', async () => {
    upsertBrandSite('Earthbath', 'earthbath.com');

    const htmlNoBrand = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Earthbath Oatmeal &amp; Aloe Dog Shampoo 16oz</title>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org/",
            "@type": "Product",
            "name": "Earthbath Oatmeal & Aloe Dog Shampoo 16oz",
            "sku": "EB-OAT-16",
            "gtin12": "748405001018"
          }
          </script>
        </head>
        <body>
          <h1>Earthbath Oatmeal &amp; Aloe Dog Shampoo 16oz</h1>
        </body>
      </html>
    `;

    const res = await profileInspectRoutes.request(
      '/domains/earthbath.com/profile/inspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://earthbath.com/products/oatmeal-shampoo',
          html: htmlNoBrand,
        }),
      },
    );

    expect(res.status).toBe(200);
    const result = await res.json() as any;

    expect(result.fields.brand.value).toBe('earthbath');
    expect(result.fields.brand.source).toBe('brand-hint');
    expect(result.fields.brand.status).toBe('extracted');
    expect(result.exceptionQueue.some((e: any) => e.category === 'missing' && e.field === 'brand')).toBe(false);
  });

  it('POST /domains/:domain/profile/validate-siblings resolves brand from brand_sites DB context for sibling URLs', async () => {
    upsertBrandSite('Earthbath', 'earthbath.com');

    const siblingHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <script type="application/ld+json">
          {
            "@context": "https://schema.org/",
            "@type": "Product",
            "name": "Earthbath Puppy Shampoo 16oz"
          }
          </script>
        </head>
        <body><h1>Earthbath Puppy Shampoo 16oz</h1></body>
      </html>
    `;

    const res = await profileInspectRoutes.request(
      '/domains/earthbath.com/profile/validate-siblings',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siblingUrls: ['https://earthbath.com/products/puppy-shampoo'],
          siblingHtmls: {
            'https://earthbath.com/products/puppy-shampoo': siblingHtml,
          },
        }),
      },
    );

    expect(res.status).toBe(200);
    const result = await res.json() as any;

    expect(result.ok).toBe(true);
    expect(result.passedCount).toBe(1);
    expect(result.results[0].inspection.fields.brand.value).toBe('earthbath');
    expect(result.results[0].inspection.fields.brand.source).toBe('brand-hint');
  });
});
