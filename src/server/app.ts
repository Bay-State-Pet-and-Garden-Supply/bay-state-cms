import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { errorHandler } from './middleware/error-handler';
import healthRoute from './routes/health';
import workspaceRoutes from './routes/workspace-routes';
import bootstrapRoutes from './routes/bootstrap-routes';
import productRoutes from './routes/product-routes';
import changeSetRoutes from './routes/change-set-routes';
import fieldRegistryRoutes from './routes/field-registry-routes';
import connectionRoutes from './routes/connection-routes';
import exportRoutes from './routes/export-routes';
import syncRoutes from './routes/sync-routes';
import driftRoutes from './routes/drift-routes';
import pageRoutes from './routes/page-routes';
import dashboardRoutes from './routes/dashboard-routes';
import onboardingRoutes from './routes/onboarding-routes';
import onboardingWorkRoutes from './routes/onboarding-work-routes';
import onboardingStageReadRoutes from './routes/onboarding-stage-read-routes';
import distributorRoutes from './routes/distributor-routes';
import classificationRoutes from './routes/classification-routes';
import storeManagerRoutes from './routes/store-manager-routes';
import catalogRoutes from './routes/catalog-routes';
import catalogClassificationRoutes from './routes/catalog-classification-routes';
import embeddingRoutes from './routes/embedding-routes';
import benchmarkRoutes from './routes/benchmark-routes';
import { sitemapRoutes } from './routes/sitemap-routes';
import { brandHubRoutes } from './routes/brand-hub-routes';
import { brandStrategyRoutes } from './routes/brand-strategy-routes';
import { preparationGapRoutes } from './routes/preparation-gap-routes';
import { strategyCollectionRoutes } from './routes/strategy-collection-routes';
import { domainProfileStateRoutes } from './routes/domain-profile-state-routes';
import { representativeSuiteRoutes } from './routes/representative-suite-routes';
import { profileCaptureRoutes } from './routes/profile-capture-routes';
import { profileActivationRoutes } from './routes/profile-activation-routes';
import { inventoryPickerRoutes } from './routes/inventory-picker-routes';
import { profileBuilderGenerateDraftRoutes } from './routes/profile-builder-generate-draft-routes';
import { profileMatrixRoutes } from './routes/profile-matrix-routes';
import releaseRoutes from './routes/release-routes';
import { getCurrentWorkspace } from './services/workspace-service';
import { timingSafeCompare } from '../shared/timing-safe';

const app = new Hono();

// API token middleware
// When BAYSTATE_CMS_API_TOKEN is set, all mutating (non-GET) requests must include
// an Authorization: Bearer <token> header matching the configured token.
const apiToken = process.env.BAYSTATE_CMS_API_TOKEN;
if (apiToken) {
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      await next();
      return;
    }
    const auth = c.req.header('Authorization') ?? '';
    if (!timingSafeCompare(auth, `Bearer ${apiToken}`)) {
      return c.json({ error: 'Unauthorized. Provide a valid API token via Authorization: Bearer header.' }, 401);
    }
    await next();
  });
}

// Restricted CORS - only allow local UI origins
app.use('*', cors({
  origin: [
    'http://localhost:3031',
    'http://127.0.0.1:3031',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ],
  credentials: true,
}));

// Autoload middleware to ensure database is initialized on demand
app.use('/api/*', async (c, next) => {
  getCurrentWorkspace();
  await next();
});

app.onError(errorHandler);

// Routes
app.route('/api', healthRoute);
app.route('/api', workspaceRoutes);
app.route('/api', bootstrapRoutes);
app.route('/api', productRoutes);
app.route('/api', changeSetRoutes);
app.route('/api', fieldRegistryRoutes);
app.route('/api', connectionRoutes);
app.route('/api', exportRoutes);
app.route('/api', syncRoutes);
app.route('/api', driftRoutes);
app.route('/api', pageRoutes);
app.route('/api', dashboardRoutes);
app.route('/api', onboardingRoutes);
app.route('/api', onboardingWorkRoutes);
// Slice 1: dedicated v2 stage reads (read-only; same /api middleware).
app.route('/api', onboardingStageReadRoutes);
app.route('/api', distributorRoutes);
app.route('/api', classificationRoutes);
app.route('/api', storeManagerRoutes);
app.route('/api', catalogRoutes);
app.route('/api', catalogClassificationRoutes);
app.route('/api', embeddingRoutes);
// Mounted exactly once under /api; route internals use /benchmark/... paths.
app.route('/api', benchmarkRoutes);
app.route('/api', sitemapRoutes);
app.route('/api', brandHubRoutes);
app.route('/api', brandStrategyRoutes);
app.route('/api', preparationGapRoutes);
app.route('/api', strategyCollectionRoutes);
app.route('/api', domainProfileStateRoutes);
app.route('/api', representativeSuiteRoutes);
app.route('/api', profileCaptureRoutes);
app.route('/api', profileActivationRoutes);
app.route('/api', inventoryPickerRoutes);
app.route('/api', profileBuilderGenerateDraftRoutes);
app.route('/api', profileMatrixRoutes);
// P4: taxonomy release status + sanctioned pin activation (sole state.json writer).
app.route('/api', releaseRoutes);

// 404 handler
app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
