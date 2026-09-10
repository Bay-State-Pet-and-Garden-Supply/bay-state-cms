/**
 * Model capabilities metadata structures for Bay State AI model profiles.
 */

export type Modality = 'text' | 'image' | 'audio';
export type ToolCallingTier = 'none' | 'basic' | 'parallel';
export type StructuredOutputMode = 'prompted_json' | 'json_mode' | 'json_schema';
export type ReasoningCapability = 'none' | 'implicit' | 'configurable';
export type LocalMemoryClass = 'small' | 'medium' | 'large';

export interface ModelCapabilities {
  modalities: Modality[];
  toolCalling: ToolCallingTier;
  structuredOutput: StructuredOutputMode;
  reasoning: ReasoningCapability;
  maxContextTokens?: number;
  recommendedContextTokens?: number;
}

