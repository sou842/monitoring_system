import type { ObjectId } from 'mongodb';
import type { EventPayload, IssueStatus, Level, Span, TransactionKind, Vitals } from '../lib/schema.ts';
import type { Permission } from '../lib/permissions.ts';
import type { UserProfile } from '../lib/types.ts';
import type { UserRole, UserStatus } from './constants.ts';

/**
 * MongoDB documents, one interface per collection.
 */

export interface UserDoc {
  _id: ObjectId;
  email: string;
  name: string;
  /** Optional details the user chose to share; missing on accounts created before profiles existed. */
  profile?: Partial<UserProfile>;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  sessionVersion: number;
  createdAt: Date;
  lastLoginAt?: Date | null;
  passwordChangedAt?: Date;
  disabledAt?: Date;
}

export interface Hint {
  match: string;
  text: string;
}

export interface InsightSettings {
  libraryPaths: string[];
  hiddenFrames: string[];
  hints: Hint[];
}

export interface ProjectDoc {
  _id: ObjectId;
  name: string;
  /** Missing on projects created before accounts existed (claimed by `make-admin`). */
  ownerId?: ObjectId;
  apiKeyHash: string;
  apiKeyHint: string;
  allowedOrigins?: string[];
  insights?: Partial<InsightSettings>;
  /** Set while the owner's account is disabled: ingestion answers 403. */
  disabled?: boolean;
  createdAt: Date;
}

export interface IssueDoc {
  _id: ObjectId;
  projectId: ObjectId;
  fingerprint: string;
  eventType: string;
  errorType: string;
  message: string;
  lastMessage?: string;
  culprit: string | null;
  level: Level;
  status: IssueStatus;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  regressedAt?: Date;
  statusChangedAt?: Date;
  environments?: string[];
  platforms?: string[];
}

export interface EventDoc {
  _id: ObjectId;
  projectId: ObjectId;
  issueId: ObjectId;
  receivedAt: Date;
  timestamp: Date;
  eventType: string;
  level: Level;
  environment: string;
  appVersion: string | null;
  errorType: string | null;
  message: string | null;
  handled: boolean | null;
  userId: string | null;
  url: string | null;
  /** Missing on events stored before the field existed. */
  screen?: string | null;
  /** `payload.device.id` / `payload.session_id`; missing on events stored before SDK 0.12.0 support. */
  deviceId?: string | null;
  sessionId?: string | null;
  /**
   * Hashed sender network (`server/network.ts`): the same office or home IP
   * gives the same value within one project. Never the IP itself.
   */
  networkId?: string | null;
  platform: string;
  payload: EventPayload;
}

export type StoredSpan = Span & { key: string };

export interface TransactionDoc {
  _id: ObjectId;
  projectId: ObjectId;
  receivedAt: Date;
  environment: string;
  appVersion: string | null;
  userId: string | null;
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  route: string;
  name: string;
  screen: string | null;
  kind: TransactionKind;
  start: Date | null;
  duration_ms: number;
  background: boolean;
  vitals: Vitals;
  long_tasks: { count: number; blocking_ms: number };
  spans: StoredSpan[];
  dropped_spans: number;
}

/** Histogram: bucket index → count. */
export type Histogram = Record<string, number>;

export interface RollupDoc {
  projectId: ObjectId;
  hour: Date;
  environment: string;
  kind: 'page' | 'endpoint';
  key: string;
  method?: string;
  origin?: string;
  path?: string;
  count?: number;
  errors?: number;
  background?: number;
  loads?: number;
  blocking_ms?: number;
  /** Endpoint latency histogram. */
  h?: Histogram;
  /** Page vitals: one histogram per vital. */
  v?: Record<string, Histogram>;
  server?: { sum?: number; n?: number };
  download?: { sum?: number; n?: number };
}

export interface RateLimitDoc {
  _id: string;
  count: number;
  expiresAt: Date;
}

/** A non-owner member of a project (the owner is `projects.ownerId`). */
export interface ProjectMemberDoc {
  _id: ObjectId;
  projectId: ObjectId;
  userId: ObjectId;
  permissions: Permission[];
  addedBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/** One message in a project's chat channel. Deleted messages keep their row (text emptied). */
export interface ChatMessageDoc {
  _id: ObjectId;
  projectId: ObjectId;
  userId: ObjectId;
  text: string;
  mentions: ObjectId[];
  /** Issues of the same project attached to the message (shown as cards). */
  issueIds?: ObjectId[];
  /** The message this one answers. */
  replyToId?: ObjectId;
  /** Reactions: emoji (any single emoji, lib/chat.ts isReactionEmoji) → the users who reacted with it. */
  reactions?: Record<string, ObjectId[]>;
  createdAt: Date;
  /** Last time the text was edited by its author (shown as "edited"). */
  editedAt?: Date;
  /** Last change of any kind after posting (edit, reaction, delete); browsers sync changes by it. */
  updatedAt?: Date;
  /** The sending browser's id for this message, so a send retried after a lost response is not saved twice. */
  clientId?: string;
  deletedAt?: Date;
}

/** When a user last read a project's chat (for unread counts). */
export interface ChatReadDoc {
  _id: ObjectId;
  projectId: ObjectId;
  userId: ObjectId;
  lastReadAt: Date;
}
