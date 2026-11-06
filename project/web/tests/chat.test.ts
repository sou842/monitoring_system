/** Unit tests for the server-side chat helpers that need no database. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
import { CHAT_REACTIONS, EMOJI_PALETTE, isReactionEmoji } from '../lib/chat.ts';
import { EMOJI_GROUPS } from '../lib/emojiData.ts';
import { cleanClientId, mentionsInText } from '../server/chat.ts';

describe('mentionsInText', () => {
  const ann = { _id: new ObjectId(), name: 'Ann' };
  const annLee = { _id: new ObjectId(), name: 'Ann Lee' };
  const bob = { _id: new ObjectId(), name: 'Bob (QA)' };
  const people = [ann, annLee, bob];

  it('finds people by "@Name", longest name first', () => {
    assert.deepEqual(mentionsInText('ping @Ann Lee', people), [annLee._id]);
    const both = mentionsInText('@Ann and @Ann Lee', people).map(String).sort();
    assert.deepEqual(both, [String(ann._id), String(annLee._id)].sort());
  });

  it('needs a word edge after the name, and handles regex characters in names', () => {
    assert.deepEqual(mentionsInText('@Annabel is not Ann', people), []);
    assert.deepEqual(mentionsInText('cc @Bob (QA).', people), [bob._id]);
    assert.deepEqual(mentionsInText('email ann@example.com', people), []);
  });

  it('lists each person once and ignores people without a name', () => {
    assert.deepEqual(mentionsInText('@Ann @Ann @Ann', [...people, { _id: new ObjectId(), name: '' }]), [ann._id]);
  });
});

describe('cleanClientId', () => {
  it('accepts short ids of safe characters only', () => {
    assert.equal(cleanClientId('c1a2-b_3'), 'c1a2-b_3');
    assert.equal(cleanClientId(''), null);
    assert.equal(cleanClientId('x'.repeat(65)), null);
    assert.equal(cleanClientId('a b'), null);
    assert.equal(cleanClientId({ $gt: '' }), null);
    assert.equal(cleanClientId(12), null);
  });
});

describe('reaction emoji', () => {
  it('accepts any single emoji, with skin tone or joiners', () => {
    for (const e of ['👍', '👎', '❤️', '😂', '🔥', '👏', '🎉', '👏🏽', '👨‍💻', '🏳️‍🌈', '✅']) assert.equal(isReactionEmoji(e), true, e);
  });

  it('refuses text, several emoji, markup, empty and non-strings', () => {
    for (const e of ['', 'a', '1', '<b>', '👍👍', '👍 ', 'like', '.', '$ne', 'x'.repeat(40)]) assert.equal(isReactionEmoji(e), false, JSON.stringify(e));
    for (const e of [null, undefined, 5, {}, ['👍']]) assert.equal(isReactionEmoji(e), false);
  });

  it('offers like, dislike, heart, laugh, fire and clap first', () => {
    assert.deepEqual([...CHAT_REACTIONS], ['👍', '👎', '❤️', '😂', '🔥', '👏']);
    for (const e of CHAT_REACTIONS) assert.equal(isReactionEmoji(e), true);
  });

  it('has a palette of valid, unique emoji', () => {
    const seen = new Set<string>();
    for (const [e, name] of EMOJI_PALETTE) {
      assert.equal(isReactionEmoji(e), true, e);
      assert.ok(name);
      assert.equal(seen.has(e), false, `duplicate ${e}`);
      seen.add(e);
    }
  });
});

describe('emoji picker data', () => {
  it('only offers emoji the server accepts as reactions', () => {
    let total = 0;
    for (const group of EMOJI_GROUPS) {
      for (const [emoji, name] of group.emojis) {
        total++;
        assert.equal(isReactionEmoji(emoji), true, `${group.name}: ${name} ${emoji}`);
        assert.ok(name.length > 0);
      }
    }
    assert.ok(total > 1500, `only ${total} emoji`);
  });

  it('has no duplicates and the nine usual groups', () => {
    const all = EMOJI_GROUPS.flatMap((g) => g.emojis.map(([e]) => e));
    assert.equal(new Set(all).size, all.length);
    assert.deepEqual(EMOJI_GROUPS.map((g) => g.name), ['Smileys & Emotion', 'People & Body', 'Animals & Nature', 'Food & Drink', 'Travel & Places', 'Activities', 'Objects', 'Symbols', 'Flags']);
  });

  it('accepts country and region flags and refuses half a flag', () => {
    for (const e of ['🇺🇸', '🇮🇳', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '🏳️‍🌈', '🏴‍☠️']) assert.equal(isReactionEmoji(e), true, e);
    for (const e of ['🇺', '🇺🇸🇮🇳']) assert.equal(isReactionEmoji(e), false, e);
  });
});
