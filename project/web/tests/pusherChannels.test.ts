import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectIdOfChannel } from '../server/pusher.ts';

const id = 'a'.repeat(24);

test('both chat channels map to their project; anything else is rejected', () => {
  assert.equal(projectIdOfChannel(`private-project-${id}`), id);
  assert.equal(projectIdOfChannel(`presence-project-${id}`), id);
  assert.equal(projectIdOfChannel(`presence-project-${id}x`), null);
  assert.equal(projectIdOfChannel(`public-project-${id}`), null);
  assert.equal(projectIdOfChannel('presence-project-123'), null);
});
