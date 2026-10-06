import { describe, expect, it } from 'vitest';
import { ShopSiteHttpClient } from '../../shopsite/shopsite-http-client';

/**
 * Verified against the live store: `db_xml.cgi`'s `fields=` allowlist does not
 * recognize `ProductFieldN` names — a filtered request silently returns only
 * the identity fields and drops every custom field. The client must refuse
 * instead of returning that misleading subset.
 */
describe('ShopSiteHttpClient db_xml field allowlist', () => {
  const client = () => new ShopSiteHttpClient({
    cgiBaseUrl: 'https://store.example.com/cgi-bin/bo/db_xml.cgi',
    merchantId: 'merchant',
    password: 'secret',
  });

  it('refuses a ProductFieldN subset request before any network call', async () => {
    const res = await client().fetchProductsXml({ fields: ['SKU', 'Name', 'ProductField16'] });
    expect(res.success).toBe(false);
    expect(res.error).toContain('unsupported_fields_filter');
    expect(res.error).toContain('ProductField16');
    expect(res.data).toBeUndefined();
  });

  it('fails pages requests that attempt a ProductFieldN subset too', async () => {
    const res = await client().fetchPagesXml({ fields: ['Name', 'ProductField24'] });
    expect(res.success).toBe(false);
    expect(res.errors[0]).toContain('ProductField24');
  });
});
