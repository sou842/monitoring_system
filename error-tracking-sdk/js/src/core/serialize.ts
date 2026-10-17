import {
  MAX_SERIALIZE_DEPTH,
  MAX_SERIALIZE_KEYS,
  MAX_STRING_LENGTH,
} from '../constants';
import { JsonObject, JsonValue } from '../types';

const CIRCULAR = '[Circular]';
const MAX_DEPTH_MARKER = '[MaxDepth]';
const TRUNCATION_SUFFIX = '…';

/** Shortens a string to `max` characters, marking that it was cut. */
export function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + TRUNCATION_SUFFIX : value;
}

/**
 * Converts an arbitrary value into JSON-safe data: circular references,
 * functions, DOM nodes, errors and deep/wide structures are all handled so
 * `JSON.stringify` on the result can never throw.
 */
export function normalize(value: unknown, depth: number = MAX_SERIALIZE_DEPTH): JsonValue {
  return normalizeInner(value, depth, []);
}

/** `normalize` for values that must end up as a JSON object. */
export function normalizeObject(value: unknown): JsonObject {
  const result = normalize(value);
  if (result !== null && typeof result === 'object' && !isArray(result)) return result;
  return {};
}

function isArray(value: unknown): value is unknown[] {
  return Object.prototype.toString.call(value) === '[object Array]';
}

function normalizeInner(value: unknown, depth: number, seen: unknown[]): JsonValue {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case 'string':
      return truncate(value, MAX_STRING_LENGTH);
    case 'number':
      return isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'symbol':
      return value.toString();
    case 'function':
      return '[Function ' + (value.name || 'anonymous') + ']';
    default:
      break;
  }

  if (value instanceof Error) {
    return { name: value.name, message: truncate(value.message, MAX_STRING_LENGTH) };
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (typeof Node !== 'undefined' && value instanceof Node) {
    return '[' + value.nodeName + ']';
  }

  if (seen.indexOf(value) !== -1) return CIRCULAR;
  if (depth <= 0) return MAX_DEPTH_MARKER;

  seen.push(value);
  try {
    if (isArray(value)) {
      const arr: JsonValue[] = [];
      const limit = Math.min(value.length, MAX_SERIALIZE_KEYS);
      for (let i = 0; i < limit; i++) arr.push(normalizeInner(value[i], depth - 1, seen));
      return arr;
    }

    const obj: JsonObject = {};
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).slice(0, MAX_SERIALIZE_KEYS);
    for (let i = 0; i < keys.length; i++) {
      let child: unknown;
      try {
        child = source[keys[i]];
      } catch (_e) {
        // Throwing getters are skipped rather than aborting the whole object.
        continue;
      }
      if (child === undefined) continue;
      obj[keys[i]] = normalizeInner(child, depth - 1, seen);
    }
    return obj;
  } finally {
    seen.pop();
  }
}

/** Converts any thrown value into a readable message string. */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    const json = JSON.stringify(normalize(value));
    return json === undefined ? String(value) : json;
  } catch (_e) {
    return Object.prototype.toString.call(value);
  }
}
