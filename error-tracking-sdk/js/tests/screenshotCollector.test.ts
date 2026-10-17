import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findMaskedElements, Html2Canvas, Html2CanvasOptions, maskClonedDocument, ScreenshotCollector } from '../src/collectors/screenshotCollector';
import { SCREENSHOT_MAX_WIDTH, SCREENSHOT_QUALITY } from '../src/constants';
import { Logger } from '../src/core/logger';

const MASKS = ['input[type="password"]', '.credit-card', '[data-private]'];
const logger = new Logger(false);

interface FakeCanvas {
  canvas: HTMLCanvasElement;
  fillRect: ReturnType<typeof vi.fn>;
  context: { fillStyle: string; fillRect: ReturnType<typeof vi.fn> };
}

function fakeCanvas(dataUrl = 'data:image/jpeg;base64,SHOT'): FakeCanvas {
  const fillRect = vi.fn();
  const context = { fillStyle: '', fillRect };
  const canvas = {
    getContext: () => context,
    toDataURL: vi.fn(() => dataUrl),
  } as unknown as HTMLCanvasElement;
  return { canvas, fillRect, context };
}

type WindowWithLib = Window & { html2canvas?: Html2Canvas };

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

describe('screenshot masking', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form>
        <input type="password" value="hunter2">
        <div class="credit-card"><img src="card.png"><span>4111 1111 1111 1111</span></div>
        <p data-private>Jane Doe, 221B Baker St</p>
        <p class="public">Order total: $42</p>
      </form>`;
  });

  it('finds every masked element and ignores invalid selectors', () => {
    expect(findMaskedElements(document, MASKS.concat(['[[bad']))).toHaveLength(3);
  });

  it('blacks out masked elements in the cloned DOM and blanks their values', () => {
    const clone = document.implementation.createHTMLDocument('clone');
    clone.body.innerHTML = document.body.innerHTML;
    maskClonedDocument(clone, MASKS);

    const password = clone.querySelector('input') as HTMLInputElement;
    expect(password.value).toBe('');
    expect(password.style.getPropertyValue('background')).toMatch(/#000000|rgb\(0, 0, 0\)/);

    const card = clone.querySelector('.credit-card') as HTMLElement;
    expect(card.style.getPropertyValue('color')).toMatch(/#000000|rgb\(0, 0, 0\)/);
    expect((card.querySelector('span') as HTMLElement).style.getPropertyValue('visibility')).toBe('hidden');
    expect((card.querySelector('img') as HTMLElement).style.getPropertyValue('visibility')).toBe('hidden');

    // Unmasked content is untouched; the live document is never modified.
    expect((clone.querySelector('.public') as HTMLElement).getAttribute('style')).toBeNull();
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('hunter2');
  });
});

describe('ScreenshotCollector', () => {
  let win: WindowWithLib;
  let now: number;

  beforeEach(() => {
    win = window as WindowWithLib;
    now = 100000;
    setVisibility('visible');
    document.body.innerHTML = `
      <input type="password" value="hunter2">
      <div class="credit-card">4111 1111 1111 1111</div>
      <p>public</p>`;
    vi.spyOn(document.querySelector('input') as Element, 'getBoundingClientRect').mockReturnValue(rect(10, 20, 200, 30));
    vi.spyOn(document.querySelector('.credit-card') as Element, 'getBoundingClientRect').mockReturnValue(rect(10, 80, 300, 50));
  });

  afterEach(() => {
    delete win.html2canvas;
    document.head.innerHTML = '';
  });

  function collector(): ScreenshotCollector {
    return new ScreenshotCollector({ maskSelectors: MASKS, libraryUrl: 'https://cdn.test/html2canvas.js', libraryIntegrity: 'sha384-test' }, logger, () => now);
  }

  it('paints black rectangles over every masked element and returns a JPEG data URL', async () => {
    const fake = fakeCanvas();
    let options: Html2CanvasOptions | null = null;
    win.html2canvas = vi.fn((_el: HTMLElement, opts: Html2CanvasOptions) => {
      options = opts;
      return Promise.resolve(fake.canvas);
    });

    const shot = await collector().capture();

    expect(shot).toBe('data:image/jpeg;base64,SHOT');
    expect(fake.context.fillStyle).toBe('#000000');
    expect(fake.fillRect).toHaveBeenCalledWith(10, 20, 200, 30);
    expect(fake.fillRect).toHaveBeenCalledWith(10, 80, 300, 50);
    expect(fake.fillRect).toHaveBeenCalledTimes(2);
    expect(fake.canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', SCREENSHOT_QUALITY);
    expect(options).toMatchObject({ logging: false, width: window.innerWidth, height: window.innerHeight });
  });

  it('downscales wide screens to at most the max width, masks included', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2560 });
    const fake = fakeCanvas();
    let options: Html2CanvasOptions | null = null;
    win.html2canvas = vi.fn((_el: HTMLElement, opts: Html2CanvasOptions) => {
      options = opts;
      return Promise.resolve(fake.canvas);
    });
    await collector().capture();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });

    expect((options as unknown as Html2CanvasOptions).scale).toBe(SCREENSHOT_MAX_WIDTH / 2560);
    expect(fake.fillRect).toHaveBeenCalledWith(5, 10, 100, 15); // the 10,20,200,30 rect at half scale
  });

  it('applies masking to the clone through the onclone hook', async () => {
    const fake = fakeCanvas();
    win.html2canvas = vi.fn((_el: HTMLElement, opts: Html2CanvasOptions) => {
      const clone = document.implementation.createHTMLDocument('clone');
      clone.body.innerHTML = document.body.innerHTML;
      opts.onclone(clone);
      expect((clone.querySelector('input') as HTMLInputElement).value).toBe('');
      return Promise.resolve(fake.canvas);
    });
    await collector().capture();
    expect(win.html2canvas).toHaveBeenCalled();
  });

  it('refuses to return an image when masks cannot be painted', async () => {
    win.html2canvas = vi.fn(() => Promise.resolve({ getContext: () => null, toDataURL: () => 'data:x' } as unknown as HTMLCanvasElement));
    expect(await collector().capture()).toBeNull();
  });

  it('skips capture when the page is hidden', async () => {
    setVisibility('hidden');
    win.html2canvas = vi.fn();
    expect(await collector().capture()).toBeNull();
    expect(win.html2canvas).not.toHaveBeenCalled();
  });

  it('throttles to one screenshot per 10 seconds', async () => {
    win.html2canvas = vi.fn(() => Promise.resolve(fakeCanvas().canvas));
    const c = collector();
    expect(await c.capture()).not.toBeNull();
    now += 5000;
    expect(await c.capture()).toBeNull();
    now += 5000;
    expect(await c.capture()).not.toBeNull();
  });

  it('drops oversized screenshots after retrying at lower quality', async () => {
    const huge = 'data:image/jpeg;base64,' + 'A'.repeat(1100000);
    win.html2canvas = vi.fn(() => Promise.resolve(fakeCanvas(huge).canvas));
    expect(await collector().capture()).toBeNull();
  });

  it('loads html2canvas from the CDN with SRI when it is not already present', async () => {
    const pending = collector().capture();
    const script = document.head.querySelector('script') as HTMLScriptElement;
    expect(script.src).toBe('https://cdn.test/html2canvas.js');
    expect(script.integrity).toBe('sha384-test');
    expect(script.crossOrigin).toBe('anonymous');

    win.html2canvas = vi.fn(() => Promise.resolve(fakeCanvas().canvas));
    script.dispatchEvent(new Event('load'));
    expect(await pending).toBe('data:image/jpeg;base64,SHOT');
  });

  it('resolves null (never rejects) when the library fails to load', async () => {
    const pending = collector().capture();
    (document.head.querySelector('script') as HTMLScriptElement).dispatchEvent(new Event('error'));
    expect(await pending).toBeNull();
  });

  it('times out after 3 seconds', async () => {
    vi.useFakeTimers();
    win.html2canvas = vi.fn(() => new Promise<HTMLCanvasElement>(() => {}));
    const pending = collector().capture();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBeNull();
    vi.useRealTimers();
  });
});
