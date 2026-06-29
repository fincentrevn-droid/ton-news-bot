import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const postsTable = pgTable("posts", {
  id: serial("id").primaryKey(),
  content: text("content").notNull(),
  status: text("status").notNull().default("draft"),
  postType: text("post_type").notNull().default("short"),
  topic: text("topic"),
  sourceUrl: text("source_url"),
  sourceType: text("source_type").notNull().default("manual"),
  safetyStatus: text("safety_status").notNull().default("ok"),
  reviewMessageId: integer("review_message_id"),
  telegramMessageId: integer("telegram_message_id"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  aiCallsUsed: integer("ai_calls_used").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPostSchema = createInsertSchema(postsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPost = z.infer<typeof insertPostSchema>;
export type Post = typeof postsTable.$inferSelect;
