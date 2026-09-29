CREATE TABLE "farm_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"sender_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "farm_chat_reactions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "farm_chat_reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "farm_chat_reads" (
	"user_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "farm_chat_reads_user_id_room_id_pk" PRIMARY KEY("user_id","room_id")
);
--> statement-breakpoint
CREATE TABLE "farm_chat_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"description" text,
	"dm_user_a" uuid,
	"dm_user_b" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "farm_chat_rooms_kind_valid" CHECK ("farm_chat_rooms"."kind" IN ('general', 'room', 'dm')),
	CONSTRAINT "farm_chat_rooms_dm_shape" CHECK (("farm_chat_rooms"."kind" = 'dm') = ("farm_chat_rooms"."dm_user_a" IS NOT NULL AND "farm_chat_rooms"."dm_user_b" IS NOT NULL AND "farm_chat_rooms"."dm_user_a" < "farm_chat_rooms"."dm_user_b"))
);
--> statement-breakpoint
CREATE TABLE "farm_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "farm_chat_messages" ADD CONSTRAINT "farm_chat_messages_room_id_farm_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."farm_chat_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "farm_chat_messages" ADD CONSTRAINT "farm_chat_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "farm_chat_reactions" ADD CONSTRAINT "farm_chat_reactions_message_id_farm_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."farm_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "farm_chat_reactions" ADD CONSTRAINT "farm_chat_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "farm_chat_reads" ADD CONSTRAINT "farm_chat_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "farm_chat_reads" ADD CONSTRAINT "farm_chat_reads_room_id_farm_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."farm_chat_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "farm_chat_rooms" ADD CONSTRAINT "farm_chat_rooms_dm_user_a_users_id_fk" FOREIGN KEY ("dm_user_a") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "farm_chat_rooms" ADD CONSTRAINT "farm_chat_rooms_dm_user_b_users_id_fk" FOREIGN KEY ("dm_user_b") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "farm_chat_rooms" ADD CONSTRAINT "farm_chat_rooms_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "farm_preferences" ADD CONSTRAINT "farm_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "farm_chat_messages_room_created" ON "farm_chat_messages" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "farm_chat_messages_created" ON "farm_chat_messages" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "farm_chat_rooms_one_general" ON "farm_chat_rooms" USING btree ("kind") WHERE "farm_chat_rooms"."kind" = 'general';--> statement-breakpoint
CREATE UNIQUE INDEX "farm_chat_rooms_dm_pair" ON "farm_chat_rooms" USING btree ("dm_user_a","dm_user_b") WHERE "farm_chat_rooms"."kind" = 'dm';--> statement-breakpoint
CREATE UNIQUE INDEX "farm_chat_rooms_room_name" ON "farm_chat_rooms" USING btree (lower("name")) WHERE "farm_chat_rooms"."kind" = 'room';