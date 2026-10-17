import { MAX_STACK_FRAMES, UNKNOWN_FUNCTION } from '../constants';
import { StackFrame } from '../types';

/**
 * Parses `Error.stack` strings from V8 (Chrome, Edge, Node), SpiderMonkey
 * (Firefox) and JavaScriptCore (Safari) into structured frames, newest first.
 * Source maps are not applied; the backend is expected to symbolicate.
 */

// "    at fn (https://x/app.js:10:5)"  |  "    at https://x/app.js:10:5"
const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
// "    at fn (native)" / "    at fn (<anonymous>)" — no usable location
const V8_NO_LOCATION = /^\s*at (?:(.+?) \()?(native|<anonymous>|unknown location)\)?\s*$/;
// "    at eval (eval at outer (https://x/app.js:10:5), <anonymous>:1:1)"
const V8_EVAL_ORIGIN = /\(eval at [^()]*\((.+?):(\d+):(\d+)\)/;
const V8_LINE = /^\s*at /;

// "fn@https://x/app.js:10:5"  |  "@https://x/app.js:10:5"
const GECKO_FRAME = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;
// "fn@https://x/app.js line 7 > eval:1:1"
const GECKO_EVAL = /^\s*(.*?)@(.+?) line (\d+) > (?:eval|Function)/;
// Safari: "fn@[native code]"
const GECKO_NATIVE = /^\s*(.*?)@\[native code\]\s*$/;

/** Parses a raw stack string. Unrecognised lines are skipped. */
export function parseStack(stack: string | undefined | null): StackFrame[] {
  if (typeof stack !== 'string' || stack.length === 0) return [];

  const lines = stack.split('\n');
  const isV8 = lines.some(function test(line) {
    return V8_LINE.test(line);
  });

  const frames: StackFrame[] = [];
  for (let i = 0; i < lines.length && frames.length < MAX_STACK_FRAMES; i++) {
    const frame = isV8 ? parseV8Line(lines[i]) : parseGeckoLine(lines[i]);
    if (frame !== null) frames.push(frame);
  }
  return frames;
}

/** Extracts frames from any thrown value that carries a `stack` string. */
export function parseStackFromError(error: unknown): StackFrame[] {
  if (error !== null && typeof error === 'object' && 'stack' in error) {
    const stack = (error as { stack?: unknown }).stack;
    return typeof stack === 'string' ? parseStack(stack) : [];
  }
  return [];
}

function parseV8Line(line: string): StackFrame | null {
  if (!V8_LINE.test(line)) return null;

  const evalMatch = V8_EVAL_ORIGIN.exec(line);
  if (evalMatch !== null) {
    const fnName = /^\s*at (.+?) \(/.exec(line);
    return frame(fnName !== null ? fnName[1] : '', evalMatch[1], evalMatch[2], evalMatch[3]);
  }

  const match = V8_FRAME.exec(line);
  if (match !== null) return frame(match[1] || '', match[2], match[3], match[4]);

  const native = V8_NO_LOCATION.exec(line);
  if (native !== null) return frame(native[1] || '', null, null, null);

  return null;
}

function parseGeckoLine(line: string): StackFrame | null {
  const evalMatch = GECKO_EVAL.exec(line);
  if (evalMatch !== null) return frame(evalMatch[1], evalMatch[2], evalMatch[3], null);

  const match = GECKO_FRAME.exec(line);
  if (match !== null) return frame(match[1], match[2], match[3], match[4]);

  const native = GECKO_NATIVE.exec(line);
  if (native !== null) return frame(native[1], null, null, null);

  return null;
}

function frame(
  fn: string,
  filename: string | null,
  lineno: string | null,
  colno: string | null,
): StackFrame {
  return {
    filename: filename !== null && filename.length > 0 ? filename : null,
    lineno: toInt(lineno),
    colno: toInt(colno),
    function: cleanFunctionName(fn),
  };
}

function cleanFunctionName(raw: string): string {
  let name = raw.trim();
  if (name.indexOf('async ') === 0) name = name.slice('async '.length);
  // Firefox marks closures as "outer/<" and "outer/inner<"; keep the readable part.
  name = name.replace(/\/<+$/, '').replace(/<$/, '');
  return name.length > 0 ? name : UNKNOWN_FUNCTION;
}

function toInt(value: string | null): number | null {
  if (value === null) return null;
  const n = parseInt(value, 10);
  return isNaN(n) ? null : n;
}
