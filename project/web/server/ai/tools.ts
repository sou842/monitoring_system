import type { Db, Filter } from 'mongodb';
import { tool } from 'ai';
import { z } from 'zod';
import { AI_LIST_EVENTS_MAX, AI_VERSION_MAX_LENGTH } from '../constants.ts';
import { collections } from '../db.ts';
import { parseObjectId } from '../http.ts';
import type { EventDoc, IssueDoc, ProjectDoc } from '../models.ts';
import { sdkGuideTools } from './sdkGuide.ts';
import { cappedJson, EVENT_SUMMARY_PROJECTION, eventAnalysis, eventSummaryLine } from './context.ts';

/**
 * Tools the assistant may call. Both only ever read events of the one issue
 * the chat is about (the route has already checked the user owns it).
 */
export function issueTools(db: Db, issue: IssueDoc, project: Pick<ProjectDoc, 'insights'> | null) {
  const events = collections(db).events;
  return {
    ...sdkGuideTools(),
    list_events: tool({
      description: "Lists this issue's stored events, newest first: id, time, screen, page, environment, app version, browser, OS, user id. Use get_event with an id to read one in full.",
      inputSchema: z.object({
        offset: z.number().int().min(0).optional().describe('How many of the newest events to skip (paging). Default 0.'),
        limit: z.number().int().min(1).max(AI_LIST_EVENTS_MAX).optional().describe(`How many events to return, at most ${AI_LIST_EVENTS_MAX}. Default 20.`),
        version: z.string().max(AI_VERSION_MAX_LENGTH).optional().describe('Only events from this exact app version (see the App versions breakdown).'),
      }),
      execute: async (input) => {
        const { offset = 0, limit = 20, version } = input;
        const filter: Filter<EventDoc> = { issueId: issue._id };
        if (version && version.trim()) filter.appVersion = version.trim();
        const [total, rows] = await Promise.all([
          events.countDocuments(filter),
          events.find(filter, { projection: EVENT_SUMMARY_PROJECTION }).sort({ receivedAt: -1 }).skip(offset).limit(limit).toArray(),
        ]);
        return { total, offset, events: rows.map(eventSummaryLine) };
      },
    }),
    get_event: tool({
      description: "Returns one of this issue's events in full: the dashboard's analysis (where to look, last moments, hints, stack) and the complete event JSON (breadcrumbs, API calls, device, context…).",
      inputSchema: z.object({ id: z.string().describe('Event id, from list_events or the context.') }),
      execute: async ({ id }) => {
        const eventId = parseObjectId(id);
        const event = eventId ? await events.findOne({ _id: eventId, issueId: issue._id }) : null;
        if (!event) return { error: `No stored event ${id} in this issue.` };
        return {
          id: String(event._id),
          receivedAt: event.receivedAt.toISOString(),
          // Hashed sender network (never the IP); device.id and session_id are in the JSON.
          networkId: event.networkId ?? null,
          analysis: eventAnalysis(event, project ? project.insights : null),
          json: cappedJson(event.payload),
        };
      },
    }),
  };
}
