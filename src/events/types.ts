import type { Attachment, Platform } from "../db/schema.js";

/**
 * Event payloads — §6.2.
 *
 * Every id below is a users.id. There are no separate tutor/student id spaces
 * any more. senderUserId is carried explicitly so subscribers never have to
 * re-resolve the sender from the platform payload.
 */

export interface MessageInbound {
  chatGroupId: string;
  studentUserId: string;
  /** The tutor who owns the room. */
  ownerUserId: string;
  senderUserId: string;
  senderRole: "student" | "tutor" | "guardian";
  platform: Platform;
  text: string;
  attachments: Attachment[];
  telegramChatId?: number;
  telegramMessageId?: number;
  timestamp: Date;
}

export interface AIRequest {
  chatGroupId: string;
  studentUserId: string;
  ownerUserId: string;
  text: string;
  attachments: Attachment[];
}

export interface PerformanceSignal {
  cbcNodeId: string;
  strand: string;
  subStrand: string;
  learningOutcome: string;
  isCorrect: boolean;
  errorType?: string;
  errorDetail?: string;
}

export interface AIResponse {
  chatGroupId: string;
  studentUserId: string;
  text: string;
  performance?: PerformanceSignal;
}

export interface MessageOutbound {
  chatGroupId: string;
  /** The bot user, or the tutor who sent from the app. */
  senderUserId: string;
  senderRole: "bot" | "tutor";
  text: string;
  attachments?: Attachment[];
  /** Set by TelegramSender after a successful send, for MessageStore. */
  telegramMessageId?: number;
  /** True once the row is already persisted, so MessageStore skips it. */
  persisted?: boolean;
}

/** Emitted by Analytics after student_performance is upserted (§9.2 ordering). */
export interface PerformanceRecorded {
  chatGroupId: string;
  studentUserId: string;
  performance: PerformanceSignal;
}

export interface AssignmentSuggested {
  assignmentId: string;
  studentUserId: string;
  ownerUserId: string;
  rationale: string;
}
