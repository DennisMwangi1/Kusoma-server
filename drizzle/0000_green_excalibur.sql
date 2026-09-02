CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_user_id" uuid NOT NULL,
	"cbc_node_id" uuid NOT NULL,
	"strand" text NOT NULL,
	"sub_strand" text NOT NULL,
	"learning_outcome" text NOT NULL,
	"source" text DEFAULT 'tutor' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignments_source" CHECK (source IN ('tutor', 'ai')),
	CONSTRAINT "assignments_status" CHECK (status IN ('suggested', 'active', 'paused', 'completed', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "chat_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"telegram_chat_id" bigint,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_groups_telegram_chat_id_unique" UNIQUE("telegram_chat_id"),
	CONSTRAINT "chat_groups_owner_student" UNIQUE("owner_user_id","student_user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"participant_role" text NOT NULL,
	"can_post" boolean DEFAULT true NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_at" timestamp with time zone,
	CONSTRAINT "chat_participants_group_user" UNIQUE("chat_group_id","user_id"),
	CONSTRAINT "chat_participants_role" CHECK (participant_role IN ('owner', 'student', 'observer', 'bot'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_group_id" uuid NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"sender_role" text NOT NULL,
	"platform" text NOT NULL,
	"content" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"telegram_message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_sender_role" CHECK (sender_role IN ('student', 'tutor', 'guardian', 'bot')),
	CONSTRAINT "messages_platform" CHECK (platform IN ('telegram', 'app'))
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" "smallserial" PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"description" text,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" smallint NOT NULL,
	"permission_id" smallint NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" "smallserial" PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	CONSTRAINT "roles_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "student_performance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_user_id" uuid NOT NULL,
	"cbc_node_id" uuid NOT NULL,
	"strand" text NOT NULL,
	"sub_strand" text NOT NULL,
	"learning_outcome" text NOT NULL,
	"total_problems" integer DEFAULT 0 NOT NULL,
	"correct_count" integer DEFAULT 0 NOT NULL,
	"common_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_active_at" timestamp with time zone,
	CONSTRAINT "student_performance_student_node" UNIQUE("student_user_id","cbc_node_id")
);
--> statement-breakpoint
CREATE TABLE "user_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_relationships_unique" UNIQUE("from_user_id","to_user_id","relationship"),
	CONSTRAINT "user_relationships_kind" CHECK (relationship IN ('tutor_of', 'guardian_of')),
	CONSTRAINT "user_relationships_not_self" CHECK (from_user_id <> to_user_id)
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" smallint NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"phone" text,
	"telegram_user_id" bigint,
	"password_hash" text,
	"grade" smallint,
	"onboarded" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_user_id_unique" UNIQUE("telegram_user_id"),
	CONSTRAINT "users_grade_range" CHECK (grade IS NULL OR (grade BETWEEN 1 AND 13))
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_chat_group_id_chat_groups_id_fk" FOREIGN KEY ("chat_group_id") REFERENCES "public"."chat_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_group_id_chat_groups_id_fk" FOREIGN KEY ("chat_group_id") REFERENCES "public"."chat_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_performance" ADD CONSTRAINT "student_performance_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_relationships" ADD CONSTRAINT "user_relationships_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_relationships" ADD CONSTRAINT "user_relationships_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assignments_student" ON "assignments" USING btree ("student_user_id","status");--> statement-breakpoint
CREATE INDEX "idx_chat_participants_user" ON "chat_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_messages_group" ON "messages" USING btree ("chat_group_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_messages_tg_dedupe" ON "messages" USING btree ("chat_group_id","telegram_message_id") WHERE telegram_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rel_from" ON "user_relationships" USING btree ("from_user_id","relationship");--> statement-breakpoint
CREATE INDEX "idx_rel_to" ON "user_relationships" USING btree ("to_user_id","relationship");--> statement-breakpoint
CREATE UNIQUE INDEX "users_login_phone_uniq" ON "users" USING btree ("phone") WHERE password_hash IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_users_telegram" ON "users" USING btree ("telegram_user_id");