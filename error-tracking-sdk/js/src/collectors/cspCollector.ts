import { MAX_MESSAGE_LENGTH, UNKNOWN_FUNCTION } from '../constants';
import { getDocument, stripQuery } from '../core/env';
import { Logger } from '../core/logger';
import { guard, safelyRun } from '../core/safe';
import { truncate } from '../core/serialize';
import { StackFrame } from '../types';
import { CapturedError, Collector, CollectorSink } from './collector';

const CSP_ERROR_TYPE = 'CspViolation';
const CSP_REPORT_TYPE = 'csp-violation';
/** blockedURI values that are keywords rather than URLs. */
const CSP_KEYWORDS = ['inline', 'eval', 'self', 'data', 'blob', 'wasm-eval', 'trusted-types-policy', 'trusted-types-sink'];

/** The fields shared by `SecurityPolicyViolationEvent` and the Reporting API's CSP report body. */
export interface CspViolation {
  blocked: string;
  directive: string;
  disposition: string | null;
  sourceFile: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
}

/** Reporting API `csp-violation` report body (not in every TypeScript DOM lib). */
interface CspReportBody {
  blockedURL?: string | null;
  effectiveDirective?: string;
  disposition?: string;
  sourceFile?: string | null;
  lineNumber?: number | null;
  columnNumber?: number | null;
}

interface ReportLike {
  type: string;
  body: unknown;
}

type ReportingObserverConstructor = new (
  callback: (reports: ReportLike[]) => void,
  options: { types: string[]; buffered: boolean },
) => { observe(): void; disconnect(): void };

export function violationFromEvent(event: SecurityPolicyViolationEvent): CspViolation {
  return {
    blocked: event.blockedURI || 'inline',
    directive: event.effectiveDirective || event.violatedDirective || 'unknown-directive',
    disposition: event.disposition || null,
    sourceFile: event.sourceFile || null,
    lineNumber: event.lineNumber || null,
    columnNumber: event.columnNumber || null,
  };
}

export function violationFromReport(body: CspReportBody): CspViolation {
  return {
    blocked: body.blockedURL || 'inline',
    directive: body.effectiveDirective || 'unknown-directive',
    disposition: body.disposition || null,
    sourceFile: body.sourceFile || null,
    lineNumber: body.lineNumber || null,
    columnNumber: body.columnNumber || null,
  };
}

/** Builds the error for one Content-Security-Policy violation. */
export function cspError(violation: CspViolation): CapturedError {
  const blockedLabel = CSP_KEYWORDS.indexOf(violation.blocked) !== -1 ? violation.blocked : stripQuery(violation.blocked);
  const verb = violation.disposition === 'report' ? 'would block' : 'blocked';

  const stacktrace: StackFrame[] =
    violation.sourceFile !== null
      ? [{ filename: stripQuery(violation.sourceFile), lineno: violation.lineNumber, colno: violation.columnNumber, function: UNKNOWN_FUNCTION }]
      : [];

  return {
    error: {
      message: truncate('CSP ' + verb + ' ' + blockedLabel + ' (' + violation.directive + ')', MAX_MESSAGE_LENGTH),
      type: CSP_ERROR_TYPE,
      handled: false,
    },
    stacktrace: stacktrace,
    context: {
      directive: violation.directive,
      blocked_uri: blockedLabel,
      disposition: violation.disposition,
      // The browser's `sample` field (first characters of blocked inline code) is
      // deliberately not kept: it can contain anything, including PII.
    },
  };
}

/**
 * Reports Content-Security-Policy violations (enforced and report-only),
 * such as a blocked third-party script, an inline script without a nonce or
 * a disallowed `eval`.
 *
 * Where the Reporting API exists (Chromium), a buffered `ReportingObserver`
 * is used: it also delivers violations that happened while the page's HTML
 * was still loading, before the SDK started. Other browsers fall back to the
 * `securitypolicyviolation` event, which only sees violations after init.
 */
export class CspCollector implements Collector {
  private installed = false;
  private observer: { observe(): void; disconnect(): void } | null = null;
  private readonly handleEvent: (event: SecurityPolicyViolationEvent) => void;
  private readonly handleReports: (reports: ReportLike[]) => void;

  constructor(
    private readonly sink: CollectorSink,
    private readonly logger: Logger,
    private readonly reportingObserver: ReportingObserverConstructor | null = defaultReportingObserver(),
  ) {
    const self = this;
    const report = function report(violation: CspViolation) {
      self.sink.onError(cspError(violation));
    };
    this.handleEvent = guard(logger, 'CSP violation handler', function onViolation(event: SecurityPolicyViolationEvent) {
      report(violationFromEvent(event));
    });
    this.handleReports = guard(logger, 'CSP report handler', function onReports(reports: ReportLike[]) {
      for (let i = 0; i < reports.length; i++) {
        if (reports[i].type === CSP_REPORT_TYPE) report(violationFromReport(reports[i].body as CspReportBody));
      }
    });
  }

  install(): void {
    const doc = getDocument();
    if (this.installed || doc === null) return;
    this.installed = true;

    const Observer = this.reportingObserver;
    if (Observer !== null) {
      const self = this;
      safelyRun(this.logger, 'CSP reporting observer', function observe() {
        const observer = new Observer(self.handleReports, { types: [CSP_REPORT_TYPE], buffered: true });
        observer.observe();
        self.observer = observer;
      });
      if (this.observer !== null) return;
    }
    doc.addEventListener('securitypolicyviolation', this.handleEvent);
  }

  uninstall(): void {
    const doc = getDocument();
    if (!this.installed || doc === null) return;
    if (this.observer !== null) {
      const observer = this.observer;
      safelyRun(this.logger, 'disconnect CSP observer', function disconnect() {
        observer.disconnect();
      });
      this.observer = null;
    } else {
      doc.removeEventListener('securitypolicyviolation', this.handleEvent);
    }
    this.installed = false;
  }
}

function defaultReportingObserver(): ReportingObserverConstructor | null {
  const g = (typeof window !== 'undefined' ? window : {}) as { ReportingObserver?: ReportingObserverConstructor };
  return typeof g.ReportingObserver === 'function' ? g.ReportingObserver : null;
}
