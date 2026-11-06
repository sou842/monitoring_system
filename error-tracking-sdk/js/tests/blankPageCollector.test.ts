import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlankPageCollector, BlankPageDeepCheck, BlankPageSample, deepCheckPage, samplePage } from '../src/collectors/blankPageCollector';
import { NetworkInterceptor } from '../src/collectors/networkInterceptor';
import {
  BLANK_PAGE_CONFIRM_MS,
  BLANK_PAGE_MAX_REPORTS,
  BLANK_PAGE_MAX_WAIT_MS,
  BLANK_PAGE_PENDING_MAX_MS,
  BLANK_PAGE_QUIET_MS,
  BLANK_PAGE_TEXT_VETO_CHARS,
} from '../src/constants';
import { Logger } from '../src/core/logger';
import { JsonObject } from '../src/types';

const logger = new Logger(false);
const ENDPOINT = 'https://ingest.test/v1/events';
/** Long enough for one quiet-period check plus the confirmation wait. */
const SETTLE_MS = BLANK_PAGE_QUIET_MS + BLANK_PAGE_CONFIRM_MS + 100;

type DocWithPoints = Omit<Document, 'elementsFromPoint'> & { elementsFromPoint?: (x: number, y: number) => Element[] };

function element(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  const el = host.firstElementChild;
  if (el === null) throw new Error('bad html');
  document.body.appendChild(el);
  return el;
}

describe('samplePage', () => {
  const doc = document as unknown as DocWithPoints;
  const original = doc.elementsFromPoint;

  afterEach(() => {
    doc.elementsFromPoint = original;
    document.body.innerHTML = '';
  });

  function drawEverywhere(stack: Element[]): void {
    doc.elementsFromPoint = () => stack.concat([document.body, document.documentElement]);
  }

  it('is unsupported without elementsFromPoint', () => {
    doc.elementsFromPoint = undefined;
    expect(samplePage().supported).toBe(false);
  });

  it('sees content when text is drawn on top', () => {
    drawEverywhere([element('<p>Hello</p>')]);
    const sample = samplePage();
    expect(sample).toMatchObject({ supported: true, blank: false });
    // Stops at the first point with content.
    expect(sample.points).toBe(1);
  });

  it('counts images and inputs as content even without text', () => {
    drawEverywhere([element('<img alt="">')]);
    expect(samplePage().blank).toBe(false);
    drawEverywhere([element('<input>')]);
    expect(samplePage().blank).toBe(false);
  });

  it('is blank when only empty containers are drawn, after sampling all 17 points', () => {
    drawEverywhere([element('<div id="root"></div>')]);
    expect(samplePage()).toMatchObject({ blank: true, points: 17, covered: 0, coveredContent: 0 });
  });

  it('sees through transparent click-catchers to the content below', () => {
    const catcher = element('<div style="background-color: rgba(0, 0, 0, 0)"></div>');
    drawEverywhere([catcher, element('<p>Below</p>')]);
    expect(samplePage().blank).toBe(false);
  });

  it('is blank when an opaque empty overlay covers the content', () => {
    const overlay = element('<div style="background-color: rgb(255, 255, 255)"></div>');
    drawEverywhere([overlay, element('<p>Hidden</p>')]);
    expect(samplePage()).toMatchObject({ blank: true, covered: 17, coveredContent: 17 });
  });

  /** A paragraph in the top-left corner, away from both centre lines. */
  function cornerText(): Element {
    const p = element('<p>tiny label</p>');
    p.getBoundingClientRect = () => ({ left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30, x: 10, y: 10, toJSON: () => ({}) });
    return p;
  }
  const atCorner = (x: number, y: number) => x === 50 && y === 20;

  it('finds small content the grid misses by checking content elements in place', () => {
    const root = element('<div id="root"></div>');
    const p = cornerText();
    doc.elementsFromPoint = (x, y) => (atCorner(x, y) ? [p, root] : [root]);
    expect(samplePage()).toMatchObject({ blank: false, elementsChecked: 1 });
  });

  it('counts content hidden under an opaque overlay as covered', () => {
    const overlay = element('<div style="background-color: rgb(255, 255, 255)"></div>');
    const p = cornerText();
    doc.elementsFromPoint = (x, y) => (atCorner(x, y) ? [overlay, p] : [overlay]);
    expect(samplePage()).toMatchObject({ blank: true, elementsChecked: 1, coveredContent: 1 });
  });

  it('sees content that hit-testing skips (pointer-events: none) when nothing opaque covers it', () => {
    const root = element('<div id="root"></div>');
    cornerText();
    // elementsFromPoint never returns the paragraph, as with pointer-events: none.
    drawEverywhere([root]);
    expect(samplePage()).toMatchObject({ blank: false, elementsChecked: 1 });
  });

  it('skips hidden earlier screens so they do not use up the scan budget (Appzillon)', () => {
    const old = element('<div style="display: none"></div>');
    // Far more hidden nodes than BLANK_PAGE_MAX_NODES_SCANNED, all before the visible screen.
    old.innerHTML = new Array(3000).join('<span>old screen</span>');
    const root = element('<div id="root"></div>');
    cornerText();
    drawEverywhere([root]);
    expect(samplePage()).toMatchObject({ blank: false, elementsChecked: 1 });
  });

  it('ignores visibility:hidden and screen-reader-only (1×1 px) text', () => {
    const root = element('<div id="root"></div>');
    const hidden = cornerText();
    (hidden as HTMLElement).style.visibility = 'hidden';
    const srOnly = element('<a href="#main">Skip to content</a>');
    srOnly.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1, x: 0, y: 0, toJSON: () => ({}) });
    drawEverywhere([root]);
    // The hidden paragraph is hit-tested, then rejected for its style; the 1×1 link is never hit-tested.
    expect(samplePage()).toMatchObject({ blank: true, elementsChecked: 1 });
  });

  it('checks the element seen last time first, with a single hit test', () => {
    const root = element('<div id="root"></div>');
    const p = cornerText();
    let hitTests = 0;
    doc.elementsFromPoint = (x, y) => {
      hitTests++;
      return atCorner(x, y) ? [p, root] : [root];
    };
    const first = samplePage();
    expect(first.seen).toBe(p);
    hitTests = 0;
    expect(samplePage(first.seen)).toMatchObject({ blank: false, elementsChecked: 1 });
    expect(hitTests).toBe(1);
    // A removed element is not trusted.
    p.remove();
    expect(samplePage(first.seen).blank).toBe(true);
  });

  it('sees content drawn inside an open shadow root', () => {
    const host = element('<ion-content></ion-content>');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>Inside the component</p>';
    const inner = shadow.firstElementChild as Element;
    (shadow as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [inner, host];
    drawEverywhere([host]);
    expect(samplePage().blank).toBe(false);
  });

  it('treats content inside an opacity:0 ancestor as invisible', () => {
    const wrapper = element('<div style="opacity: 0"><p>Fading in</p></div>');
    drawEverywhere([wrapper.firstElementChild as Element, wrapper]);
    expect(samplePage().blank).toBe(true);
  });
});

describe('deepCheckPage', () => {
  const doc = document as unknown as DocWithPoints;
  const original = doc.elementsFromPoint;

  afterEach(() => {
    doc.elementsFromPoint = original;
    document.body.innerHTML = '';
  });

  /** Gives `el` a box in the top-left of the viewport. */
  function place(el: Element): Element {
    el.getBoundingClientRect = () => ({ left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30, x: 10, y: 10, toJSON: () => ({}) });
    return el;
  }

  it('is incomplete without elementsFromPoint, so nothing is reported', () => {
    doc.elementsFromPoint = undefined;
    expect(deepCheckPage()).toMatchObject({ complete: false });
  });

  it('is blank when nothing in the viewport has content', () => {
    element('<div id="root"></div>');
    doc.elementsFromPoint = () => [document.body, document.documentElement];
    expect(deepCheckPage()).toMatchObject({ complete: true, blank: true, elementsChecked: 0 });
  });

  it('checks every content element, with no node budget, skipping display:none subtrees', () => {
    const old = element('<div style="display: none"></div>');
    old.innerHTML = new Array(5000).join('<span>old screen</span>');
    const label = place(element('<p>Security parameters</p>'));
    doc.elementsFromPoint = () => [label, document.body, document.documentElement];
    expect(deepCheckPage()).toMatchObject({ complete: true, blank: false, elementsChecked: 1, seen: label });
  });

  it('sees text whose only opaque cover is its own panel (pointer-events: none text)', () => {
    const panel = element('<div style="background-color: rgb(255, 255, 255)"><span>Label</span></div>');
    place(panel.firstElementChild as Element);
    doc.elementsFromPoint = () => [panel, document.body, document.documentElement];
    expect(deepCheckPage()).toMatchObject({ blank: false });
  });

  it('counts content under a foreign opaque layer as covered', () => {
    const label = place(element('<p>Hidden</p>'));
    const overlay = element('<div style="background-color: rgb(255, 255, 255)"></div>');
    doc.elementsFromPoint = () => [overlay, label, document.body, document.documentElement];
    expect(deepCheckPage()).toMatchObject({ blank: true, elementsChecked: 1, coveredContent: 1 });
  });

  it('skips content outside the viewport', () => {
    const below = element('<p>Far below</p>');
    below.getBoundingClientRect = () => ({ left: 0, top: 5000, width: 80, height: 20, right: 80, bottom: 5020, x: 0, y: 5000, toJSON: () => ({}) });
    doc.elementsFromPoint = () => [document.body, document.documentElement];
    expect(deepCheckPage()).toMatchObject({ blank: true, elementsChecked: 0 });
  });
});

describe('BlankPageCollector', () => {
  let network: NetworkInterceptor;
  let collector: BlankPageCollector;
  let reports: Array<{ message: string; context: JsonObject }>;
  let blank: boolean;
  let coveredContent: number;
  let key: string;
  let deep: BlankPageDeepCheck;
  let originalFetch: typeof fetch;

  function sample(): BlankPageSample {
    return { supported: true, blank: blank, points: 17, covered: coveredContent, coveredContent: coveredContent, elementsChecked: 0, seen: null };
  }

  function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
    originalFetch = window.fetch;
    reports = [];
    blank = true;
    coveredContent = 0;
    key = 'screen:Home';
    deep = { complete: true, blank: true, elementsChecked: 0, coveredContent: 0, ms: 1, seen: null };
    network = new NetworkInterceptor(ENDPOINT, logger);
    collector = new BlankPageCollector(
      (message, context) => reports.push({ message, context }),
      network,
      () => key,
      logger,
      sample,
      () => deep,
    );
  });

  afterEach(() => {
    collector.uninstall();
    network.uninstall();
    window.fetch = originalFetch;
    delete (document as unknown as Record<string, unknown>).visibilityState;
    delete (document.body as unknown as Record<string, unknown>).innerText;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  function start(): void {
    collector.install();
    network.install();
  }

  it('reports a page that stays blank after load, with no error', async () => {
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports).toHaveLength(1);
    expect(reports[0].message).toBe('Blank page: nothing rendered and no error');
    expect(reports[0].context).toMatchObject({
      cause: 'nothing_rendered',
      trigger: 'load',
      error: null,
      request: null,
      pending_requests: 0,
      points_sampled: 17,
    });
    expect(reports[0].context.blank_for_ms).toBeGreaterThanOrEqual(BLANK_PAGE_CONFIRM_MS);
  });

  it('does not report a page that renders before the confirmation wait ends', async () => {
    start();
    await vi.advanceTimersByTimeAsync(BLANK_PAGE_QUIET_MS + 100);
    blank = false;
    await vi.advanceTimersByTimeAsync(BLANK_PAGE_CONFIRM_MS);
    expect(reports).toHaveLength(0);
  });

  it('waits for the DOM to go quiet, but not forever', async () => {
    start();
    // A DOM change every half quiet period keeps postponing the check…
    for (let t = 0; t < BLANK_PAGE_MAX_WAIT_MS; t += BLANK_PAGE_QUIET_MS / 2) {
      collector.scheduleCheck('dom_change');
      await vi.advanceTimersByTimeAsync(BLANK_PAGE_QUIET_MS / 2);
    }
    // …until the maximum wait, then the confirmation wait.
    await vi.advanceTimersByTimeAsync(BLANK_PAGE_CONFIRM_MS + 100);
    expect(reports).toHaveLength(1);
  });

  it('links the uncaught error that came before the blank page', async () => {
    blank = false;
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    blank = true;
    collector.noteError({ type: 'TypeError', message: "Cannot read properties of null (reading 'name')", handled: false }, null);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports).toHaveLength(1);
    expect(reports[0].context).toMatchObject({
      cause: 'js_error',
      trigger: 'error',
      error: { type: 'TypeError', message: "Cannot read properties of null (reading 'name')", handled: false },
    });
  });

  it('names a failed chunk as code_load_failed', async () => {
    start();
    collector.noteError({ type: 'TypeError', message: 'Failed to fetch dynamically imported module: /chunks/a.js', handled: false }, null);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports[0].context.cause).toBe('code_load_failed');
  });

  it('names a failed script element as resource_failed, but not a failed image', async () => {
    start();
    collector.noteError({ type: 'ResourceError', message: 'Failed to load <img> /a.png', handled: false }, null);
    collector.noteError({ type: 'ResourceError', message: 'Failed to load <script> /main.js', handled: false }, null);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports[0].context).toMatchObject({ cause: 'resource_failed', error: { message: 'Failed to load <script> /main.js' } });
  });

  it('names a 401 as session_expired and links the call, even though 401 is not an HttpError by default', async () => {
    window.fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 401 }))) as unknown as typeof fetch;
    blank = false;
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await window.fetch('https://api.test/session?token=x');
    blank = true;
    collector.scheduleCheck('dom_change');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports[0].context).toMatchObject({
      cause: 'session_expired',
      request: { url: 'https://api.test/session', method: 'GET', status: 401, failure: null },
    });
    expect(String((reports[0].context.request as JsonObject)._id)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('names a 500 as api_failed', async () => {
    window.fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))) as unknown as typeof fetch;
    start();
    await window.fetch('https://api.test/profile');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports[0].context.cause).toBe('api_failed');
  });

  it('gives a running API call time, then reports api_pending', async () => {
    window.fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    start();
    void window.fetch('https://api.test/slow');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(BLANK_PAGE_PENDING_MAX_MS);
    expect(reports).toHaveLength(1);
    expect(reports[0].context).toMatchObject({ cause: 'api_pending', pending_requests: 1 });
  });

  it('names a freeze as main_thread_blocked', async () => {
    start();
    collector.noteLongTask(4000);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports[0].context).toMatchObject({ cause: 'main_thread_blocked', main_thread_blocked_ms: 4000 });
  });

  it('names an empty overlay over real content as covered_by_overlay', async () => {
    coveredContent = 17;
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports[0].context.cause).toBe('covered_by_overlay');
  });

  it('ignores errors older than the cause window', async () => {
    blank = false;
    start();
    collector.noteError({ type: 'TypeError', message: 'old', handled: false }, null);
    await vi.advanceTimersByTimeAsync(60000);
    blank = true;
    collector.scheduleCheck('dom_change');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports[0].context).toMatchObject({ cause: 'nothing_rendered', error: null });
  });

  it('reports once per screen, and again on another screen', async () => {
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    collector.scheduleCheck('dom_change');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports).toHaveLength(1);
    key = 'screen:Profile';
    collector.scheduleCheck('screen_change');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports).toHaveLength(2);
    expect(reports[1].context.trigger).toBe('screen_change');
  });

  it(`stops after ${BLANK_PAGE_MAX_REPORTS} reports per page load`, async () => {
    start();
    for (let i = 0; i < BLANK_PAGE_MAX_REPORTS + 2; i++) {
      key = 'screen:' + i;
      collector.scheduleCheck('screen_change');
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    }
    expect(reports).toHaveLength(BLANK_PAGE_MAX_REPORTS);
  });

  it('does not check a hidden tab, and checks again when it is shown', async () => {
    setVisibility('hidden');
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports).toHaveLength(0);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports).toHaveLength(1);
  });

  it('checks after DOM mutations', async () => {
    blank = false;
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    blank = true;
    document.body.appendChild(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports).toHaveLength(1);
    expect(reports[0].context.trigger).toBe('dom_change');
  });

  it('never throws when the sampler throws', async () => {
    collector = new BlankPageCollector(() => {}, network, () => key, logger, () => {
      throw new Error('boom');
    });
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports).toHaveLength(0);
  });

  function setRenderedText(text: string): void {
    Object.defineProperty(document.body, 'innerText', { configurable: true, get: () => text });
  }

  it('needs three blank checks spread over the confirmation time', async () => {
    let checks = 0;
    collector = new BlankPageCollector((message, context) => reports.push({ message, context }), network, () => key, logger, () => {
      checks++;
      return sample();
    }, () => deep);
    setRenderedText(' \n ');
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(checks).toBe(3);
    expect(reports).toHaveLength(1);
    expect(reports[0].context).toMatchObject({ samples: 3, confidence: 'high', deep_check: { elements_checked: 0, covered: 0, ms: 1 } });
  });

  it('does not report when the full check finds visible content, and remembers it', async () => {
    const seen = document.body.appendChild(document.createElement('p'));
    deep = { complete: true, blank: false, elementsChecked: 3, coveredContent: 0, ms: 2, seen: seen };
    const hints: Array<Element | null> = [];
    collector = new BlankPageCollector(() => {}, network, () => key, logger, (hint) => {
      hints.push(hint);
      return sample();
    }, () => deep);
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    collector.scheduleCheck('dom_change');
    await vi.advanceTimersByTimeAsync(BLANK_PAGE_QUIET_MS + 100);
    // The next quick check starts from the element the full check saw.
    expect(hints[hints.length - 1]).toBe(seen);
  });

  it('does not report when the full check runs out of time', async () => {
    deep = { complete: false, blank: true, elementsChecked: 50, coveredContent: 0, ms: 51, seen: null };
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports).toHaveLength(0);
  });

  it(`does not report when the browser renders more than ${BLANK_PAGE_TEXT_VETO_CHARS} characters of text`, async () => {
    setRenderedText('x'.repeat(BLANK_PAGE_TEXT_VETO_CHARS + 1));
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports).toHaveLength(0);
  });

  it('still reports text hidden by a proven overlay', async () => {
    setRenderedText('x'.repeat(BLANK_PAGE_TEXT_VETO_CHARS + 1));
    deep = { complete: true, blank: true, elementsChecked: 4, coveredContent: 4, ms: 1, seen: null };
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports[0].context).toMatchObject({ cause: 'covered_by_overlay', confidence: 'high' });
  });

  it('reports a little text with medium confidence', async () => {
    setRenderedText('Loading');
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports[0].context).toMatchObject({ confidence: 'medium', visible_text_chars: 7 });
  });

  it('does not report while the user clicks real controls, but does after clicks on the empty page', async () => {
    const button = document.body.appendChild(document.createElement('button'));
    button.textContent = 'Save';
    start();
    await vi.advanceTimersByTimeAsync(BLANK_PAGE_QUIET_MS + 1000);
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports).toHaveLength(0);

    collector.scheduleCheck('dom_change');
    await vi.advanceTimersByTimeAsync(BLANK_PAGE_QUIET_MS + 100);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports).toHaveLength(1);
  });

  it('stops checking after uninstall', async () => {
    start();
    collector.uninstall();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(reports).toHaveLength(0);
  });
});

describe('NetworkInterceptor.pendingRequests', () => {
  it('counts app requests in flight, not the SDK endpoint', async () => {
    const originalFetch = window.fetch;
    const resolvers: Array<(r: Response) => void> = [];
    window.fetch = vi.fn(() => new Promise<Response>((r) => resolvers.push(r))) as unknown as typeof fetch;
    const network = new NetworkInterceptor(ENDPOINT, logger);
    network.install();
    const first = window.fetch('https://api.test/a');
    const second = window.fetch('https://api.test/b');
    const sdk = window.fetch(ENDPOINT);
    expect(network.pendingRequests()).toBe(2);
    resolvers[0](new Response('{}'));
    resolvers[2](new Response('{}'));
    await first;
    await sdk;
    expect(network.pendingRequests()).toBe(1);
    resolvers[1](new Response('{}'));
    await second;
    expect(network.pendingRequests()).toBe(0);
    void window.fetch('https://api.test/c');
    network.uninstall();
    expect(network.pendingRequests()).toBe(0);
    window.fetch = originalFetch;
  });
  it('does not count a fetch that throws synchronously as running', () => {
    const originalFetch = window.fetch;
    window.fetch = vi.fn(() => {
      throw new TypeError('bad init');
    }) as unknown as typeof fetch;
    const network = new NetworkInterceptor(ENDPOINT, logger);
    network.install();
    expect(() => window.fetch('https://api.test/a')).toThrow('bad init');
    expect(network.pendingRequests()).toBe(0);
    network.uninstall();
    window.fetch = originalFetch;
  });

  it('does not count an XHR re-opened while running (cancelled without events) as running', () => {
    const originalSend = XMLHttpRequest.prototype.send;
    // No real network: the request stays in flight until open() is called again.
    XMLHttpRequest.prototype.send = function noop() {};
    const network = new NetworkInterceptor(ENDPOINT, logger);
    network.install();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.test/poll');
    xhr.send();
    expect(network.pendingRequests()).toBe(1);
    xhr.open('GET', 'https://api.test/poll');
    expect(network.pendingRequests()).toBe(0);
    network.uninstall();
    XMLHttpRequest.prototype.send = originalSend;
  });
});

