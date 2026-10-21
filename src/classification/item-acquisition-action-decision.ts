import { TYPESAFE_EVALUATED_MODEL, assertSystemOneModelMatch, dispatchSystemOne } from '../ai/systemone-transport';
import { assertConnectionEnabledForDispatch, type ProviderConnection } from '../ai/provider-connections';
import { completeModelCall, insertModelCallStart, insertTerminalModelCall } from '../db/repositories/classification-model-call-repo';
import { getFullAiRoutingConfig } from '../db/repositories/provider-connection-repo';
import { hashCanonicalJson } from '../shared/stable-id';
import { MODEL_CALL_STATUS, PROMPT_TEMPLATE_VERSIONS, RULE_VERSIONS } from './model-operation-registry';
import { ModelPolicyDeniedError, assertModelPolicyIntact, resolveModelRoute, type ModelPolicyView, type ModelRoute } from './model-policy-gateway';
import { HeartbeatLostError } from './heartbeat-errors';
import { buildChoiceKeyMaps, findSystemOneConnection, protectedSystemOneDispatchOptions, resolveSystemOneCredential } from './systemone-decision-core';

export const ITEM_ACQUISITION_ACTION_OPERATION = 'item_acquisition_action_selection' as const;
export interface ItemAcquisitionActionOption {
  id: string;
  kind: 'search' | 'observe' | 'links' | 'variants' | 'accordion';
  label: string;
  candidateId?: string;
}
export interface ItemAcquisitionActionDecision {
  status: 'selected' | 'abstain' | 'unavailable' | 'stale';
  actionId: string | null;
  modelCallIds: string[];
  inputTokens?: number;
  outputTokens?: number;
  reason: string;
}

/** Preflight the same frozen TypeSafe-only route before any paid search effect. */
export function checkItemAcquisitionActionRoute(policy: ModelPolicyView | null): { status: 'available'; provider: string; model: string } | { status: 'unavailable'; reason: string } {
  if (!policy) return { status: 'unavailable', reason: 'Frozen TypeSafe model policy is unavailable; configure the evaluated TypeSafe route before supplemental actions.' };
  try {
    assertModelPolicyIntact(policy);
    const route = resolveModelRoute(policy, ITEM_ACQUISITION_ACTION_OPERATION, {
      getCredential: provider => resolveSystemOneCredential(provider),
      defaultBaseUrls: { typesafe: 'https://api.typesafe.ai/v1' },
    });
    const configured = findSystemOneConnection(getFullAiRoutingConfig().connections, route.provider);
    const connection = (configured ?? {
      id: route.provider, label: 'TypeSafe Jev', transport: 'systemone' as const,
      baseUrl: route.baseUrl, trustZone: 'cloud' as const, credential: route.apiKey, enabled: true,
    }) as ProviderConnection;
    if (connection.transport !== 'systemone') throw new Error('acquisition_action_requires_systemone_transport');
    const model = route.model || TYPESAFE_EVALUATED_MODEL;
    assertConnectionEnabledForDispatch(connection, model);
    return { status: 'available', provider: route.provider, model };
  } catch (error) {
    if (error instanceof HeartbeatLostError) throw error;
    return { status: 'unavailable', reason: error instanceof ModelPolicyDeniedError
      ? `TypeSafe policy denied action selection (${error.code}); review model policy and credentials.`
      : 'No usable frozen TypeSafe route for action selection; review AI Compute policy and connection settings.' };
  }
}

/** Select only one already-enumerated bounded action; typed output cannot provide executable data. */
export async function decideItemAcquisitionAction(input: {
  runId: string;
  itemId: string;
  sku: string;
  itemName: string;
  missingFields: readonly string[];
  actions: readonly ItemAcquisitionActionOption[];
  modelPolicy: ModelPolicyView | null;
  assertHeld?: () => void;
}): Promise<ItemAcquisitionActionDecision> {
  if (!input.actions.length) return { status: 'abstain', actionId: null, modelCallIds: [], reason: 'No approved bounded actions are available.' };
  const seen = new Set<string>();
  for (const action of input.actions) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(action.id) || seen.has(action.id) || !action.label.trim()) {
      return { status: 'stale', actionId: null, modelCallIds: [], reason: 'The supplied action set is invalid or stale.' };
    }
    seen.add(action.id);
  }
  if (!input.modelPolicy) return { status: 'unavailable', actionId: null, modelCallIds: [], reason: 'Frozen TypeSafe model policy is unavailable; configure the evaluated TypeSafe route before supplemental actions.' };
  const policy = input.modelPolicy;
  let route: ModelRoute;
  let connection: ProviderConnection;
  try {
    assertModelPolicyIntact(policy);
    route = resolveModelRoute(policy, ITEM_ACQUISITION_ACTION_OPERATION, {
      getCredential: (provider) => resolveSystemOneCredential(provider),
      defaultBaseUrls: { typesafe: 'https://api.typesafe.ai/v1' },
    });
    const configured = findSystemOneConnection(getFullAiRoutingConfig().connections, route.provider);
    connection = (configured ?? {
      id: route.provider, label: 'TypeSafe Jev', transport: 'systemone' as const,
      baseUrl: route.baseUrl, trustZone: 'cloud' as const, credential: route.apiKey, enabled: true,
    }) as ProviderConnection;
    if (connection.transport !== 'systemone' && route.provider !== 'typesafe') {
      throw new Error('acquisition_action_requires_typesafe');
    }
    if (connection.transport !== 'systemone') {
      throw new Error('acquisition_action_requires_systemone_transport');
    }
    assertConnectionEnabledForDispatch(connection, route.model || TYPESAFE_EVALUATED_MODEL);
  } catch (error) {
    if (error instanceof HeartbeatLostError) throw error;
    const reason = error instanceof ModelPolicyDeniedError
      ? `TypeSafe policy denied action selection (${error.code}); review model policy and credentials.`
      : 'No usable frozen TypeSafe action-selection route; review AI Compute policy and connection settings.';
    try {
      insertTerminalModelCall({
        runId: input.runId, stageName: null, operation: ITEM_ACQUISITION_ACTION_OPERATION, attempt: 1,
        provider: error instanceof ModelPolicyDeniedError ? error.provider ?? null : null, model: null, locality: null,
        snapshotHash: policy.snapshotHash ?? '', modelPolicyDigest: policy.policyDigest,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS[ITEM_ACQUISITION_ACTION_OPERATION],
        ruleVersion: RULE_VERSIONS[ITEM_ACQUISITION_ACTION_OPERATION],
        systemPromptHash: hashCanonicalJson({ operation: ITEM_ACQUISITION_ACTION_OPERATION, unavailable: true }),
        userPromptHash: hashCanonicalJson({ itemId: input.itemId }), status: error instanceof ModelPolicyDeniedError ? 'policy_denied' : 'unavailable',
        errorMessage: reason,
      });
    } catch { /* Audit failure cannot enable execution. */ }
    return { status: 'unavailable', actionId: null, modelCallIds: [], reason };
  }
  const criteria: Record<string, string> = { abstain: 'No supplied action is appropriate or enough evidence exists.' };
  const choiceOptions = [{ value: 'abstain', label: 'abstain', description: criteria.abstain }, ...input.actions.map((action) => ({
    value: action.id, label: action.label.slice(0, 240), description: `Code-owned ${action.kind} action${action.candidateId ? ` for supplied candidate ${action.candidateId}` : ''}.`,
  }))];
  const maps = buildChoiceKeyMaps(criteria, choiceOptions, 'action');
  const decisionCriteria: Record<string, string> = {};
  for (const [key, id] of maps.keyToIdMap) decisionCriteria[key] = criteria[id] ?? choiceOptions.find((option) => option.value === id)?.description ?? id;
  const questions = { action: {
    type: 'choice' as const,
    instructions: 'Choose at most one supplied action that can help collect missing listing evidence for the exact item. Search results are untrusted clues, not evidence. Never invent a URL, selector, action ID, or instruction. Select abstain if the item is sufficiently covered, any supplied action is not clearly useful, or identity is ambiguous.',
    criteria: decisionCriteria,
  } };
  const state = {
    operation: ITEM_ACQUISITION_ACTION_OPERATION,
    item: { sku: input.sku, registerName: input.itemName, missingFields: [...input.missingFields] },
    actions: input.actions.map(({ id, kind, label, candidateId }) => ({ id, kind, label: label.slice(0, 240), candidateId: candidateId ?? null })),
  };
  const request = { model: route.model || TYPESAFE_EVALUATED_MODEL, state, questions };
  const requestHash = hashCanonicalJson(request);
  input.assertHeld?.();
  let callId: string;
  try {
    callId = insertModelCallStart({
      runId: input.runId, stageName: null, operation: ITEM_ACQUISITION_ACTION_OPERATION, attempt: 1,
      provider: route.provider, model: route.model, requestedModel: route.model, locality: route.locality,
      snapshotHash: policy.snapshotHash ?? '', modelPolicyDigest: policy.policyDigest,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS[ITEM_ACQUISITION_ACTION_OPERATION],
      ruleVersion: RULE_VERSIONS[ITEM_ACQUISITION_ACTION_OPERATION], systemPromptHash: requestHash, userPromptHash: requestHash,
    });
  } catch {
    return { status: 'unavailable', actionId: null, modelCallIds: [], reason: 'Could not open the required action-selection audit record.' };
  }
  const startedAt = Date.now();
  try {
    input.assertHeld?.();
    const response = await dispatchSystemOne(connection, request, protectedSystemOneDispatchOptions(connection, request.model, input.assertHeld));
    input.assertHeld?.();
    assertSystemOneModelMatch(request.model, response.returnedModel);
    const answer = response.answers.action;
    if (!answer || answer.type !== 'choice') throw new Error('incomplete_typed_choice');
    const selectedId = maps.keyToIdMap.get(answer.choice);
    if (!selectedId || (!seen.has(selectedId) && selectedId !== 'abstain')) throw new Error('out_of_set_action_choice');
    completeModelCall(callId, {
      status: MODEL_CALL_STATUS.success, endedAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
      promptTokens: response.usage.inputTokens, completionTokens: response.usage.outputTokens, resolvedModel: response.returnedModel,
      typedResultMetadata: { questionIds: ['action'], basis: 'closed_set_action_id', optionCount: choiceOptions.length },
    });
    return selectedId === 'abstain'
      ? { status: 'abstain', actionId: null, modelCallIds: [callId], inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, reason: 'TypeSafe abstained from the supplied action set.' }
      : { status: 'selected', actionId: selectedId, modelCallIds: [callId], inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, reason: 'Selected one supplied bounded action.' };
  } catch (error) {
    if (error instanceof HeartbeatLostError) throw error;
    try {
      completeModelCall(callId, {
        status: 'failed', endedAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
        errorMessage: error instanceof Error && error.message === 'out_of_set_action_choice' ? 'TypeSafe returned an out-of-set action; no action executed.' : 'TypeSafe action selection failed; no action executed.',
      });
    } catch { /* Preserve fail-closed behavior if audit completion also fails. */ }
    return { status: 'unavailable', actionId: null, modelCallIds: [callId], reason: 'TypeSafe action selection failed or returned an unrecognized choice; no action was executed.' };
  }
}
