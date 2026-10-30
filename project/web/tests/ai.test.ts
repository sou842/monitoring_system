import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
import { breakdown, cappedJson, issueContext } from '../server/ai/context.ts';
import { apiKeys, rotatingFetch } from '../server/ai/nvidia.ts';
import type { EventDoc, IssueDoc } from '../server/models.ts';
import { fusionChartsError, serverCallFailed } from './insights.fixtures.ts';

describe('AI: NVIDIA keys', () => {
  it('reads comma-separated keys, ignoring blanks', () => {
    assert.deepEqual(apiKeys(' a , b,,c '), ['a', 'b', 'c']);
    assert.deepEqual(apiKeys(''), []);
    assert.deepEqual(apiKeys(undefined), []);
  });

  it('starts each request with the next key and moves on after 429/401/403', async () => {
    const seen: string[] = [];
    const statuses: Record<string, number> = { k1: 429, k2: 200, k3: 200 };
    const fake = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('Authorization')!.replace('Bearer ', ''); // set by rotatingFetch
      seen.push(key);
      return new Response('{}', { status: statuses[key] });
    }) as typeof fetch;
    const f = rotatingFetch(['k1', 'k2', 'k3'], fake);
    const statusesSeen: number[] = [];
    for (let i = 0; i < 3; i++) statusesSeen.push((await f('https://x', {})).status);
    // Every request ends on a working key; k1 hands over to k2 whenever it comes first.
    assert.deepEqual(statusesSeen, [200, 200, 200]);
    assert.ok(seen.includes('k1') && seen.includes('k2') && seen.includes('k3'));
    for (let i = 0; i < seen.length; i++) if (seen[i] === 'k1') assert.equal(seen[i + 1], 'k2');
  });

  it('returns the last answer when every key is refused', async () => {
    const fake = (async () => new Response('{}', { status: 429 })) as typeof fetch;
    assert.equal((await rotatingFetch(['a', 'b'], fake)('https://x', {})).status, 429);
  });
});

const issueId = new ObjectId();
const projectId = new ObjectId();

function eventDoc(payload: object, overrides: Partial<EventDoc> = {}): EventDoc {
  const p = payload as EventDoc['payload'];
  return {
    _id: new ObjectId(), projectId, issueId,
    receivedAt: new Date('2026-10-27T12:48:00.000Z'), timestamp: new Date('2026-10-27T12:47:54.446Z'),
    eventType: 'error', level: 'error', environment: 'production', appVersion: '1.0.0',
    errorType: p.error ? p.error.type : null, message: p.error ? p.error.message : null, handled: p.error ? p.error.handled : null,
    userId: null, url: 'http://localhost:8080/AppzillonAdmin/', screen: 'Dashboard', platform: 'web',
    // The fixtures have no device block.
    payload: { ...p, device: p.device ?? ({ browser: 'Chrome', browser_version: '141.0.1', os: 'Windows' } as EventDoc['payload']['device']) },
    ...overrides,
  };
}

const issue: IssueDoc = {
  _id: issueId, projectId, fingerprint: 'f', eventType: 'error', errorType: 'TypeError',
  message: "Cannot read properties of undefined (reading 'node')", culprit: 'r._crCreate (fusioncharts.js)', level: 'error',
  status: 'open', count: 7, firstSeen: new Date('2026-10-20T00:00:00Z'), lastSeen: new Date('2026-10-27T12:48:00Z'),
  environments: ['production'], platforms: ['web'],
};

describe('AI: issue context', () => {
  it('describes the issue, the event on screen with the dashboard analysis, and the full JSON', () => {
    const event = eventDoc(fusionChartsError);
    const text = issueContext({ issue, project: { name: 'Appzillon admin', insights: undefined }, event, events: [event] });
    assert.match(text, /Project: Appzillon admin/);
    assert.match(text, /Occurrences: 7 total/);
    assert.match(text, /During: server call "appzillonFetchLicenseKey", in its callback getFusionChartLicenseKeyCB/);
    assert.match(text, /Where to look \(first app frame\): .*getFusionChartLicenseKeyCB/);
    assert.match(text, /library:FusionCharts/);
    assert.match(text, /launchSubScreen: Dashboard/);
    assert.match(text, /TypeError: Cannot read properties of undefined \(reading 'node'\)\n {4}at r\._crCreate/);
    assert.ok(text.includes(`id ${String(event._id)}`));
    assert.ok(text.includes('"iface":"appzillonFetchLicenseKey"'));
  });

  it('says so when no event is stored', () => {
    assert.match(issueContext({ issue, project: null, event: null, events: [] }), /No event is stored/);
  });

  it('counts events per screen, browser, version and day', () => {
    const events = [
      eventDoc(serverCallFailed, { screen: 'Dashboard' }),
      eventDoc(serverCallFailed, { screen: 'Dashboard', appVersion: '1.1.0' }),
      eventDoc(serverCallFailed, { screen: 'Users', userId: 'u1' }),
    ];
    const text = breakdown(events);
    assert.match(text, /^3 stored event\(s\).*1 distinct user id/);
    assert.match(text, /Screens: Dashboard 2 \(67%\), Users 1 \(33%\)/);
    assert.match(text, /App versions: 1\.0\.0 2 \(67%\), 1\.1\.0 1 \(33%\)/);
    assert.match(text, /Browsers: Chrome 141 3 \(100%\)/);
  });

  it('cuts very large JSON', () => {
    assert.equal(cappedJson({ a: 1 }), '{"a":1}');
    assert.match(cappedJson({ a: 'x'.repeat(100) }, 20), /^.{20}… \[cut: \d+ more characters\]$/);
  });
});
