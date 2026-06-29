import { Router } from "express";
import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { getSettings } from "../lib/openai";

const router = Router();

router.get("/settings", async (_req, res): Promise<void> => {
  const settings = await getSettings();
  res.json(settings);
});

router.patch("/settings", async (req, res): Promise<void> => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const current = await getSettings();
  const updateData: Record<string, unknown> = {};
  const d = parsed.data;

  if (d.openaiModel !== undefined) updateData.openaiModel = d.openaiModel;
  if (d.maxAiCallsPerDay !== undefined) updateData.maxAiCallsPerDay = d.maxAiCallsPerDay;
  if (d.maxPostsPerDay !== undefined) updateData.maxPostsPerDay = d.maxPostsPerDay;
  if (d.minPostsPerDay !== undefined) updateData.minPostsPerDay = d.minPostsPerDay;
  if (d.maxRewritePerPost !== undefined) updateData.maxRewritePerPost = d.maxRewritePerPost;
  if (d.maxTokensPerPost !== undefined) updateData.maxTokensPerPost = d.maxTokensPerPost;
  if (d.maxSourcePostsPerChannel !== undefined) updateData.maxSourcePostsPerChannel = d.maxSourcePostsPerChannel;
  if (d.lookbackHours !== undefined) updateData.lookbackHours = d.lookbackHours;
  if (d.enableCostGuard !== undefined) updateData.enableCostGuard = d.enableCostGuard;
  if (d.autoPublish !== undefined) updateData.autoPublish = d.autoPublish;
  if (d.postingRequiresApproval !== undefined) updateData.postingRequiresApproval = d.postingRequiresApproval;
  if (d.enableSecondarySourcesi !== undefined) updateData.enableSecondarySourcesi = d.enableSecondarySourcesi;
  if (d.customEmojiEnabled !== undefined) updateData.customEmojiEnabled = d.customEmojiEnabled;
  if (d.customEmojiFallback !== undefined) updateData.customEmojiFallback = d.customEmojiFallback;
  if (d.ownerChatId !== undefined) updateData.ownerChatId = d.ownerChatId;
  if (d.reviewChatId !== undefined) updateData.reviewChatId = d.reviewChatId;

  const [updated] = await db
    .update(settingsTable)
    .set(updateData)
    .where(eq(settingsTable.id, current.id))
    .returning();
  res.json(updated);
});

export default router;
