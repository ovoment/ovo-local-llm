import { getDb, nowMs } from "./index";
import type { ModelContextOverride } from "../types/ovo";

interface OverrideRow {
  repo_id: string;
  max_context: number;
  warn_threshold: number;
  updated_at: number;
}

export async function listOverrides(): Promise<ModelContextOverride[]> {
  const db = await getDb();
  const rows = await db.select<OverrideRow[]>(
    `SELECT * FROM model_context_overrides ORDER BY repo_id ASC`,
  );
  return rows;
}

export async function getOverride(
  repoId: string,
): Promise<ModelContextOverride | null> {
  const db = await getDb();
  const rows = await db.select<OverrideRow[]>(
    `SELECT * FROM model_context_overrides WHERE repo_id = $1 LIMIT 1`,
    [repoId],
  );
  return rows[0] ?? null;
}

export async function upsertOverride(
  input: Omit<ModelContextOverride, "updated_at">,
): Promise<ModelContextOverride> {
  const db = await getDb();
  const now = nowMs();
  await db.execute(
    `INSERT INTO model_context_overrides (repo_id, max_context, warn_threshold, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(repo_id) DO UPDATE SET
       max_context = excluded.max_context,
       warn_threshold = excluded.warn_threshold,
       updated_at = excluded.updated_at`,
    [input.repo_id, input.max_context, input.warn_threshold, now],
  );
  return { ...input, updated_at: now };
}

export async function deleteOverride(repoId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM model_context_overrides WHERE repo_id = $1`,
    [repoId],
  );
}
