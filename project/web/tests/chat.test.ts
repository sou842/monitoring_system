/** Unit tests for the server-side chat helpers that need no database. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
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
