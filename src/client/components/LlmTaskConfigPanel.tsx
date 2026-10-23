/**
 * LlmTaskConfigPanel.tsx — per-task model routing settings.
 *
 * Renders one row per known LLM task (`product_name_consolidation`,
 * `profile_generation`, `profile_revision`, `product_curation`,
 * `category_classification`, `classification_evidence_extraction`).
 *
 * Each row lets the operator:
 *  - pick a provider (deepseek/openai/ollama)
 *  - select a model (auto-populated from the provider's /models endpoint)
 *  - optionally set temperature
 *  - clear the row (which removes the routing and falls through
 *    to the generic config — except for profile tasks, which
 *    fail closed when not configured)
 *
 * Rows for `profile_generation` and `profile_revision` are
 * marked as "Required" because the governance invariant says
 * those tasks must never silently fall back to a different
 * model.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  getLlmTaskConfigs,
  upsertLlmTaskConfig,
  deleteLlmTaskConfig,
  getDeepseekModels,
  getOpenaiModels,
  getOllamaModels,
} from '../onboarding-api';
import type { LlmTask, LlmProvider, LlmTaskConfig } from '../../shared/schemas/onboarding';
import { colors } from '../theme';

const REQUIRED_TASKS: ReadonlyArray<LlmTask> = ['profile_generation', 'profile_revision'];

const TASK_LABELS: Record<LlmTask, string> = {
  product_name_consolidation: 'Product name consolidation',
  discovery_candidate_selection: 'Discovery candidate selection',
  profile_generation: 'Profile generation (AI selector proposal)',
  profile_revision: 'Profile revision (AI selector revision)',
  product_curation: 'Product curation',
  category_classification: 'Category classification',
  classification_evidence_extraction: 'Classification evidence extraction',
  product_type_classification: 'Product type classification',
  category_page_assignment: 'Product Page assignment',
  attribute_value_classification: 'Attribute value classification',
  product_field_refactor: 'Product field refactor',
  store_manager_assistant: 'Store manager assistant',
  one_shot_selector_generation: 'One-shot selector generation',
};

const TASK_HINTS: Record<LlmTask, string> = {
  product_name_consolidation: 'Consolidates a canonical product name from search-result titles/snippets. Governed by the workspace classification model policy (operation discovery_name_consolidation); deterministic LCS fallback when disabled.',
  discovery_candidate_selection: 'Selects the correct product page URL from candidate lists (sitemap + local brand index → sitemap_selection, alias product_url_selection). Governed by the workspace classification model policy; deterministic token-overlap fallback when policy denies or LLM abstains.',
  profile_generation: 'Generates a fresh selector profile from the minimized DOM. Fails closed when not configured.',
  profile_revision: 'Revises a selector profile from structured store-manager feedback. Fails closed when not configured.',
  product_curation: 'Curates product metadata (titles, packaging alignment). Governed by the workspace classification model policy (Settings → Classification); deterministic fallback when disabled.',
  category_classification: 'Classifies products into the internal category tree. Governed by the workspace classification model policy (Settings → Classification).',
  classification_evidence_extraction: 'Extracts evidence for the classification pipeline. Governed by the workspace classification model policy (Settings → Classification).',
  product_type_classification: 'Classifies products into product types. Governed by the workspace classification model policy (Settings → Classification).',
  category_page_assignment: 'Assigns products to store pages. Governed by the workspace classification model policy (Settings → Classification).',
  attribute_value_classification: 'Classifies attribute values. Governed by the workspace classification model policy (Settings → Classification).',
  product_field_refactor: 'Refactors product custom fields.',
  store_manager_assistant: 'Powers the chat-based Store Manager AI Assistant.',
  one_shot_selector_generation: 'Generates a selector profile from a captured product page using the dedicated one-shot selector-generation route.',
};

const TASK_GROUPS: Array<{ label: string; tasks: LlmTask[] }> = [
  {
    label: 'Onboarding & Curation',
    tasks: [
      'product_name_consolidation',
      'discovery_candidate_selection',
      'product_curation',
      'category_page_assignment',
      'category_classification',
      'classification_evidence_extraction',
      'product_type_classification',
      'attribute_value_classification',
    ],
  },
  {
    label: 'Profile Builder',
    tasks: ['profile_generation', 'profile_revision'],
  },
  {
    label: 'Store Manager',
    tasks: ['store_manager_assistant', 'product_field_refactor'],
  },
];

const PROVIDERS: ReadonlyArray<LlmProvider> = ['deepseek', 'openai', 'ollama'];

interface LlmTaskConfigPanelProps {
  /** Refresh hook for parent to reload when child mutates. */
  onChange?: () => void;
}

/**
 * Fetch available models for a given provider using the provider's /models endpoint.
 * Returns the model list (or empty array on error).
 */
async function fetchModelsForProvider(provider: LlmProvider): Promise<string[]> {
  try {
    switch (provider) {
      case 'deepseek': {
        const res = await getDeepseekModels();
        return res.models;
      }
      case 'openai': {
        const res = await getOpenaiModels();
        return res.models;
      }
      case 'ollama': {
        const res = await getOllamaModels();
        return res.models;
      }
    }
  } catch {
    return [];
  }
}

export function LlmTaskConfigPanel(props: LlmTaskConfigPanelProps): React.ReactElement {
  const { onChange } = props;
  const [configs, setConfigs] = useState<LlmTaskConfig[]>([]);
  const [knownTasks, setKnownTasks] = useState<LlmTask[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getLlmTaskConfigs();
      setConfigs(res.taskConfigs);
      setKnownTasks(res.knownTasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ margin: 0, fontSize: 14 }}>
          {loading && <span style={{ marginLeft: 8, fontSize: 12, color: '#9ca3af' }}>loading…</span>}
        </span>
        <button
          type="button"
          onClick={load}
          style={{
            background: 'none',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            padding: '4px 12px',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Refresh
        </button>
      </div>
      {error && (
        <p style={{ color: '#dc2626', fontSize: 13, background: '#fef2f2', padding: 8, borderRadius: 4 }}>
          {error}
        </p>
      )}
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
        Each task gets its own model. Provider credentials live in the LLM Providers section;
        this panel only routes the model selection. Profile generation and revision
        require an explicit config (the system fails closed if missing).
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {TASK_GROUPS.map((group) => {
          const visibleTasks = group.tasks.filter((t) => knownTasks.includes(t));
          if (visibleTasks.length === 0) return null;
          return (
            <React.Fragment key={group.label}>
              <h3
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: '#374151',
                  margin: '16px 0 4px',
                  paddingBottom: 4,
                  borderBottom: '1px solid #e5e7eb',
                }}
              >
                {group.label}
              </h3>
              {visibleTasks.map((task) => (
                <LlmTaskConfigRow
                  key={task}
                  task={task}
                  config={configs.find((c) => c.task === task) ?? null}
                  onSaved={async () => {
                    await load();
                    onChange?.();
                  }}
                  onCleared={async () => {
                    await load();
                    onChange?.();
                  }}
                />
              ))}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

interface LlmTaskConfigRowProps {
  task: LlmTask;
  config: LlmTaskConfig | null;
  onSaved: () => Promise<void> | void;
  onCleared: () => Promise<void> | void;
}

import { getModelCapabilities, getModelProfile } from '../../ai/model-registry';

const RECOMMENDED_MODELS: Record<string, { provider: LlmProvider; model: string; label: string }> = {
  product_name_consolidation: { provider: 'ollama', model: 'gemma4:12b-mlx', label: 'Candidate: Gemma 4 12B (Local)' },
  discovery_candidate_selection: { provider: 'ollama', model: 'gemma4:12b-mlx', label: 'Candidate: Gemma 4 12B (Local)' },
  product_field_refactor: { provider: 'ollama', model: 'gemma4:12b-mlx', label: 'Candidate: Gemma 4 12B (Local)' },
  store_manager_assistant: { provider: 'ollama', model: 'gemma4:12b-mlx', label: 'Candidate: Gemma 4 12B (Local)' },
};

function getModelCapabilityBadges(modelName: string): string[] {
  const profile = getModelProfile(modelName);
  const caps = getModelCapabilities(modelName);
  const badges: string[] = [];

  if (profile?.provider === 'ollama') {
    badges.push('⚡ Local');
  } else {
    badges.push('☁️ Cloud');
  }

  if (caps.toolCalling !== 'none') {
    badges.push(`Tools (${caps.toolCalling})`);
  }

  if (caps.structuredOutput !== 'prompted_json') {
    badges.push(`JSON (${caps.structuredOutput})`);
  }

  if (caps.modalities.includes('image')) {
    badges.push('Vision');
  }

  if (caps.reasoning !== 'none') {
    badges.push(`Reasoning (${caps.reasoning})`);
  }

  return badges;
}

function LlmTaskConfigRow(props: LlmTaskConfigRowProps) {
  const { task, config, onSaved, onCleared } = props;
  const [provider, setProvider] = useState<LlmProvider>(config?.provider ?? 'deepseek');
  const [model, setModel] = useState<string>(config?.model ?? '');
  const [fallbackProvider, setFallbackProvider] = useState<LlmProvider | ''>((config as any)?.fallbackProvider ?? '');
  const [fallbackModel, setFallbackModel] = useState<string>((config as any)?.fallbackModel ?? '');
  const [showEscalation, setShowEscalation] = useState<boolean>(Boolean((config as any)?.fallbackProvider));

  const [temperature, setTemperature] = useState<string>(
    config?.temperature !== null && config?.temperature !== undefined ? String(config.temperature) : '',
  );
  const [reasoningEffort, setReasoningEffort] = useState<string>(
    (config as any)?.reasoningEffort ?? '',
  );
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  // Model dropdown state
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState<boolean>(false);

  useEffect(() => {
    setProvider(config?.provider ?? 'deepseek');
    setModel(config?.model ?? '');
    setFallbackProvider((config as any)?.fallbackProvider ?? '');
    setFallbackModel((config as any)?.fallbackModel ?? '');
    setTemperature(
      config?.temperature !== null && config?.temperature !== undefined ? String(config.temperature) : '',
    );
    setReasoningEffort((config as any)?.reasoningEffort ?? '');
  }, [config?.id, config?.provider, config?.model, (config as any)?.fallbackProvider, (config as any)?.fallbackModel, config?.temperature, (config as any)?.reasoningEffort]);

  // Fetch models when provider changes
  const loadModels = useCallback(async (p: LlmProvider) => {
    setLoadingModels(true);
    try {
      const models = await fetchModelsForProvider(p);
      setAvailableModels(models);
      if (models.length > 0 && !models.includes(model) && !model) {
        setModel(models[0]);
      }
    } catch {
      // best-effort
    } finally {
      setLoadingModels(false);
    }
  }, [model]);

  useEffect(() => {
    loadModels(provider);
  }, [provider]);

  const required = REQUIRED_TASKS.includes(task);
  const missing = !config;
  const recommendation = RECOMMENDED_MODELS[task];
  const capabilityBadges = getModelCapabilityBadges(model);

  const handleSave = async () => {
    setError('');
    if (!model.trim()) {
      setError('Model is required');
      return;
    }
    setBusy(true);
    try {
      const temperatureNum =
        temperature.trim() === '' ? null : Number(temperature);
      if (temperatureNum !== null && Number.isNaN(temperatureNum)) {
        setError('Temperature must be a number or empty');
        return;
      }
      await upsertLlmTaskConfig(task, {
        provider,
        model: model.trim(),
        fallbackProvider: fallbackProvider ? fallbackProvider : null,
        fallbackModel: fallbackModel.trim() ? fallbackModel.trim() : null,
        baseUrlOverride: null,
        temperature: temperatureNum,
        reasoningEffort: reasoningEffort || null,
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    if (!config) return;
    if (!confirm(`Clear routing for ${task}?`)) return;
    setBusy(true);
    try {
      await deleteLlmTaskConfig(task);
      await onCleared();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 6,
        padding: 12,
        background: missing && required ? '#fef2f2' : '#fff',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div>
          <strong style={{ fontSize: 13 }}>{TASK_LABELS[task]}</strong>
          {recommendation && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 11,
                fontWeight: 500,
                color: '#166534',
                background: '#dcfce7',
                padding: '2px 6px',
                borderRadius: 4,
              }}
            >
              {recommendation.label}
            </span>
          )}
          {required && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 10,
                fontWeight: 600,
                background: '#dc2626',
                color: '#fff',
                padding: '1px 6px',
                borderRadius: 3,
                textTransform: 'uppercase',
              }}
            >
              Required
            </span>
          )}
          {missing && required && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 11,
                color: '#b45309',
                fontWeight: 500,
              }}
            >
              Not configured — extraction / revision will fail
            </span>
          )}
        </div>
        {config && (
          <button
            type="button"
            onClick={handleClear}
            disabled={busy}
            style={{
              background: 'none',
              border: '1px solid #dc2626',
              color: '#dc2626',
              borderRadius: 4,
              padding: '2px 8px',
              fontSize: 11,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {capabilityBadges.map((badge) => (
          <span
            key={badge}
            style={{
              fontSize: 10,
              fontWeight: 500,
              color: '#4b5563',
              background: '#f3f4f6',
              padding: '1px 6px',
              borderRadius: 4,
              border: '1px solid #e5e7eb',
            }}
          >
            {badge}
          </span>
        ))}
      </div>

      <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 8px' }}>{TASK_HINTS[task]}</p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ fontSize: 12 }}>
          <span style={{ display: 'block', color: '#4b5563', marginBottom: 2 }}>Provider</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as LlmProvider)}
            disabled={busy}
            style={{ padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12, flex: '1 1 220px' }}>
          <span style={{ display: 'block', color: '#4b5563', marginBottom: 2 }}>Model</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={busy || loadingModels}
              style={{
                flex: 1,
                padding: '4px 6px',
                border: '1px solid #d1d5db',
                borderRadius: 4,
                fontSize: 12,
                background: '#fff',
              }}
            >
              {loadingModels ? (
                <option value="">Loading models…</option>
              ) : availableModels.length === 0 ? (
                <>
                  {model && <option value={model}>{model}</option>}
                  <option value="">Enter model name</option>
                </>
              ) : (
                <>
                  <option value="">— Select model —</option>
                  {availableModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </>
              )}
            </select>
            <button
              type="button"
              onClick={() => loadModels(provider)}
              disabled={busy || loadingModels}
              title="Refresh models list"
              style={{
                background: 'none',
                border: '1px solid #d1d5db',
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 11,
                cursor: busy || loadingModels ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {loadingModels ? '…' : '↻'}
            </button>
          </div>
        </label>
        <label style={{ fontSize: 12, width: 80 }}>
          <span style={{ display: 'block', color: '#4b5563', marginBottom: 2 }}>Temp</span>
          <input
            type="text"
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            disabled={busy}
            placeholder="0.1"
            style={{
              width: '100%',
              padding: '4px 6px',
              border: '1px solid #d1d5db',
              borderRadius: 4,
              fontSize: 12,
              boxSizing: 'border-box',
            }}
          />
        </label>
        <label style={{ fontSize: 12, width: 100 }}>
          <span style={{ display: 'block', color: '#4b5563', marginBottom: 2 }}>Reasoning</span>
          <select
            value={reasoningEffort}
            onChange={(e) => setReasoningEffort(e.target.value)}
            disabled={busy}
            style={{
              width: '100%',
              padding: '4px 6px',
              border: '1px solid #d1d5db',
              borderRadius: 4,
              fontSize: 12,
              boxSizing: 'border-box',
            }}
          >
            <option value="">Default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="max">Max</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => setShowEscalation(!showEscalation)}
          style={{
            background: 'none',
            border: '1px solid #d1d5db',
            borderRadius: 4,
            padding: '5px 10px',
            fontSize: 11,
            color: '#4b5563',
            cursor: 'pointer',
            alignSelf: 'flex-end',
            marginBottom: 1,
          }}
        >
          {showEscalation ? 'Hide Escalation' : 'Escalation & Fallback'}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={busy}
          style={{
            background: colors.uniformGreen,
            color: colors.feedBagCream,
            border: 'none',
            borderRadius: 4,
            padding: '6px 14px',
            fontSize: 12,
            fontWeight: 600,
            cursor: busy ? 'not-allowed' : 'pointer',
            alignSelf: 'flex-end',
            marginBottom: 1,
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      {showEscalation && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            borderRadius: 6,
            background: '#f9fafb',
            border: '1px solid #e5e7eb',
            display: 'flex',
            gap: 12,
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', minWidth: 120 }}>
            ☁️ Cloud Fallback:
          </span>
          <label style={{ fontSize: 12 }}>
            <span style={{ display: 'block', color: '#6b7280', marginBottom: 2 }}>Fallback Provider</span>
            <select
              value={fallbackProvider}
              onChange={(e) => setFallbackProvider(e.target.value as LlmProvider | '')}
              disabled={busy}
              style={{ padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
            >
              <option value="">None (Fail / Local Only)</option>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12, flex: 1 }}>
            <span style={{ display: 'block', color: '#6b7280', marginBottom: 2 }}>Fallback Model</span>
            <input
              type="text"
              value={fallbackModel}
              onChange={(e) => setFallbackModel(e.target.value)}
              disabled={busy}
              placeholder="e.g. deepseek-v4-flash"
              style={{
                width: '100%',
                padding: '4px 6px',
                border: '1px solid #d1d5db',
                borderRadius: 4,
                fontSize: 12,
                boxSizing: 'border-box',
              }}
            />
          </label>
        </div>
      )}

      {error && (
        <p style={{ color: '#dc2626', fontSize: 12, margin: '6px 0 0' }}>{error}</p>
      )}
    </div>
  );
}

