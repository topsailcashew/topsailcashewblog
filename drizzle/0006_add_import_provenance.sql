ALTER TABLE "posts" ADD COLUMN "import_key" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_import_key_unique" UNIQUE("import_key");