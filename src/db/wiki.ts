// [START] Phase 6.3 — wiki_pages CRUD + FTS5 search helpers.
// Mirrors the db/sessions.ts pattern (getDb singleton, raw SQL, typed rows).
// FTS5 MATCH queries return the top-N pages by keyword relevance; used to
// inject persistent project knowledge into the chat system prompt.

import { getDb, newId, nowMs } from "./index";

// [START] Phase 6.4 — Wiki tiers. 'note' is raw, 'casebook' is distilled
// patterns / lessons, 'canonical' is vetted project knowledge. Retrieval
// weighs canonical > casebook > note.
export type WikiTier = "note" | "casebook" | "canonical";
export const WIKI_TIERS: ReadonlyArray<WikiTier> = ["note", "casebook", "canonical"];

function isWikiTier(v: unknown): v is WikiTier {
  return v === "note" || v === "casebook" || v === "canonical";
}
// [END]

export interface WikiPageRow {
  id: string;
  title: string;
  slug: string;
  content: string;
  tags_json: string | null;
  category: string | null;
  pinned: number;
  created_at: number;
  updated_at: number;
  tier: string;
}

export interface WikiPage {
  id: string;
  title: string;
  slug: string;
  content: string;
  tags: string[];
  category: string | null;
  pinned: boolean;
  tier: WikiTier;
  created_at: number;
  updated_at: number;
}

function rowToPage(row: WikiPageRow): WikiPage {
  let tags: string[] = [];
  if (row.tags_json) {
    try {
      const parsed: unknown = JSON.parse(row.tags_json);
      if (Array.isArray(parsed)) {
        tags = parsed.filter((t): t is string => typeof t === "string");
      }
    } catch {
      /* invalid tags_json — treat as empty */
    }
  }
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    content: row.content,
    tags,
    category: row.category,
    pinned: row.pinned === 1,
    tier: isWikiTier(row.tier) ? row.tier : "note",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `page-${Date.now().toString(36)}`;
}

export interface CreateWikiPageInput {
  title: string;
  content?: string;
  tags?: string[];
  category?: string | null;
  tier?: WikiTier;
}

export async function createWikiPage(input: CreateWikiPageInput): Promise<WikiPage> {
  const db = await getDb();
  const id = newId();
  const ts = nowMs();
  const baseSlug = slugify(input.title);

  // Ensure slug uniqueness — if collision, append short id suffix.
  let slug = baseSlug;
  const existing = await db.select<{ id: string }[]>(
    `SELECT id FROM wiki_pages WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  if (existing.length > 0) {
    slug = `${baseSlug}-${id.slice(0, 6)}`;
  }

  const tagsJson = input.tags && input.tags.length > 0 ? JSON.stringify(input.tags) : null;
  const tier: WikiTier = input.tier ?? "note";

  await db.execute(
    `INSERT INTO wiki_pages (id, title, slug, content, tags_json, category, pinned, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $8)`,
    [id, input.title, slug, input.content ?? "", tagsJson, input.category ?? null, tier, ts],
  );
  return {
    id,
    title: input.title,
    slug,
    content: input.content ?? "",
    tags: input.tags ?? [],
    category: input.category ?? null,
    pinned: false,
    tier,
    created_at: ts,
    updated_at: ts,
  };
}

export async function listWikiPages(): Promise<WikiPage[]> {
  const db = await getDb();
  const rows = await db.select<WikiPageRow[]>(
    `SELECT * FROM wiki_pages ORDER BY pinned DESC, updated_at DESC`,
  );
  return rows.map(rowToPage);
}

export async function getWikiPage(id: string): Promise<WikiPage | null> {
  const db = await getDb();
  const rows = await db.select<WikiPageRow[]>(
    `SELECT * FROM wiki_pages WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToPage(rows[0]) : null;
}

export interface UpdateWikiPageInput {
  title?: string;
  content?: string;
  tags?: string[];
  category?: string | null;
  pinned?: boolean;
  tier?: WikiTier;
}

export async function updateWikiPage(id: string, patch: UpdateWikiPageInput): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  let p = 1;
  if (patch.title !== undefined) {
    sets.push(`title = $${p++}`);
    params.push(patch.title);
  }
  if (patch.content !== undefined) {
    sets.push(`content = $${p++}`);
    params.push(patch.content);
  }
  if (patch.tags !== undefined) {
    sets.push(`tags_json = $${p++}`);
    params.push(patch.tags.length > 0 ? JSON.stringify(patch.tags) : null);
  }
  if (patch.category !== undefined) {
    sets.push(`category = $${p++}`);
    params.push(patch.category);
  }
  if (patch.pinned !== undefined) {
    sets.push(`pinned = $${p++}`);
    params.push(patch.pinned ? 1 : 0);
  }
  if (patch.tier !== undefined) {
    sets.push(`tier = $${p++}`);
    params.push(patch.tier);
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = $${p++}`);
  params.push(nowMs());
  params.push(id);
  await db.execute(
    `UPDATE wiki_pages SET ${sets.join(", ")} WHERE id = $${p}`,
    params,
  );
}

export async function deleteWikiPage(id: string): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM wiki_pages WHERE id = $1`, [id]);
}

// [START] FTS5 search — ranks by bm25. Empty query returns [] (caller should
// fall back to listWikiPages for the full catalog). Special characters in
// query are escaped by wrapping in double quotes, letting FTS5 treat it as a
// phrase; callers can still pass multi-word keywords.
export async function searchWikiPages(query: string, limit = 10): Promise<WikiPage[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const db = await getDb();
  // Escape any double quotes inside the query, then wrap as a phrase for FTS5.
  const escaped = trimmed.replace(/"/g, '""');
  const ftsQuery = `"${escaped}"`;
  // Canonical pages rank first, then casebook, then raw notes. Within a
  // tier FTS5's bm25 handles relevance; pinned + recency break ties.
  const rows = await db.select<WikiPageRow[]>(
    `SELECT p.*
       FROM wiki_fts f
       JOIN wiki_pages p ON p.rowid = f.rowid
      WHERE wiki_fts MATCH $1
      ORDER BY
        CASE p.tier
          WHEN 'canonical' THEN 0
          WHEN 'casebook' THEN 1
          ELSE 2
        END,
        bm25(wiki_fts),
        p.pinned DESC,
        p.updated_at DESC
      LIMIT $2`,
    [ftsQuery, limit],
  );
  return rows.map(rowToPage);
}
// [END]
// [END]
