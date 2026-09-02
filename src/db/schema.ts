import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  smallserial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Kusoma schema — §5 of the migration spec (Revision 2).
 *
 * One `users` table; role is data, not a table. Eleven tables total: the count
 * went up, the duplicated columns and forked query paths went down.
 */

/* ═══════════════ IDENTITY ═══════════════ */

/**
 * One row per human, plus one for the bot. Replaces the old tutors + students
 * + guardians tables. What a user *is* comes from user_roles, never from which
 * table they live in.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name").notNull(),
    /** NULL only for the seeded bot user. */
    phone: text("phone"),
    /**
     * Student (and optionally guardian via /iamparent). The tutor uses the app —
     * we do not stamp them from Telegram /start.
     */
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).unique(),
    /** NULL = cannot log in (students, bot). */
    passwordHash: text("password_hash"),
    grade: smallint("grade"),
    onboarded: boolean("onboarded").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * Preserves the pre-Revision-2 uniqueness intent exactly: tutors.phone and
     * guardians.phone were UNIQUE, students.phone deliberately was not. A phone
     * is a *login identifier*, so it is unique among accounts that can log in —
     * which is what lets a young student be registered under their guardian's
     * number. Do not "fix" this into a plain unique constraint.
     */
    uniqueIndex("users_login_phone_uniq")
      .on(t.phone)
      .where(sql`password_hash IS NOT NULL`),
    index("idx_users_telegram").on(t.telegramUserId),
    check("users_grade_range", sql`grade IS NULL OR (grade BETWEEN 1 AND 13)`),
  ],
);

/**
 * Seeded data, not code. Adding a role later (school admin, co-tutor) is an
 * INSERT here plus grants in role_permissions — never a new table, never a new
 * branch in a handler.
 */
export const roles = pgTable("roles", {
  id: smallserial("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
});

/**
 * Many-to-many on purpose: a tutor who also guards their own child holds both
 * roles on one account, which the old two-table split made impossible.
 */
export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: smallint("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

/**
 * The RBAC scaffold. Seeded and wired to a working requirePermission(), but
 * intentionally coarse — this is a permission table, not a permissions engine,
 * and explicitly not a return of Tabibu's CASL layer.
 */
export const permissions = pgTable("permissions", {
  id: smallserial("id").primaryKey(),
  /** '<resource>:<action>', e.g. 'students:write'. */
  key: text("key").notNull().unique(),
  description: text("description"),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: smallint("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: smallint("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

/* ═══════════════ WHO RELATES TO WHOM ═══════════════ */

/**
 * Replaces students.tutor_id AND the whole guardians table's scoping. One row
 * shape and one query shape answer "which students may this user see, and in
 * what capacity", so the tutor path and the guardian path stop being two
 * pieces of code that can drift apart.
 */
export const userRelationships = pgTable(
  "user_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The adult: tutor or guardian. */
    fromUserId: uuid("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The student. */
    toUserId: uuid("to_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    relationship: text("relationship").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("user_relationships_unique").on(t.fromUserId, t.toUserId, t.relationship),
    index("idx_rel_from").on(t.fromUserId, t.relationship),
    index("idx_rel_to").on(t.toUserId, t.relationship),
    check("user_relationships_kind", sql`relationship IN ('tutor_of', 'guardian_of')`),
    check("user_relationships_not_self", sql`from_user_id <> to_user_id`),
  ],
);

/* ═══════════════ CHAT ═══════════════ */

/**
 * The canonical chat room per tutor-student pair, mirrored on two surfaces (a
 * Telegram group, and the Expo app's Chat UI over WebSocket).
 *
 * telegramChatId is NULLABLE: the room is created when the student is created,
 * and the webhook later *binds* the chat id onto the existing row (§7).
 *
 * ownerUserId/studentUserId are kept even though chatParticipants could derive
 * them — they carry the DB-enforced "one room per tutor-student pair"
 * invariant a join table cannot express without a trigger, and they keep the
 * hot lookup index-only.
 */
export const chatGroups = pgTable(
  "chat_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    studentUserId: uuid("student_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).unique(),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("chat_groups_owner_student").on(t.ownerUserId, t.studentUserId)],
);

/**
 * Membership and per-room ACL. This is what makes the guardian's read access
 * and the bot's presence *rows* rather than role-branching in application
 * code — the Hub and the broadcaster both resolve "who can see this room" from
 * here with a single query and no role fork.
 *
 * participantRole is the user's role *within this room*, which is not the same
 * as their global role in userRoles.
 */
export const chatParticipants = pgTable(
  "chat_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatGroupId: uuid("chat_group_id")
      .notNull()
      .references(() => chatGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    participantRole: text("participant_role").notNull(),
    /** false for guardians — read-only (§2). */
    canPost: boolean("can_post").notNull().default(true),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  },
  (t) => [
    unique("chat_participants_group_user").on(t.chatGroupId, t.userId),
    index("idx_chat_participants_user").on(t.userId),
    check(
      "chat_participants_role",
      sql`participant_role IN ('owner', 'student', 'observer', 'bot')`,
    ),
  ],
);

/**
 * Every message in every chat group, from either Telegram or the Expo app.
 *
 * senderRole stays denormalized alongside senderUserId so the Router and the
 * chat renderer never join user_roles per message — the same trade-off this
 * schema already accepts for strand/subStrand/learningOutcome.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatGroupId: uuid("chat_group_id")
      .notNull()
      .references(() => chatGroups.id, { onDelete: "cascade" }),
    senderUserId: uuid("sender_user_id")
      .notNull()
      .references(() => users.id),
    senderRole: text("sender_role").notNull(),
    platform: text("platform").notNull(),
    content: text("content").notNull(),
    /**
     * Each element: { type, telegramFileId?, url?, mimeType?, width?, height?,
     * caption? }. NOTE: Bedrock accepts neither telegramFileId nor url — both
     * must be resolved to base64 bytes server-side before reaching the model
     * (§9.0, services/attachments.ts).
     */
    attachments: jsonb("attachments").notNull().default(sql`'[]'::jsonb`),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_messages_group").on(t.chatGroupId, t.createdAt.desc()),
    /**
     * Telegram redelivers an update if your 200 is slow. This makes the webhook
     * idempotent for free instead of needing an application-level dedupe.
     */
    uniqueIndex("idx_messages_tg_dedupe")
      .on(t.chatGroupId, t.telegramMessageId)
      .where(sql`telegram_message_id IS NOT NULL`),
    check(
      "messages_sender_role",
      sql`sender_role IN ('student', 'tutor', 'guardian', 'bot')`,
    ),
    check("messages_platform", sql`platform IN ('telegram', 'app')`),
  ],
);

/* ═══════════════ CURRICULUM ═══════════════ */

/**
 * A CBC learning-outcome scope for a student. Optional and opt-in (§1) — a
 * student can have zero rows here forever and the product still works.
 * source + status capture the "AI proposes, tutor approves" workflow (§9.2).
 */
export const assignments = pgTable(
  "assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentUserId: uuid("student_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    cbcNodeId: uuid("cbc_node_id").notNull(),
    strand: text("strand").notNull(),
    subStrand: text("sub_strand").notNull(),
    learningOutcome: text("learning_outcome").notNull(),
    source: text("source").notNull().default("tutor"),
    status: text("status").notNull().default("active"),
    /** Set only when source='ai': why the advisor proposed this. */
    rationale: text("rationale"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_assignments_student").on(t.studentUserId, t.status),
    check("assignments_source", sql`source IN ('tutor', 'ai')`),
    check(
      "assignments_status",
      sql`status IN ('suggested', 'active', 'paused', 'completed', 'dismissed')`,
    ),
  ],
);

/** One row per student per curriculum node. */
export const studentPerformance = pgTable(
  "student_performance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentUserId: uuid("student_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    cbcNodeId: uuid("cbc_node_id").notNull(),
    strand: text("strand").notNull(),
    subStrand: text("sub_strand").notNull(),
    learningOutcome: text("learning_outcome").notNull(),
    totalProblems: integer("total_problems").notNull().default(0),
    correctCount: integer("correct_count").notNull().default(0),
    commonErrors: jsonb("common_errors").notNull().default(sql`'[]'::jsonb`),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  },
  (t) => [unique("student_performance_student_node").on(t.studentUserId, t.cbcNodeId)],
);

/* ═══════════════ Shared vocabulary ═══════════════ */

export const ROLE_KEYS = ["tutor", "guardian", "student", "bot"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const PERMISSION_KEYS = [
  "students:read",
  "students:write",
  "guardians:write",
  "assignments:read",
  "assignments:write",
  "messages:read",
  "messages:send",
  "curriculum:read",
  "dashboard:read",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export type RelationshipKind = "tutor_of" | "guardian_of";
export type ParticipantRole = "owner" | "student" | "observer" | "bot";
export type SenderRole = "student" | "tutor" | "guardian" | "bot";
export type Platform = "telegram" | "app";

export interface Attachment {
  type: "image" | "document" | "audio" | "voice" | "video";
  telegramFileId?: string;
  url?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  caption?: string;
}
