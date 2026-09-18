// Tier 1 validating forward proxy (#237).
//
// Host-side egress gate for the render container: the container's proxy env
// points here, and this proxy validates EVERY request through the broker
// policy (approved hosts, path policy, public DNS per hop, content types,
// byte budgets) before forwarding it via `broker.fetch`. The proxy adds no
// policy of its own — one validation path, two entry shapes (direct
// broker.fetch for Tier 0, proxy-form GET for the render container).
//
// Denials (all fail closed, operator-safe codes, no upstream detail leaks):
// - opaque CONNECT tunnels refused (mirrors the broker: tunnels hide
//   method/path/body from validation — never sufficient);
// - non-GET methods refused; absolute-form target required;
// - broker validation failures relayed as 502 with the broker code only;
// - byte-budget overruns stop the relay mid-stream (broker ceiling) and
//   surface as 502 response_too_large.
//
// Lifecycle: `startRenderProxy` binds 127.0.0.1 on an ephemeral port and
// returns the proxy URL for the render spec plus `close()`. One proxy per
// render run; the harness closes it in a finally (no cross-run proxy).
//
// Network-surface note for the containment audit: this module plus
// `broker.ts` are the ONLY investigation modules with network surface. This
// proxy's sole upstream is `broker.fetch(` (asserted statically); its
// `node:http` surface is the inbound server socket (createServer), never a
// direct upstream client.

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { InvestigationBroker, scopeFromSampleUrls, type BrokerDeps } from './broker';
import { BudgetLedger } from './budgets';
import type { InvestigationBudget } from '../../shared/schemas/browser-investigation';

interface RenderProxyOptions {
  investigationId: string;
  workspaceId: string;
  sampleUrls: string[];
  budget: InvestigationBudget;
  ledger: BudgetLedger;
  brokerDeps?: BrokerDeps;
  /**
   * Interface to bind. Default 127.0.0.1 (hermetic, test-friendly). The
   * harness binds the wildcard interface so the render container can
   * reach the proxy via the host-gateway alias — validation stays the
   * boundary (every request is broker-scoped and budgeted), not the bind.
   */
  bindHost?: string;
  /**
   * Host name advertised in the proxy URL. Default is the bind host. The
   * harness advertises `host.docker.internal` (argv carries the matching
   * `--add-host` alias); direct test callers keep the loopback default.
   */
  advertiseHost?: string;
}

interface RunningRenderProxy {
  /** Proxy URL for the render spec env (advertised host + ephemeral port). */
  url: string;
  close(): Promise<void>;
}

const PROXY_SERVER_TIMEOUT_MS = 30_000;

/**
 * Start the per-run validating forward proxy. Resolves when bound; rejects
 * (never half-bound) when the loopback cannot be bound.
 */
export function startRenderProxy(opts: RenderProxyOptions): Promise<RunningRenderProxy> {
  const scope = scopeFromSampleUrls(opts.investigationId, opts.workspaceId, opts.sampleUrls);
  const broker = new InvestigationBroker(scope, opts.budget, opts.brokerDeps, opts.ledger);
  const server = http.createServer((req, res) => {
    void handleProxyRequest(req, res, broker).catch(() => {
      // handleProxyRequest always ends the response; this is a backstop.
      try {
        if (!res.writableEnded) {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('proxy_failed');
        }
      } catch {
        // Best-effort: never throw out of the request handler.
      }
    });
  });
  server.timeout = PROXY_SERVER_TIMEOUT_MS;
  const bindHost = opts.bindHost ?? '127.0.0.1';
  const advertiseHost = opts.advertiseHost ?? bindHost;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, bindHost, () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address.port !== 'number') {
        void closeServer(server).finally(() => {
          reject(new Error('proxy_failed: validating proxy bound without a port'));
        });
        return;
      }
      resolve({
        url: `http://${advertiseHost}:${address.port}`,
        close: () => closeServer(server),
      });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function handleProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  broker: InvestigationBroker,
): Promise<void> {
  // Opaque tunnels hide method/path/body from the broker — refused outright.
  if ((req.method ?? '').toUpperCase() === 'CONNECT') {
    deny(res, 405, 'opaque_tunnel_refused');
    return;
  }
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    deny(res, 405, 'method_forbidden');
    return;
  }
  // Forward-proxy form carries the absolute URI; origin-form without a Host
  // cannot be validated to an approved host.
  const target = (req.url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) {
    deny(res, 400, 'invalid_url');
    return;
  }
  // Drain any request body (GETs should carry none; never parse it).
  req.resume();
  try {
    // The single upstream: broker-mediated GET (policy + budgets enforced).
    const fetched = await broker.fetch(target);
    res.writeHead(fetched.status, {
      'content-type': fetched.contentType,
      'content-length': fetched.body.length,
    });
    res.end(fetched.body);
  } catch (err) {
    deny(res, 502, proxyCodeOf(err));
  }
}

function deny(res: http.ServerResponse, status: number, code: string): void {
  try {
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(code);
  } catch {
    // Best-effort: the socket may already be gone.
  }
}

/** Operator-safe relay code only: broker codes pass through, anything else is a plain fetch failure. */
function proxyCodeOf(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && /^[a-z_]+$/.test(code) && code.length <= 40) return code;
  return 'fetch_failed';
}
