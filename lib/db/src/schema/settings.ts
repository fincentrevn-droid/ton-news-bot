import { pgTable, text, serial, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const settingsTable = pgTable("settings", {
  id: serial("id").primaryKey(),
  openaiModel: text("openai_model").notNull().default("gpt-4o"),
  maxAiCallsPerDay: integer("max_ai_calls_per_day").notNull().default(12),
  maxPostsPerDay: integer("max_posts_per_day").notNull().default(6),
  minPostsPerDay: integer("min_posts_per_day").notNull().default(5),
  maxRewritePerPost: integer("max_rewrite_per_post").notNull().default(3),
  maxTokensPerPost: integer("max_tokens_per_post").notNull().default(1500),
  maxSourcePostsPerChannel: integer("max_source_posts_per_channel").notNull().default(20),
  lookbackHours: integer("lookback_hours").notNull().default(24),
  enableCostGuard: boolean("enable_cost_guard").notNull().default(true),
  autoPublish: boolean("auto_publish").notNull().default(false),
  postingRequiresApproval: boolean("posting_requires_approval").notNull().default(true),
  enableSecondarySourcesi: boolean("enable_secondary_sourcesi").notNull().default(false),
  customEmojiEnabled: boolean("custom_emoji_enabled").notNull().default(true),
  customEmojiFallback: boolean("custom_emoji_fallback").notNull().default(true),
  ownerChatId: text("owner_chat_id"),
  reviewChatId: text("review_chat_id"),
});

export const insertSettingsSchema = createInsertSchema(settingsTable).omit({ id: true });
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settingsTable.$inferSelect;
