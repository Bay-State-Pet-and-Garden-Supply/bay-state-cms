// story: e08 Build slice — suite-based Generate draft (3 confirmed captures)
import { Hono } from 'hono';
import { z } from 'zod';
import { generateSelectorsFromSuite } from '../services/profile-builder/generateSelectorsService';

const BodySchema = z.object({
  suiteUrls: z.array(z.string().url()).min(1).max(3),
  snapshotHtmls: z.array(z.string()).min(1).max(3),
  sourceUrl: z.string().url().optional(),
  runtime: z.enum(['static', 'rendered']).default('rendered'),
});

export const profileBuilderGenerateDraftRoutes = new Hono();

profileBuilderGenerateDraftRoutes.post('/profile-builder/generate-draft', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid suite payload', details: parsed.error.format() }, 400);
  const { suiteUrls, snapshotHtmls, sourceUrl, runtime } = parsed.data;
  const htmlRefs = suiteUrls;
  try {
    const result = await generateSelectorsFromSuite(
      {
        htmlRefs,
        snapshotHtmls,
        sourceUrl: sourceUrl ?? suiteUrls[0] ?? '',
        runtime,
        fields: [
          { key: 'titleSelector', label: 'Title', origin: 'core', valueType: 'text', multiple: false },
          { key: 'descriptionSelector', label: 'Description', origin: 'core', valueType: 'text', multiple: false },
          { key: 'brandSelector', label: 'Brand', origin: 'core', valueType: 'text', multiple: false },
          { key: 'imagesSelector', label: 'Images', origin: 'core', valueType: 'image', multiple: true },
        ],
        snapshotContext: undefined,
      } as unknown as never,
      { userId: 'operator', requestId: c.req.header('x-request-id') ?? 'req-' + Date.now() },
    );
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { name?: string }).name === 'LlmNotConfiguredError' ? 'LLM_NOT_CONFIGURED' : 'GENERATE_FAILED';
    return c.json({ error: msg, code, retryable: code !== 'LLM_NOT_CONFIGURED' }, 500);
  }
});
