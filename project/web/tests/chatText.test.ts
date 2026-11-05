import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyFormat, GROUP_GAP_MS, insideCodeFence, parseBlocks, parseInline, plainText, startsGroup } from '../lib/chatText.ts';

describe('chat blocks', () => {
  it('keeps plain text as one paragraph with its line breaks', () => {
    assert.deepEqual(parseBlocks('hello\nworld'), [{ kind: 'para', text: 'hello\nworld' }]);
  });

  it('finds fenced code with and without a language', () => {
    assert.deepEqual(parseBlocks('look:\n```js\nconst a = 1;\n```\ndone'), [
      { kind: 'para', text: 'look:' },
      { kind: 'code', lang: 'js', text: 'const a = 1;' },
      { kind: 'para', text: 'done' },
    ]);
    assert.deepEqual(parseBlocks('```inline```'), [{ kind: 'code', lang: null, text: 'inline' }]);
  });

  it('leaves an unclosed fence as text', () => {
    assert.deepEqual(parseBlocks('```js\nnot closed'), [{ kind: 'para', text: '```js\nnot closed' }]);
  });

  it('groups "> " lines into one quote', () => {
    assert.deepEqual(parseBlocks('> a\n> b\nreply'), [{ kind: 'quote', text: 'a\nb' }, { kind: 'para', text: 'reply' }]);
  });
});

describe('chat inline formatting', () => {
  it('parses bold, italic, strike and code', () => {
    assert.deepEqual(parseInline('**b** _i_ *j* ~~s~~ `c`'), [
      { kind: 'bold', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' ' },
      { kind: 'italic', children: [{ kind: 'text', text: 'i' }] },
      { kind: 'text', text: ' ' },
      { kind: 'italic', children: [{ kind: 'text', text: 'j' }] },
      { kind: 'text', text: ' ' },
      { kind: 'strike', children: [{ kind: 'text', text: 's' }] },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'c' },
    ]);
  });

  it('leaves snake_case, maths and code contents alone', () => {
    assert.deepEqual(parseInline('api_calls_id and 2*3*4'), [{ kind: 'text', text: 'api_calls_id and 2*3*4' }]);
    assert.deepEqual(parseInline('`**not bold**`'), [{ kind: 'code', text: '**not bold**' }]);
  });

  it('links bare URLs without the sentence punctuation after them', () => {
    assert.deepEqual(parseInline('see https://example.com/a?b=1.'), [
      { kind: 'text', text: 'see ' },
      { kind: 'link', url: 'https://example.com/a?b=1' },
      { kind: 'text', text: '.' },
    ]);
    assert.deepEqual(parseInline('(https://en.wikipedia.org/wiki/A_(b))'), [
      { kind: 'text', text: '(' },
      { kind: 'link', url: 'https://en.wikipedia.org/wiki/A_(b)' },
      { kind: 'text', text: ')' },
    ]);
  });

  it('never links other schemes', () => {
    assert.deepEqual(parseInline('javascript:alert(1) http://'), [{ kind: 'text', text: 'javascript:alert(1) http://' }]);
  });

  it('matches the longest known name for a mention', () => {
    assert.deepEqual(parseInline('hi @Ann Lee!', ['Ann', 'Ann Lee']), [
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', text: '@Ann Lee', name: 'Ann Lee' },
      { kind: 'text', text: '!' },
    ]);
    assert.deepEqual(parseInline('@Annabel', ['Ann']), [{ kind: 'text', text: '@Annabel' }]);
  });

  it('stays fast on hostile input', () => {
    const started = performance.now();
    parseInline(`${'*_~`'.repeat(1000)}${'a_'.repeat(1000)}`, ['x']);
    assert.ok(performance.now() - started < 200);
  });
});

describe('chat plain text', () => {
  it('drops the markers', () => {
    assert.equal(plainText('**Fix** the `api`\n> quoted'), 'Fix the api quoted');
    assert.equal(plainText('fails with:\n```js\nconst total = cart.su'), 'fails with: const total = cart.su');
  });
});

describe('chat grouping', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 5, 10, minutes)).toISOString();
  it('starts a group for a new person or after a pause', () => {
    assert.equal(startsGroup(null, { userId: 'a', createdAt: at(0) }), true);
    assert.equal(startsGroup({ userId: 'a', createdAt: at(0) }, { userId: 'a', createdAt: at(1) }), false);
    assert.equal(startsGroup({ userId: 'a', createdAt: at(0) }, { userId: 'b', createdAt: at(1) }), true);
    assert.equal(startsGroup({ userId: 'a', createdAt: at(0) }, { userId: 'a', createdAt: at(GROUP_GAP_MS / 60_000 + 1) }), true);
  });
});

describe('composer editing', () => {
  it('knows when the caret is inside a code block', () => {
    assert.equal(insideCodeFence('```\nabc', 7), true);
    assert.equal(insideCodeFence('```\nabc\n```', 11), false);
  });

  it('wraps and unwraps the selection', () => {
    assert.deepEqual(applyFormat('make bold', 5, 9, 'bold'), { text: 'make **bold**', start: 7, end: 11 });
    assert.deepEqual(applyFormat('make **bold**', 7, 11, 'bold'), { text: 'make bold', start: 5, end: 9 });
    assert.deepEqual(applyFormat('', 0, 0, 'code'), { text: '``', start: 1, end: 1 });
  });

  it('puts code blocks and quotes on their own lines', () => {
    assert.equal(applyFormat('see x', 4, 5, 'codeblock').text, 'see \n```\nx\n```');
    assert.equal(applyFormat('a\nb', 2, 3, 'quote').text, 'a\n> b');
  });
});
