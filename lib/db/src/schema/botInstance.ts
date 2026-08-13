import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One immutable identity row per database. It prevents two Railway bot
 * services from accidentally sharing queues, schedules, sources, or usage.
 */
export const botInstanceTable = pgTable("bot_instance", {
  id: integer("id").primaryKey().default(1),
  instanceKey: text("instance_key").notNull(),
  contentProfile: text("content_profile").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BotInstance = typeof botInstanceTable.$inferSelect;
