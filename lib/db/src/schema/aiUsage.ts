import { pgTable, text, serial, integer, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const aiUsageTable = pgTable("ai_usage", {
  id: serial("id").primaryKey(),
  date: date("date", { mode: "string" }).notNull().unique(),
  callsUsed: integer("calls_used").notNull().default(0),
  postsGenerated: integer("posts_generated").notNull().default(0),
  rewritesUsed: integer("rewrites_used").notNull().default(0),
});

export const insertAiUsageSchema = createInsertSchema(aiUsageTable).omit({ id: true });
export type InsertAiUsage = z.infer<typeof insertAiUsageSchema>;
export type AiUsage = typeof aiUsageTable.$inferSelect;
