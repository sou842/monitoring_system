import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { docToMarkdown, GROUP_GAP_MS, parseBlocks, parseInline, plainText, startsGroup } from '../lib/chatText.ts';

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


describe('chat lists', () => {
  it('groups "- " and "1. " lines into lists with nesting', () => {
    assert.deepEqual(parseBlocks('steps:\n1. open\n  - cart\n2. pay'), [
      { kind: 'para', text: 'steps:' },
      { kind: 'list', items: [
        { ordered: true, number: 1, level: 0, text: 'open' },
        { ordered: false, number: 0, level: 1, text: 'cart' },
        { ordered: true, number: 2, level: 0, text: 'pay' },
      ] },
    ]);
  });

  it('does not treat a dash inside a sentence as a list', () => {
    assert.deepEqual(parseBlocks('a - b'), [{ kind: 'para', text: 'a - b' }]);
  });
});

describe('composer document to Markdown', () => {
  const p = (...content: object[]) => ({ type: 'paragraph', content });
  const t = (text: string, ...marks: string[]) => ({ type: 'text', text, marks: marks.map((type) => ({ type })) });

  it('writes marks with the spaces outside the markers', () => {
    assert.deepEqual(docToMarkdown({ type: 'doc', content: [p(t('Fix '), t('this ', 'bold'), t('now', 'italic', 'strike'), t(' '), t('a.b', 'code'))] }),
      { text: 'Fix **this** _~~now~~_ `a.b`', mentions: [] });
  });

  it('writes mentions by name and returns their ids once', () => {
    const m = (id: string, label: string) => ({ type: 'mention', attrs: { id, label } });
    assert.deepEqual(docToMarkdown({ type: 'doc', content: [p(t('hi '), m('u1', 'Ann Lee'), t(' and '), m('u1', 'Ann Lee'))] }),
      { text: 'hi @Ann Lee and @Ann Lee', mentions: ['u1'] });
  });

  it('writes blocks: lines, quotes, code, lists', () => {
    const doc = { type: 'doc', content: [
      p(t('one'), { type: 'hardBreak' }, t('two')),
      { type: 'blockquote', content: [p(t('quoted'))] },
      { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'a()\nb()' }] },
      { type: 'orderedList', attrs: { start: 1 }, content: [
        { type: 'listItem', content: [p(t('first')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('inner'))] }] }] },
        { type: 'listItem', content: [p(t('second'))] },
      ] },
      p(),
      p(),
      p(),
    ] };
    const { text } = docToMarkdown(doc);
    assert.equal(text, 'one\ntwo\n> quoted\n```js\na()\nb()\n```\n1. first\n  - inner\n2. second');
    // And it reads back the same way.
    assert.deepEqual(parseBlocks(text).map((b) => b.kind), ['para', 'quote', 'code', 'list']);
  });

  it('keeps a link address visible when its text differs, and ignores other schemes', () => {
    const link = (text: string, href: string) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] });
    assert.equal(docToMarkdown({ type: 'doc', content: [p(link('the PR', 'https://x.dev/1'), t(' '), link('bad', 'javascript:alert(1)'))] }).text, 'the PR (https://x.dev/1) bad');
  });
});
