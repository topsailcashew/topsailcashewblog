-- Typo-tolerant search.
--
-- Full-text search matches lexemes: "slow software" finds the post, "slwo
-- software" finds nothing at all, because the misspelling stems to a word
-- that is in no document. Trigram similarity compares overlapping
-- three-character windows instead, so a transposed pair still scores highly.
--
-- This is a *fallback*, not a replacement. Full-text ranking is far better
-- when the spelling is right; the trigram query only runs when full-text
-- returned nothing (see searchPublished).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
-- GIN over trigrams, so `%` and similarity() are index-assisted rather than a
-- sequential scan with a similarity computation per row.
CREATE INDEX IF NOT EXISTS "posts_title_trgm_idx" ON "posts" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_excerpt_trgm_idx" ON "posts" USING gin ("excerpt" gin_trgm_ops);
