import { MONGO_DUPLICATE_KEY, SCREENSHOT_UPLOAD_CONCURRENCY } from './constants.js';
import { culprit, fingerprint } from './grouping.js';
import { validateEvent } from './validate.js';

/**
 * Stores a batch of events for one project:
 *   validate → upload screenshots → group into issues → insert events.
 *
 * Invalid events are rejected individually; valid ones in the same batch are
 * still stored. `uploadScreenshot(dataUrl, projectId)` is injected so tests
 * can run without Cloudinary.
 *
 * @returns {Promise<{ accepted: number, rejected: Array<{ index: number, reason: string }> }>}
 */
export async function ingestEvents({ db, project, rawEvents, uploadScreenshot, now = new Date() }) {
  const rejected = [];
  const valid = [];
  rawEvents.forEach((raw, index) => {
    const result = validateEvent(raw, now);
    if (result.ok) valid.push(result.event);
    else rejected.push({ index, reason: result.reason });
  });
  if (valid.length === 0) return { accepted: 0, rejected };

  const projectId = project._id;
  const screenshots = await mapLimit(valid, SCREENSHOT_UPLOAD_CONCURRENCY, (event) =>
    event.screenshot ? uploadScreenshot(event.screenshot, String(projectId)) : Promise.resolve({ url: null }),
  );

  const docs = [];
  for (let i = 0; i < valid.length; i++) {
    const event = valid[i];
    const issue = await upsertIssue(db, projectId, event, now);
    docs.push(eventDocument(projectId, issue._id, event, screenshots[i], now));
  }
  await db.collection('events').insertMany(docs, { ordered: false });
  return { accepted: docs.length, rejected };
}

/**
 * Finds or creates the issue for this event and updates its counters.
 * A resolved issue that happens again is reopened (a regression).
 */
async function upsertIssue(db, projectId, event, now) {
  const issues = db.collection('issues');
  const fp = fingerprint(event);
  const update = {
    $setOnInsert: {
      projectId,
      fingerprint: fp,
      eventType: event.event_type,
      errorType: event.error ? event.error.type : event.event_type,
      message: event.error ? event.error.message : '',
      culprit: culprit(event.stacktrace),
      firstSeen: now,
      status: 'open',
    },
    $set: { lastSeen: now, level: event.level, lastMessage: event.error ? event.error.message : '' },
    $inc: { count: 1 },
    $addToSet: { environments: event.environment, platforms: event.device.platform },
  };
  let issue;
  try {
    issue = await issues.findOneAndUpdate({ projectId, fingerprint: fp }, update, { upsert: true, returnDocument: 'after' });
  } catch (error) {
    // Two requests created the same new issue at once: the loser simply updates it.
    if (error.code !== MONGO_DUPLICATE_KEY) throw error;
    issue = await issues.findOneAndUpdate({ projectId, fingerprint: fp }, update, { returnDocument: 'after' });
  }
  if (issue.status === 'resolved') {
    await issues.updateOne({ _id: issue._id }, { $set: { status: 'open', regressedAt: now } });
    issue.status = 'open';
  }
  return issue;
}

/** Event as stored: indexed summary fields plus the full validated payload (minus the image itself). */
function eventDocument(projectId, issueId, event, screenshot, now) {
  const { screenshot: _dataUrl, ...payload } = event;
  return {
    projectId,
    issueId,
    receivedAt: now,
    timestamp: event.timestamp,
    eventType: event.event_type,
    level: event.level,
    environment: event.environment,
    appVersion: event.app_version,
    errorType: event.error ? event.error.type : null,
    message: event.error ? event.error.message : null,
    handled: event.error ? event.error.handled : null,
    userId: event.user.id,
    url: event.device.url,
    platform: event.device.platform,
    screenshotUrl: screenshot.url,
    screenshotSkipped: screenshot.url === null && event.screenshot !== null ? screenshot.reason || 'unknown' : null,
    payload,
  };
}

/** Promise.all with at most `limit` tasks running at once, results in input order. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
