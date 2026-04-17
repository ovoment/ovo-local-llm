-- Phase 6.4 · Wiki tiering (Note / Casebook / Canonical).
-- 'tier' is the stage a page sits at in the knowledge-maturity pipeline:
--   note       — raw jotting, unchecked
--   casebook   — pattern / lesson distilled from multiple notes
--   canonical  — project-level source of truth, gets top retrieval weight
--
-- Default is 'note' so every existing page stays where it was. SQLite 3 has
-- no CHECK constraint alteration, so this is the cheapest add-column pass.

ALTER TABLE wiki_pages
  ADD COLUMN tier TEXT NOT NULL DEFAULT 'note';

CREATE INDEX IF NOT EXISTS idx_wiki_tier ON wiki_pages(tier, updated_at DESC);
