import { pgTable, serial, timestamp, integer, boolean, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const schedulesTable = pgTable("schedules", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  intervalHours: integer("interval_hours").notNull().default(4),
  maxPostsPerDay: integer("max_posts_per_day").notNull().default(8),
  autoPublish: boolean("auto_publish").notNull().default(false),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  // ─── Posting window ───────────────────────────────────────────
  postingTimezone: text("posting_timezone").notNull().default("Europe/Kyiv"),
  postingStartTime: text("posting_start_time").notNull().default("09:00"),
  postingEndTime: text("posting_end_time").notNull().default("23:30"),
  // ─── Night pause ──────────────────────────────────────────────
  nightPauseEnabled: boolean("night_pause_enabled").notNull().default(true),
  nightPauseStart: text("night_pause_start").notNull().default("00:00"),
  nightPauseEnd: text("night_pause_end").notNull().default("08:30"),
  // ─── Daily targets ────────────────────────────────────────────
  minPostsPerDay: integer("min_posts_per_day").notNull().default(6),
  targetPostsPerDay: integer("target_posts_per_day").notNull().default(7),
  // ─── Spacing ──────────────────────────────────────────────────
  minMinutesBetweenPosts: integer("min_minutes_between_posts").notNull().default(75),
  maxMinutesBetweenPosts: integer("max_minutes_between_posts").notNull().default(180),
  randomDelayEnabled: boolean("random_delay_enabled").notNull().default(true),
  randomDelayMinutes: integer("random_delay_minutes").notNull().default(25),
  // ─── Publish tracking ─────────────────────────────────────────
  lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
});

export const insertScheduleSchema = createInsertSchema(schedulesTable).omit({ id: true });
export type InsertSchedule = z.infer<typeof insertScheduleSchema>;
export type Schedule = typeof schedulesTable.$inferSelect;
