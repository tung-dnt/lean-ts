CREATE TYPE "note_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY,
	"title" varchar(200) NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" "note_status" DEFAULT 'active'::"note_status" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "processed_messages" (
	"message_id" text PRIMARY KEY,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
