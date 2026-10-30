/**
 * Two real events from an Appzillon admin app (2026-10-27, SDK 0.6.2), trimmed
 * to the fields the insights read. Used by tests/insights.test.ts.
 */

const base = 'http://localhost:8080/AppzillonAdmin';
const crumb = (timestamp: string, type: string, message: string, data: Record<string, unknown> = {}) => ({ timestamp, type, message, data });
const api = (timestamp: string, method: string, path: string, status: number, duration: number) =>
  crumb(timestamp, 'api', `${method} ${base}${path} → ${status}`, { url: `${base}${path}`, method, status, duration_ms: duration, failure: null });

/** FusionCharts throws while Appzillon applies the chart licence key, just after the tab was hidden. */
export const fusionChartsError = {
  event_type: 'error',
  timestamp: '2026-10-27T12:47:54.446Z',
  error: { message: "Cannot read properties of undefined (reading 'node')", type: 'TypeError', handled: true },
  stacktrace: [
    { filename: `${base}/appzillon/scripts/fusioncharts/fusioncharts.js?v=1.0.0.0`, lineno: 23, colno: 52678, function: 'r._crCreate' },
    { filename: `${base}/appzillon/scripts/fusioncharts/fusioncharts.js?v=1.0.0.0`, lineno: 23, colno: 51267, function: 'r._drawMain' },
    { filename: null, lineno: null, colno: null, function: 'Array.forEach' },
    { filename: `${base}/appzillon/scripts/fusioncharts/fusioncharts.js?v=1.0.0.0`, lineno: 14, colno: 125644, function: 'Object.license' },
    { filename: `${base}/appzillon/scripts/appzillon/charts.js?v=1.0.0.0`, lineno: 1, colno: 6398, function: 'Object.getFusionChartLicenseKeyCB' },
  ],
  breadcrumbs: [
    api('2026-10-27T12:46:43.932Z', 'GET', '/apps/Admin/screens/ifacedef/Admin__SecurityParamsDBDetail.json', 200, 1945),
    crumb('2026-10-27T12:46:45.894Z', 'lifecycle', 'Page hidden'),
    crumb('2026-10-27T12:46:46.826Z', 'lifecycle', 'Page visible'),
    crumb('2026-10-27T12:46:47.616Z', 'lifecycle', 'Page hidden'),
    crumb('2026-10-27T12:46:48.176Z', 'lifecycle', 'Page visible'),
    crumb('2026-10-27T12:47:12.612Z', 'click', 'Clicked Security Parameters'),
    crumb('2026-10-27T12:47:12.612Z', 'navigation', 'launchSubScreen: SecurityParameters'),
    crumb('2026-10-27T12:47:15.162Z', 'lifecycle', 'Page hidden'),
    crumb('2026-10-27T12:47:45.553Z', 'lifecycle', 'Page visible'),
    crumb('2026-10-27T12:47:48.043Z', 'click', 'Clicked Dashboard', { tag: 'a', text: 'Dashboard' }),
    crumb('2026-10-27T12:47:48.043Z', 'navigation', 'launchSubScreen: Dashboard'),
    api('2026-10-27T12:47:48.418Z', 'GET', '/apps/Admin/screens/scrdef/Dashboard_web.json', 200, 367),
    api('2026-10-27T12:47:49.644Z', 'GET', '/apps/Admin/screens/ifacedef/Admin__appzillonDashBoard.json', 200, 540),
    api('2026-10-27T12:47:51.952Z', 'POST', '/AppzillonWeb', 200, 1932),
    api('2026-10-27T12:47:53.394Z', 'GET', '/apps/styles/themes/Admin/csd/AdminPie2D.json', 200, 613),
    api('2026-10-27T12:47:54.397Z', 'GET', '/apps/styles/themes/Admin/csd/AdminPie2D.json', 200, 976),
    crumb('2026-10-27T12:47:54.430Z', 'lifecycle', 'Page hidden'),
  ],
  context: { iface: 'appzillonFetchLicenseKey', callback: 'getFusionChartLicenseKeyCB' },
};

/** An Appzillon server call failed; reported by the integration snippet's serverError(). */
export const serverCallFailed = {
  event_type: 'error',
  timestamp: '2026-10-27T11:02:48.885Z',
  error: { message: 'Server call failed: appzillonDashBoard', type: 'AppzillonServerError', handled: true },
  stacktrace: [
    { filename: `${base}/apps/Admin/scripts/Init.js?v=1.0.0.0`, lineno: 1, colno: 1940, function: 'serverError' },
    { filename: `${base}/apps/Admin/scripts/Init.js?v=1.0.0.0`, lineno: 1, colno: 2260, function: 'Object.wrapped' },
    { filename: `${base}/appzillon/scripts/appzillon/appzillon.js`, lineno: 40, colno: 9433, function: 'Apz.Server.receiveResHandler' },
    { filename: `${base}/appzillon/scripts/appzillon/appzillon.js`, lineno: 48, colno: 30359, function: 'Object.error' },
    { filename: `${base}/appzillon/scripts/jquery/jquery.js`, lineno: 1, colno: 25301, function: 'c' },
  ],
  breadcrumbs: [
    crumb('2026-10-27T11:02:44.430Z', 'lifecycle', 'Page visible'),
    crumb('2026-10-27T11:02:47.120Z', 'click', 'Clicked Dashboard'),
    crumb('2026-10-27T11:02:47.121Z', 'navigation', 'launchSubScreen: Dashboard'),
    api('2026-10-27T11:02:48.189Z', 'GET', '/apps/Admin/screens/ifacedef/Admin__appzillonDashBoard.json', 200, 334),
    // Not in the real event (SDK 0.6.2 recorded XHRs too late); 0.7.1 records it before the callback runs.
    api('2026-10-27T11:02:48.880Z', 'POST', '/AppzillonWeb', 502, 690),
  ],
  context: { iface: 'appzillonDashBoard' },
};
