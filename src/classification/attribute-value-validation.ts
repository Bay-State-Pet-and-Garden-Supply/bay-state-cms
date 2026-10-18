import type { ProductAttributeConfig } from '../shared/types';
import { resolveAlias } from './controlled-value-identity';

type MeasuredValueParseResult =
  | { ok: true; value: number }
  | { ok: false; message: string };

export function parseMeasuredValue(
  value: unknown,
  canonicalUnit: string | null | undefined,
): MeasuredValueParseResult {
  const unit = canonicalUnit?.trim();
  if (!unit) return { ok: false, message: 'Measured value has no configured canonical unit.' };

  let numeric: number;
  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'string') {
    const match = value.trim().match(/^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)(.*)$/);
    if (!match) {
      return { ok: false, message: `Measured value "${value}" is not a finite measured number.` };
    }
    const suppliedUnit = match[2]!.trim();
    if (suppliedUnit && suppliedUnit.toLowerCase() !== unit.toLowerCase()) {
      return { ok: false, message: `Measured value "${value}" does not use the configured unit "${unit}".` };
    }
    numeric = Number(match[1]);
  } else {
    return { ok: false, message: `Measured value "${String(value)}" is not a finite measured number.` };
  }

  if (!Number.isFinite(numeric)) {
    return { ok: false, message: `Measured value "${String(value)}" is not a finite measured number.` };
  }
  return { ok: true, value: numeric };
}

export type SerializableValueValidation =
  | { ok: true }
  | { ok: false; code: 'controlled_membership' | 'measured_unit'; message: string };

export function validateSerializableValue(
  value: unknown,
  attribute?: (
    Pick<ProductAttributeConfig, 'id' | 'valueMode' | 'allowedValues' | 'valueAliases'>
    & Partial<Pick<ProductAttributeConfig, 'canonicalUnit'>>
  ) | null,
): SerializableValueValidation {
  if (value === null || value === undefined) return { ok: true };

  const values = Array.isArray(value) ? value : [value];

  if (attribute?.valueMode === 'controlled' && values.length > 0 && (attribute.allowedValues?.length ?? 0) === 0) {
    return {
      ok: false,
      code: 'controlled_membership',
      message: `Attribute "${attribute.id}" has no configured controlled values.`,
    };
  }
  if (attribute?.valueMode === 'controlled' && (attribute.allowedValues?.length ?? 0) > 0) {
    for (const item of values) {
      const str = String(item);
      const allowed = attribute.allowedValues.includes(str);
      const aliasTarget = allowed
        ? str
        : resolveAlias(str, attribute.valueAliases ?? [], attribute.allowedValues);
      if (aliasTarget === null) {
        return {
          ok: false,
          code: 'controlled_membership',
          message: `Value "${str}" is not in the controlled value list for attribute "${attribute.id}".`,
        };
      }
    }
  }

  if (attribute?.valueMode === 'measured') {
    if (values.length === 0) {
      return {
        ok: false,
        code: 'measured_unit',
        message: `Attribute "${attribute.id}" has no measured value.`,
      };
    }
    for (const item of values) {
      const parsed = parseMeasuredValue(item, attribute.canonicalUnit);
      if (!parsed.ok) {
        return {
          ok: false,
          code: 'measured_unit',
          message: `${parsed.message} Attribute "${attribute.id}".`,
        };
      }
    }
  }

  return { ok: true };
}

export type AttributeProfileValueValidation =
  | { ok: true }
  | { ok: false; code: 'cardinality' | 'value_shape' | 'controlled_membership' | 'measured_unit'; message: string };
export function validateAttributeProfileValue(
  value: unknown,
  attribute: ProductAttributeConfig,
  cardinality: 'single' | 'multiple',
): AttributeProfileValueValidation {
  if (value === null || value === undefined) return { ok: true };

  if ((cardinality === 'multiple') !== Array.isArray(value)) {
    return {
      ok: false,
      code: 'cardinality',
      message: `Attribute "${attribute.id}" value does not match its frozen ${cardinality} cardinality.`,
    };
  }

  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.some(item => item === null || item === undefined
    || (typeof item === 'string' && item.trim().length === 0)
    || (attribute.valueMode === 'measured'
      ? typeof item !== 'string' && typeof item !== 'number'
      : typeof item !== 'string'))) {
    return {
      ok: false,
      code: 'value_shape',
      message: `Attribute "${attribute.id}" value is empty or does not match its frozen value mode.`,
    };
  }

  return validateSerializableValue(value, attribute);
}
