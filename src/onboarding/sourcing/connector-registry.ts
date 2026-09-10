import type { DistributorConnector } from './contracts';
import type { SourcingConnectorType } from './contracts';
import { PhillipsConnector, type PhillipsConnectorConfig } from './connectors/phillips';
import { BCIConnector, type BCIConnectorConfig } from './connectors/bci';
import { BradleyConnector } from './connectors/bradley';
import { CentralPetConnector } from './connectors/central-pet';
import { OrgillConnector } from './connectors/orgill';
import { PetFoodExpertsConnector } from './connectors/pet-food-experts';
import { PhillipsStorefrontConnector } from './connectors/phillips-storefront';

/**
 * Connector registry (ADR 0014). Maps a connection's `connectorType` +
 * `distributorId` PAIR to a connector implementation. Connectors are created
 * per invocation with the connection's NON-secret configuration (base URLs,
 * page caps, timeouts) — credentials never cross this boundary.
 *
 * Identity is an exact (connectorType, distributorId) pair; no pair can
 * silently collide or fall back. M1 registers the two Phase 1 REST adapters
 * (`api + phillips`, `api + bci`, plus their declared compatibility aliases)
 * and M3 registers the tier-1 public Distributor Scraper connectors
 * (`html_scraper + bradley`, `html_scraper + central_pet`) and M4 registers
 * the tier-2 authenticated scraper (`html_scraper + orgill`). `ftp_catalog`,
 * `csv`, `legacy_adapter`, and unregistered `html_scraper` pairs
 * (pet_food_experts, phillips_storefront — M4b) return null — the engine
 * skips such connections with a stable `connector_not_registered` reason
 * (never a silent fallback).
 */
export interface ConnectorRegistry {
  createConnector(
    connectorType: SourcingConnectorType,
    distributorId: string,
    configuration: Record<string, unknown>,
  ): DistributorConnector | null;
}

/**
 * Exact distributor-id allowlist for Phase 1 `api` connectors. An unknown
 * distributor id is NEVER silently mapped to a connector (fail closed):
 * the engine skips it as connector_not_registered. Aliases are declared
 * EXPLICITLY and only where the historical connection rows used them.
 */
const API_CONNECTOR_BY_DISTRIBUTOR: Readonly<Record<string, 'phillips' | 'bci'>> = {
  phillips: 'phillips',
  endless_aisles: 'phillips',
  bci: 'bci',
  ordercloud: 'bci',
};

function normalizeDistributorId(raw: string): string {
  return String(raw ?? '').trim().toLowerCase();
}

/**
 * Builder slice B1: known distributor ids the registry can serve (pure
 * metadata — never starts a connector, resolves no secret). Used to reject
 * invented distributor ids in strategy Saves while still displaying
 * retained-but-unknown approved refs as unavailable.
 */
export function listSupportedDistributorIds(): string[] {
  return [
    ...Object.keys(API_CONNECTOR_BY_DISTRIBUTOR),
    'bradley',
    'central_pet',
    'orgill',
    'pet_food_experts',
    'phillips_storefront',
  ];
}

export function isSupportedDistributorId(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  return listSupportedDistributorIds().includes(normalizeDistributorId(raw));
}

/**
 * Amendment B (M2): public Distributor Scraper pairs that run WITHOUT a
 * secret. Everything else fails closed to `true` (a secret is required) —
 * an unknown pair is never presented as secretly healthy. This drives the
 * server/client connection view (`secretRequired`) so the UI can truthfully
 * display “no secret required” for public storefronts instead of a
 * misleading “secret missing”.
 */
const PUBLIC_SCRAPER_DISTRIBUTORS: Readonly<Record<string, boolean>> = {
  bradley: true,
  central_pet: true,
};

export function connectorRequiresSecret(connectorType: SourcingConnectorType, distributorId: string): boolean {
  if (
    connectorType === 'html_scraper' &&
    PUBLIC_SCRAPER_DISTRIBUTORS[normalizeDistributorId(distributorId)]
  ) {
    return false;
  }
  return true;
}

export class DefaultConnectorRegistry implements ConnectorRegistry {
  createConnector(
    connectorType: SourcingConnectorType,
    distributorId: string,
    configuration: Record<string, unknown>,
  ): DistributorConnector | null {
    switch (connectorType) {
      case 'api': {
        const kind = API_CONNECTOR_BY_DISTRIBUTOR[normalizeDistributorId(distributorId)];
        if (!kind) return null;
        if (kind === 'bci') {
          return new BCIConnector(configuration as BCIConnectorConfig);
        }
        return new PhillipsConnector(configuration as PhillipsConnectorConfig);
      }
      case 'ftp_catalog':
      case 'csv':
      case 'legacy_adapter':
        return null;
      case 'html_scraper': {
        const id = normalizeDistributorId(distributorId);
        // Tier-1 public storefronts (M3) + tier-2 authenticated connectors
        // (M4a orgill; M4b pet_food_experts + phillips_storefront).
        if (id === 'bradley') {
          return new BradleyConnector();
        }
        if (id === 'central_pet') {
          return new CentralPetConnector();
        }
        if (id === 'orgill') {
          return new OrgillConnector();
        }
        if (id === 'pet_food_experts') {
          return new PetFoodExpertsConnector();
        }
        if (id === 'phillips_storefront') {
          return new PhillipsStorefrontConnector();
        }
        return null;
      }
    }
  }
}

/** Test seam: registry that always returns a fixed connector. */
export class FixedConnectorRegistry implements ConnectorRegistry {
  constructor(private readonly connector: DistributorConnector | null) {}
  createConnector(
    _connectorType?: SourcingConnectorType,
    _distributorId?: string,
    _configuration?: Record<string, unknown>,
  ): DistributorConnector | null {
    return this.connector;
  }
}
