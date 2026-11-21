import { pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { NOTE_TITLE_MAX } from "@lean-ts/domain-note";

// Every time column is timestamptz (UTC in the database); convert to UK time only for display.

export const noteStatus = pgEnum("note_status", ["active", "archived"]);

export const notes = pgTable("notes", {
  id: uuid().primaryKey(),
  title: varchar({ length: NOTE_TITLE_MAX }).notNull(),
  body: text().notNull().default(""),
  status: noteStatus().notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

/** One row per queue message already handled: the idempotency record for at-least-once delivery. */
export const processedMessages = pgTable("processed_messages", {
  messageId: text("message_id").primaryKey(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});
