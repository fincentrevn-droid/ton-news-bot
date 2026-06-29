import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, sourcesTable } from "@workspace/db";
import {
  CreateSourceBody,
  UpdateSourceParams,
  UpdateSourceBody,
  DeleteSourceParams,
} from "@workspace/api-zod";

const router = Router();

router.get("/sources", async (_req, res): Promise<void> => {
  const rows = await db.select().from(sourcesTable).orderBy(sourcesTable.createdAt);
  res.json(rows);
});

router.post("/sources", async (req, res): Promise<void> => {
  const parsed = CreateSourceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [source] = await db
    .insert(sourcesTable)
    .values({
      name: parsed.data.name,
      url: parsed.data.url,
      type: parsed.data.type,
      isPrimary: parsed.data.isPrimary ?? false,
      category: parsed.data.category ?? null,
      enabled: parsed.data.enabled ?? true,
    })
    .returning();
  res.status(201).json(source);
});

router.patch("/sources/:id", async (req, res): Promise<void> => {
  const params = UpdateSourceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateSourceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updateData: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
  if (parsed.data.url !== undefined) updateData.url = parsed.data.url;
  if (parsed.data.enabled !== undefined) updateData.enabled = parsed.data.enabled;
  if (parsed.data.isPrimary !== undefined) updateData.isPrimary = parsed.data.isPrimary;
  if (parsed.data.category !== undefined) updateData.category = parsed.data.category;

  if (Object.keys(updateData).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const [source] = await db
    .update(sourcesTable)
    .set(updateData)
    .where(eq(sourcesTable.id, params.data.id))
    .returning();
  if (!source) {
    res.status(404).json({ error: "Source not found" });
    return;
  }
  res.json(source);
});

router.delete("/sources/:id", async (req, res): Promise<void> => {
  const params = DeleteSourceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db.delete(sourcesTable).where(eq(sourcesTable.id, params.data.id)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Source not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
