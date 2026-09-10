import type { ApprovedBrandStrategy } from '../../shared/schemas/brand-strategy';
import { saveBrandStrategy, type SaveBrandStrategyInput } from '../../db/repositories/brand-strategy-approval-repo';

/**
 * Builder slice B1: thin application command for brand strategy Saves.
 *
 * Both builder surfaces call this single path (via the existing approve
 * route). The transactional repository command owns validation against
 * current persisted configuration, configuration changes, revision CAS, and
 * approval persistence. Repository functions remain the only SQL owners.
 */
export function saveBrandStrategyCommand(
  workspaceId: string,
  input: SaveBrandStrategyInput,
): ApprovedBrandStrategy {
  return saveBrandStrategy(workspaceId, input);
}
