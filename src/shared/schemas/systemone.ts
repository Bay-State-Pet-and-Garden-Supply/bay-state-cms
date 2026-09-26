/**
 * Shared Zod schemas for the TypeSafe System One HTTP API.
 *
 * Documents the wire contract used by the System One transport
 * (`src/ai/systemone-transport.ts`):
 * - Request: `{ state, model, questions }` where each question is a `choice`
 *   or `noul` typed judgment. Question keys are correlation keys chosen by
 *   the caller — they are never sent to the model as instructions.
 * - Response: `{ model, answers, usage }` with one answer per question key.
 *
 * These schemas validate SHAPE only (types, required fields, coarse sizes).
 * Cross-field checks — exact question-key matching, choice membership,
 * probability bounds/sums, selected-option consistency, and requested vs
 * returned model identity — live in the transport, which has both sides of
 * the exchange in scope.
 */

import { z } from 'zod';

/** Caller-chosen correlation key: never model-visible, matched exactly. */
export const SystemOneQuestionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9_.-]+$/,
    'Question keys are correlation keys: ASCII letters, digits, "_", ".", "-" only.',
  );

/** Instructions carry the question meaning; criteria carry option rubrics. */
export const SystemOneInstructionsSchema = z.union([
  z.string().min(1).max(8000),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()).min(1).max(32),
]);

const SystemOneCriteriaValueSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
  z.null(),
]);

/** Choice: pick one option from a caller-defined set (2+ options; the 255 cap is enforced with a candidate-limit error). */
export const SystemOneChoiceQuestionSchema = z
  .object({
    type: z.literal('choice'),
    instructions: SystemOneInstructionsSchema,
    criteria: z
      .record(z.string().min(1).max(256), SystemOneCriteriaValueSchema)
      .refine((criteria) => Object.keys(criteria).length >= 2, {
        message: 'Choice criteria must define at least 2 options.',
      }),
  })
  .strict();
/** Noul: yes/no question returning P(yes) in [0, 1]. */
export const SystemOneNoulQuestionSchema = z
  .object({
    type: z.literal('noul'),
    instructions: SystemOneInstructionsSchema,
    criteria: z
      .object({
        true: SystemOneInstructionsSchema.optional(),
        false: SystemOneInstructionsSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * One typed judgment question. `score` is deliberately absent: this provider
 * integration supports Choice/Noul only, so a score question fails closed
 * here (unsupported use) instead of traveling to the API.
 */
export const SystemOneQuestionSchema = z.discriminatedUnion('type', [
  SystemOneChoiceQuestionSchema,
  SystemOneNoulQuestionSchema,
]);

export type SystemOneQuestion = z.infer<typeof SystemOneQuestionSchema>;

/** `state` is the evaluated content: text, a record, or an array of text. */
export const SystemOneStateSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

export const SystemOneRequestSchema = z
  .object({
    state: SystemOneStateSchema,
    model: z.string().min(1).max(128),
    questions: z
      .record(z.string(), SystemOneQuestionSchema)
      .refine(
        (questions) => {
          const count = Object.keys(questions).length;
          return count >= 1 && count <= 32;
        },
        { message: 'System One requests carry 1..32 questions per call (application fan-out bound).' },
      ),
  })
  .strict();

export type SystemOneRequest = z.infer<typeof SystemOneRequestSchema>;

/** Noul answer: single P(yes) number. */
export const SystemOneNoulAnswerSchema = z
  .object({
    type: z.literal('noul'),
    noul: z.number(),
  })
  .strict();

/** Choice answer: selected option + full distribution + concentration confidence. */
export const SystemOneChoiceAnswerSchema = z
  .object({
    type: z.literal('choice'),
    choice: z.string().min(1),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  })
  .strict();

/**
 * One answer. An unknown `type` (e.g. `score`) fails this union and is
 * rejected as an unsupported answer kind — never coerced.
 */
export const SystemOneAnswerSchema = z.discriminatedUnion('type', [
  SystemOneNoulAnswerSchema,
  SystemOneChoiceAnswerSchema,
]);

export type SystemOneAnswer = z.infer<typeof SystemOneAnswerSchema>;

export const SystemOneUsageSchema = z
  .object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  })
  .strict();

export const SystemOneResponseSchema = z
  .object({
    model: z.string().min(1).max(128),
    answers: z.record(z.string(), SystemOneAnswerSchema),
    usage: SystemOneUsageSchema,
  })
  .strict();

export type SystemOneResponse = z.infer<typeof SystemOneResponseSchema>;
