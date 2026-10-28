/**
 * Shapes database documents for the dashboard API: string ids, no internal
 * fields.
 */

export function issueView(issue) {
  return {
    id: String(issue._id),
    projectId: String(issue.projectId),
    eventType: issue.eventType,
    errorType: issue.errorType,
    message: issue.message,
    culprit: issue.culprit,
    level: issue.level,
    status: issue.status,
    count: issue.count,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    regressedAt: issue.regressedAt || null,
    environments: issue.environments || [],
    platforms: issue.platforms || [],
  };
}

/** Light version of an event for lists (no payload). */
export function eventSummaryView(event) {
  return {
    id: String(event._id),
    receivedAt: event.receivedAt,
    timestamp: event.timestamp,
    environment: event.environment,
    appVersion: event.appVersion,
    message: event.message,
    userId: event.userId,
    url: event.url,
    // Events stored before the field existed have none.
    screen: event.screen ?? null,
    platform: event.platform,
    browser: event.payload && event.payload.device ? event.payload.device.browser : null,
  };
}

export function eventView(event) {
  return {
    ...eventSummaryView(event),
    issueId: String(event.issueId),
    payload: event.payload,
  };
}
