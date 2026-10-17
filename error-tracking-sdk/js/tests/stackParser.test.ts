import { describe, expect, it } from 'vitest';
import { MAX_STACK_FRAMES } from '../src/constants';
import { parseStack, parseStackFromError } from '../src/core/stackParser';

describe('parseStack', () => {
  it('parses V8 (Chrome/Edge/Node) frames', () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'price')",
      '    at handlePayment (https://app.example.com/static/cart.js:142:12)',
      '    at async submit (https://app.example.com/static/cart.js:200:5)',
      '    at https://app.example.com/static/main.js:10:3',
      '    at new Checkout (http://localhost:3000/checkout.js:5:7)',
      '    at Array.forEach (<anonymous>)',
    ].join('\n');

    expect(parseStack(stack)).toEqual([
      { filename: 'https://app.example.com/static/cart.js', lineno: 142, colno: 12, function: 'handlePayment' },
      { filename: 'https://app.example.com/static/cart.js', lineno: 200, colno: 5, function: 'submit' },
      { filename: 'https://app.example.com/static/main.js', lineno: 10, colno: 3, function: '<anonymous>' },
      { filename: 'http://localhost:3000/checkout.js', lineno: 5, colno: 7, function: 'new Checkout' },
      { filename: null, lineno: null, colno: null, function: 'Array.forEach' },
    ]);
  });

  it('uses the eval origin for V8 eval frames', () => {
    const stack = 'Error: x\n    at eval (eval at run (https://x.test/app.js:3:9), <anonymous>:1:1)';
    expect(parseStack(stack)[0]).toEqual({ filename: 'https://x.test/app.js', lineno: 3, colno: 9, function: 'eval' });
  });

  it('parses Firefox frames, including closures and eval', () => {
    const stack = [
      'handlePayment@https://app.example.com/cart.js:142:12',
      'submit/<@https://app.example.com/cart.js:200:5',
      '@https://app.example.com/main.js:10:3',
      'run@https://app.example.com/app.js line 7 > eval:1:1',
    ].join('\n');

    expect(parseStack(stack)).toEqual([
      { filename: 'https://app.example.com/cart.js', lineno: 142, colno: 12, function: 'handlePayment' },
      { filename: 'https://app.example.com/cart.js', lineno: 200, colno: 5, function: 'submit' },
      { filename: 'https://app.example.com/main.js', lineno: 10, colno: 3, function: '<anonymous>' },
      { filename: 'https://app.example.com/app.js', lineno: 7, colno: null, function: 'run' },
    ]);
  });

  it('parses Safari frames including native code', () => {
    const stack = ['handlePayment@https://app.example.com/cart.js:142:12', 'forEach@[native code]', 'global code@https://app.example.com/main.js:1:8'].join('\n');
    const frames = parseStack(stack);
    expect(frames).toHaveLength(3);
    expect(frames[1]).toEqual({ filename: null, lineno: null, colno: null, function: 'forEach' });
    expect(frames[2].function).toBe('global code');
  });

  it('does not misread a V8 message line containing "@" as a frame', () => {
    const stack = 'Error: bad email foo@bar.com:1:2\n    at validate (https://x.test/a.js:1:1)';
    expect(parseStack(stack)).toHaveLength(1);
  });

  it('caps very deep stacks (e.g. stack overflow)', () => {
    const lines = ['RangeError: Maximum call stack size exceeded'];
    for (let i = 0; i < 10000; i++) lines.push('    at recurse (https://x.test/a.js:1:' + i + ')');
    expect(parseStack(lines.join('\n'))).toHaveLength(MAX_STACK_FRAMES);
  });

  it('returns an empty array for missing or garbage input', () => {
    expect(parseStack(undefined)).toEqual([]);
    expect(parseStack('')).toEqual([]);
    expect(parseStack('not a stack trace')).toEqual([]);
    expect(parseStackFromError({ stack: 42 })).toEqual([]);
    expect(parseStackFromError('string')).toEqual([]);
  });

  it('parses a real error thrown in this runtime', () => {
    function throwsHere(): never {
      throw new Error('boom');
    }
    try {
      throwsHere();
    } catch (e) {
      const frames = parseStackFromError(e);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0].function).toContain('throwsHere');
      expect(frames[0].lineno).toEqual(expect.any(Number));
    }
  });
});
