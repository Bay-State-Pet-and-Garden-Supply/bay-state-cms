/**
 * Model Registry for Bay State AI Infrastructure.
 *
 * Describes candidate model characteristics and capabilities without deciding routing.
 */

import type { ModelCapabilities, LocalMemoryClass } from './model-capabilities';

export interface ModelProfile {
  id: string;
  provider: string;
  capabilities: ModelCapabilities;
  recommendedContext?: number;
  localMemoryClass?: LocalMemoryClass;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  modalities: ['text'],
  toolCalling: 'none',
  structuredOutput: 'prompted_json',
  reasoning: 'none',
};

const MODEL_PROFILES: Record<string, ModelProfile> = {
  'gemma4:12b-mlx': {
    id: 'gemma4:12b-mlx',
    provider: 'ollama',
    capabilities: {
      modalities: ['text', 'image'],
      toolCalling: 'basic',
      structuredOutput: 'json_schema',
      reasoning: 'configurable',
      maxContextTokens: 262144,
      recommendedContextTokens: 32768,
    },
    recommendedContext: 32768,
    localMemoryClass: 'medium',
  },
  'qwen3.5:9b': {
    id: 'qwen3.5:9b',
    provider: 'ollama',
    capabilities: {
      modalities: ['text', 'image'],
      toolCalling: 'parallel',
      structuredOutput: 'json_schema',
      reasoning: 'configurable',
      maxContextTokens: 262144,
      recommendedContextTokens: 32768,
    },
    recommendedContext: 32768,
    localMemoryClass: 'small',
  },
  'ministral-3:8b': {
    id: 'ministral-3:8b',
    provider: 'ollama',
    capabilities: {
      modalities: ['text', 'image'],
      toolCalling: 'basic',
      structuredOutput: 'json_mode',
      reasoning: 'none',
      maxContextTokens: 262144,
      recommendedContextTokens: 32768,
    },
    recommendedContext: 32768,
    localMemoryClass: 'small',
  },
  'deepseek-v4-flash': {
    id: 'deepseek-v4-flash',
    provider: 'deepseek',
    capabilities: {
      modalities: ['text'],
      toolCalling: 'parallel',
      structuredOutput: 'json_schema',
      reasoning: 'configurable',
      maxContextTokens: 1048576,
      recommendedContextTokens: 65536,
    },
    recommendedContext: 65536,
  },
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    capabilities: {
      modalities: ['text'],
      toolCalling: 'parallel',
      structuredOutput: 'json_schema',
      reasoning: 'configurable',
      maxContextTokens: 1048576,
      recommendedContextTokens: 65536,
    },
    recommendedContext: 65536,
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    provider: 'openai',
    capabilities: {
      modalities: ['text', 'image'],
      toolCalling: 'parallel',
      structuredOutput: 'json_schema',
      reasoning: 'none',
      maxContextTokens: 128000,
      recommendedContextTokens: 128000,
    },
    recommendedContext: 128000,
  },
  'qwen2.5vl:latest': {
    id: 'qwen2.5vl:latest',
    provider: 'ollama',
    capabilities: {
      modalities: ['text', 'image'],
      toolCalling: 'basic',
      structuredOutput: 'json_schema',
      reasoning: 'none',
      maxContextTokens: 131072,
      recommendedContextTokens: 32768,
    },
    recommendedContext: 32768,
    localMemoryClass: 'medium',
  },
};

/**
 * Retrieve model profile by model identifier.
 */
export function getModelProfile(modelId: string): ModelProfile | null {
  if (!modelId) return null;
  const key = modelId.trim();
  return MODEL_PROFILES[key] ?? null;
}

/**
 * Return capabilities for a model (falling back to baseline text capabilities if unknown).
 */
export function getModelCapabilities(modelId: string): ModelCapabilities {
  const profile = getModelProfile(modelId);
  return profile ? profile.capabilities : DEFAULT_CAPABILITIES;
}

/**
 * Return all registered model profiles.
 */
export function listModelProfiles(): ModelProfile[] {
  return Object.values(MODEL_PROFILES);
}
