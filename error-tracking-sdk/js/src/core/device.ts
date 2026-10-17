import { PLATFORM } from '../constants';
import { DevicePayload } from '../types';
import { getDocument, getNavigator, getWindow, stripQuery } from './env';

/** Browser/OS identity parsed from a user-agent string. */
export interface ParsedUserAgent {
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  osVersion: string | null;
  model: string | null;
}

/** Subset of the User-Agent Client Hints API (Chromium only). */
interface UADataValues {
  platform?: string;
  platformVersion?: string;
  model?: string;
}
interface NavigatorUAData {
  getHighEntropyValues(hints: string[]): Promise<UADataValues>;
}

/** Windows 11 reports a UA-CH platformVersion of 13.0.0 or higher. */
const WINDOWS_11_MIN_PLATFORM_MAJOR = 13;

// Order matters: Edge and Opera also contain "Chrome", Chrome also contains "Safari".
const BROWSER_RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'Edge', pattern: /Edg(?:e|A|iOS)?\/([\d.]+)/ },
  { name: 'Opera', pattern: /(?:OPR|Opera)\/([\d.]+)/ },
  { name: 'Samsung Internet', pattern: /SamsungBrowser\/([\d.]+)/ },
  { name: 'Firefox', pattern: /(?:Firefox|FxiOS)\/([\d.]+)/ },
  { name: 'Chrome', pattern: /(?:Chrome|CriOS)\/([\d.]+)/ },
  { name: 'Safari', pattern: /Version\/([\d.]+).*Safari/ },
  { name: 'Node.js', pattern: /Node\.js\/v?([\d.]+)/ },
];

const WINDOWS_NT_VERSIONS: Record<string, string> = {
  '10.0': '10',
  '6.3': '8.1',
  '6.2': '8',
  '6.1': '7',
};

/** Pure user-agent parser; exported for testing. */
export function parseUserAgent(ua: string): ParsedUserAgent {
  const result: ParsedUserAgent = {
    browser: null,
    browserVersion: null,
    os: null,
    osVersion: null,
    model: null,
  };

  for (let i = 0; i < BROWSER_RULES.length; i++) {
    const match = BROWSER_RULES[i].pattern.exec(ua);
    if (match !== null) {
      result.browser = BROWSER_RULES[i].name;
      result.browserVersion = majorMinor(match[1]);
      break;
    }
  }

  let m: RegExpExecArray | null;
  if ((m = /Windows NT ([\d.]+)/.exec(ua)) !== null) {
    const name = WINDOWS_NT_VERSIONS[m[1]];
    result.os = name !== undefined ? 'Windows ' + name : 'Windows';
    result.osVersion = m[1];
  } else if ((m = /Android ([\d.]+)/.exec(ua)) !== null) {
    result.os = 'Android ' + m[1].split('.')[0];
    result.osVersion = m[1];
    const model = /Android [\d.]+; (?:[a-z]{2}-[a-z]{2}; )?([^;)]+?)(?: Build\/[^;)]*)?\)/i.exec(ua);
    if (model !== null && model[1] !== 'K') result.model = model[1].trim();
  } else if ((m = /(?:iPhone|iPad|iPod).*? OS ([\d_]+)/.exec(ua)) !== null) {
    const version = m[1].replace(/_/g, '.');
    result.os = 'iOS ' + majorMinor(version);
    result.osVersion = version;
    const device = /(iPhone|iPad|iPod)/.exec(ua);
    result.model = device !== null ? device[1] : null;
  } else if ((m = /Mac OS X ([\d_.]+)/.exec(ua)) !== null) {
    const version = m[1].replace(/_/g, '.');
    result.os = 'macOS ' + majorMinor(version);
    result.osVersion = version;
  } else if (/CrOS/.test(ua)) {
    result.os = 'ChromeOS';
  } else if (/Linux/.test(ua)) {
    result.os = 'Linux';
  }

  return result;
}

function majorMinor(version: string): string {
  const parts = version.split('.');
  return parts.length > 1 ? parts[0] + '.' + parts[1] : parts[0] + '.0';
}

/**
 * Collects static device information once, then refines the OS name
 * asynchronously using UA Client Hints where the browser supports them.
 */
export class DeviceInfo {
  private parsed: ParsedUserAgent;

  constructor() {
    const nav = getNavigator();
    this.parsed = parseUserAgent(nav !== null && typeof nav.userAgent === 'string' ? nav.userAgent : '');
  }

  /** Best-effort async refinement (distinguishes Windows 11 from 10, adds Android model). */
  refine(): Promise<void> {
    const nav = getNavigator() as (Navigator & { userAgentData?: NavigatorUAData }) | null;
    if (nav === null || nav.userAgentData === undefined) return Promise.resolve();

    const self = this;
    return nav.userAgentData
      .getHighEntropyValues(['platformVersion', 'model'])
      .then(function apply(values) {
        if (values.platform === 'Windows' && typeof values.platformVersion === 'string') {
          const major = parseInt(values.platformVersion.split('.')[0], 10);
          // Only used to tell 10 from 11: platformVersion is an internal number
          // (e.g. "8.0.0" on Windows 10 1903), so os_version keeps the NT version from the UA.
          self.parsed.os = major >= WINDOWS_11_MIN_PLATFORM_MAJOR ? 'Windows 11' : 'Windows 10';
        }
        if (typeof values.model === 'string' && values.model.length > 0) {
          self.parsed.model = values.model;
        }
      })
      .catch(function ignore() {
        // Client hints are optional; UA-derived values remain.
      });
  }

  /** Snapshot for a payload; URL and screen size are read fresh each time. */
  snapshot(): DevicePayload {
    const win = getWindow();
    const doc = getDocument();
    const nav = getNavigator();
    const screen = win !== null ? win.screen : undefined;

    return {
      platform: PLATFORM,
      os: this.parsed.os,
      os_version: this.parsed.osVersion,
      manufacturer: null,
      model: this.parsed.model,
      browser: this.parsed.browser,
      browser_version: this.parsed.browserVersion,
      screen_width: screen !== undefined ? screen.width : null,
      screen_height: screen !== undefined ? screen.height : null,
      url: win !== null && win.location !== undefined ? stripQuery(win.location.href) : null,
      referrer: doc !== null && doc.referrer.length > 0 ? stripQuery(doc.referrer) : null,
      locale: nav !== null && typeof nav.language === 'string' ? nav.language : null,
    };
  }
}
