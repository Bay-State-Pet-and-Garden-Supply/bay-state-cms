/**
 * Provider Registry for Bay State AI Infrastructure.
 *
 * Defines metadata, locality, transport, and default endpoint behaviors
 * for supported LLM providers without determining task routing.
 */

export type AiProviderLocality = 'local' | 'cloud';
export type AiProviderTransport = 'openai-compatible' | 'ollama-native';

export interface AiProviderDefinition {
  id: string;
  label: string;
  locality: AiProviderLocality;
  transport: AiProviderTransport;
  defaultBaseUrl: string;
  supportsModelsEndpoint: boolean;
  requiresCredential: boolean;
}

const PROVIDERS: Record<string, AiProviderDefinition> = {
  ollama: {
    id: 'ollama',
    label: 'Ollama (Local)',
    locality: 'local',
    transport: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:11434/v1',
    supportsModelsEndpoint: true,
    requiresCredential: false,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek (Cloud)',
    locality: 'cloud',
    transport: 'openai-compatible',
    defaultBaseUrl: 'https://api.deepseek.com',
    supportsModelsEndpoint: true,
    requiresCredential: true,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (Cloud)',
    locality: 'cloud',
    transport: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportsModelsEndpoint: true,
    requiresCredential: true,
  },
};

/**
 * Retrieve provider metadata definition by provider identifier.
 */
export function getProviderDefinition(providerId: string): AiProviderDefinition | null {
  if (!providerId) return null;
  const key = providerId.trim().toLowerCase();
  return PROVIDERS[key] ?? null;
}

/**
 * Return all registered provider definitions.
 */
export function listProviderDefinitions(): AiProviderDefinition[] {
  return Object.values(PROVIDERS);
}
