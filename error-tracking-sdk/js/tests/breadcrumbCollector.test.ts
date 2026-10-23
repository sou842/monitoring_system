import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BreadcrumbCollector, cssPath, describeElementText } from '../src/collectors/breadcrumbCollector';
import { NetworkInterceptor } from '../src/collectors/networkInterceptor';
import { CircularBuffer } from '../src/core/circularBuffer';
import { Logger } from '../src/core/logger';
import { RecordingSink, settle } from './helpers';

const MASK = ['input[type="password"]', '.pii'];

describe('CircularBuffer', () => {
  it('keeps only the newest items in insertion order', () => {
    const buffer = new CircularBuffer<number>(3);
    for (let i = 1; i <= 5; i++) buffer.push(i);
    expect(buffer.toArray()).toEqual([3, 4, 5]);
    expect(buffer.size).toBe(3);
  });

  it('handles zero capacity and clear()', () => {
    const empty = new CircularBuffer<number>(0);
    empty.push(1);
    expect(empty.toArray()).toEqual([]);

    const buffer = new CircularBuffer<number>(2);
    buffer.push(1);
    buffer.clear();
    expect(buffer.toArray()).toEqual([]);
  });
});

describe('element helpers', () => {
  it('builds a short CSS path stopping at an id', () => {
    document.body.innerHTML = '<form id="checkout"><div class="actions main extra"><button class="btn primary">Pay</button></div></form>';
    const button = document.querySelector('button') as Element;
    expect(cssPath(button)).toBe('form#checkout > div.actions.main > button.btn.primary');
  });

  it('never exposes form values or masked text', () => {
    document.body.innerHTML =
      '<input name="card" value="4111111111111111"><div class="pii"><span>Jane Doe</span></div><button aria-label="Pay now">$</button>';
    expect(describeElementText(document.querySelector('input') as Element, MASK)).toBe('card');
    expect(describeElementText(document.querySelector('span') as Element, MASK)).toBe('[masked]');
    expect(describeElementText(document.querySelector('button') as Element, MASK)).toBe('Pay now');
  });

  it('ignores invalid mask selectors', () => {
    document.body.innerHTML = '<p>hello</p>';
    expect(describeElementText(document.querySelector('p') as Element, ['[[invalid'])).toBe('hello');
  });

  it('reads no text for clicks on the page itself (body, html)', () => {
    document.body.innerHTML = '<svg><symbol id="accordion-down"></symbol></svg><p>accessibility accordion-down</p>';
    expect(describeElementText(document.body, MASK)).toBe('');
    expect(describeElementText(document.documentElement, MASK)).toBe('');
  });
});

describe('BreadcrumbCollector', () => {
  let sink: RecordingSink;
  let network: NetworkInterceptor;
  let collector: BreadcrumbCollector;
  const logger = new Logger(false);

  beforeEach(() => {
    window.history.replaceState(null, '', '/start');
    sink = new RecordingSink();
    network = new NetworkInterceptor('https://ingest.test/v1/events', logger);
    collector = new BreadcrumbCollector(sink, network, MASK, logger);
    collector.install();
    network.install();
  });

  afterEach(() => {
    collector.uninstall();
    network.uninstall();
    document.body.innerHTML = '';
  });

  it('records clicks on the nearest interactive element', () => {
    document.body.innerHTML = '<button id="pay"><span>Pay Now</span></button>';
    (document.querySelector('span') as HTMLElement).click();

    expect(sink.breadcrumbs).toEqual([
      { type: 'click', message: 'Clicked Pay Now', data: { tag: 'button', text: 'Pay Now', selector: 'button#pay' } },
    ]);
  });

  it('masks clicks inside masked regions', () => {
    document.body.innerHTML = '<div class="pii"><a href="#">jane@example.com</a></div>';
    (document.querySelector('a') as HTMLElement).click();
    expect(sink.breadcrumbs[0].message).toBe('Clicked [masked]');
  });

  it('records pushState and popstate navigations', () => {
    window.history.pushState(null, '', '/checkout?session=abc');
    expect(sink.breadcrumbs[0]).toEqual({
      type: 'navigation',
      message: 'Navigated to http://localhost:3000/checkout',
      data: { from: 'http://localhost:3000/start', to: 'http://localhost:3000/checkout', trigger: 'pushState' },
    });

    window.history.replaceState(null, '', '/cart');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(sink.breadcrumbs.map((b) => b.data && (b.data as { trigger: string }).trigger)).toEqual(['pushState', 'replaceState']);
  });

  it('records console.warn and console.error but still calls the original', () => {
    const spy = vi.fn();
    collector.uninstall();
    const originalWarn = console.warn;
    console.warn = spy;
    collector.install();

    console.warn('low stock', { sku: 'A1' });
    console.error(new Error('render failed'));

    expect(spy).toHaveBeenCalledWith('low stock', { sku: 'A1' });
    expect(sink.breadcrumbs).toEqual([
      { type: 'log', message: 'low stock {"sku":"A1"}', data: { level: 'warn' } },
      { type: 'log', message: 'render failed', data: { level: 'error' } },
    ]);

    collector.uninstall();
    expect(console.warn).toBe(spy);
    console.warn = originalWarn;
  });

  it('records fetch calls with method, status and duration, skipping the SDK endpoint', async () => {
    collector.uninstall();
    network.uninstall();
    const fakeFetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 201 })));
    const originalFetch = window.fetch;
    window.fetch = fakeFetch as unknown as typeof fetch;
    network = new NetworkInterceptor('https://ingest.test/v1/events', logger);
    collector = new BreadcrumbCollector(sink, network, MASK, logger);
    collector.install();
    network.install();

    await window.fetch('https://api.test/cart?id=1', { method: 'post' });
    await window.fetch('https://ingest.test/v1/events', { method: 'POST' });
    await settle();

    expect(sink.breadcrumbs).toHaveLength(1);
    expect(sink.breadcrumbs[0]).toMatchObject({
      type: 'api',
      message: 'POST https://api.test/cart → 201',
      data: { url: 'https://api.test/cart', method: 'POST', status: 201, duration_ms: expect.any(Number) },
    });

    network.uninstall();
    expect(window.fetch).toBe(fakeFetch);
    window.fetch = originalFetch;
  });

  it('records failed fetch calls with status 0 and rethrows the error', async () => {
    collector.uninstall();
    network.uninstall();
    const originalFetch = window.fetch;
    window.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    network = new NetworkInterceptor('https://ingest.test/v1/events', logger);
    collector = new BreadcrumbCollector(sink, network, MASK, logger);
    collector.install();
    network.install();

    await expect(window.fetch('https://api.test/down')).rejects.toThrow('Failed to fetch');
    expect(sink.breadcrumbs[0].message).toBe('GET https://api.test/down → network');
    expect(sink.breadcrumbs[0].data).toMatchObject({ status: 0, failure: 'network' });

    network.uninstall();
    window.fetch = originalFetch;
  });

  it('records XMLHttpRequest calls', () => {
    // Drive the wrapped XHR without real networking by emitting loadend manually.
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', 'https://api.test/profile?x=1');
    vi.spyOn(XMLHttpRequest.prototype, 'send');
    Object.defineProperty(xhr, 'status', { value: 204 });
    try {
      xhr.send();
    } catch (_e) {
      // jsdom may reject the network attempt; we only care about the hook.
    }
    xhr.dispatchEvent(new Event('loadend'));

    const api = sink.breadcrumbs.filter((b) => b.type === 'api');
    expect(api[0]).toMatchObject({ message: 'PUT https://api.test/profile → 204' });
  });

  it('records page visibility changes as lifecycle breadcrumbs', () => {
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sink.breadcrumbs[0]).toEqual({ type: 'lifecycle', message: 'Page visible' });
  });
});
