import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AI_CHAT_MAX_AGE_MS, AI_CHATS_PER_USER, chatSignature, chatsToPrune, type ChatMeta } from '../lib/client/aiChats.ts';

const NOW = Date.UTC(2026, 10, 4);
const chat = (userId: string, n: number, ageMs: number): ChatMeta => ({ key: `${userId}:${n}`, userId, updatedAt: NOW - ageMs });

describe('saved AI chats pruning', () => {
  it('keeps everything under the limits', () => {
    assert.deepEqual(chatsToPrune([chat('a', 1, 0), chat('a', 2, 1000)], NOW), []);
  });

  it('drops chats older than the max age', () => {
    const drop = chatsToPrune([chat('a', 1, AI_CHAT_MAX_AGE_MS - 1), chat('a', 2, AI_CHAT_MAX_AGE_MS), chat('b', 3, AI_CHAT_MAX_AGE_MS * 2)], NOW);
    assert.deepEqual(drop.sort(), ['a:2', 'b:3']);
  });

  it('keeps only the most recent chats per user, counted separately per user', () => {
    const a = Array.from({ length: AI_CHATS_PER_USER + 3 }, (_, i) => chat('a', i, i * 1000)); // a:0 is the newest
    const b = Array.from({ length: 5 }, (_, i) => chat('b', i, i * 1000));
    const drop = chatsToPrune([...a.reverse(), ...b], NOW);
    assert.deepEqual(drop.sort(), [`a:${AI_CHATS_PER_USER}`, `a:${AI_CHATS_PER_USER + 1}`, `a:${AI_CHATS_PER_USER + 2}`].sort());
  });

  it('treats a broken timestamp as expired', () => {
    assert.deepEqual(chatsToPrune([{ key: 'a:1', userId: 'a', updatedAt: Number.NaN }], NOW), ['a:1']);
  });
});

describe('chat signature', () => {
  it('changes when a message is added and not otherwise', () => {
    const a = [{ id: 'm1' }, { id: 'm2' }];
    assert.equal(chatSignature(a), chatSignature([{ id: 'm1' }, { id: 'm2' }]));
    assert.notEqual(chatSignature(a), chatSignature([...a, { id: 'm3' }]));
    assert.notEqual(chatSignature(a), chatSignature([{ id: 'm1' }, { id: 'other' }]));
    assert.equal(chatSignature([]), '0:');
  });
});
