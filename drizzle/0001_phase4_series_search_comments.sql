CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"parent_id" uuid,
	"author_name" text NOT NULL,
	"author_email" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"is_author" boolean DEFAULT false NOT NULL,
	"author_ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_status_check" CHECK ("comments"."status" in ('pending', 'approved', 'rejected', 'spam'))
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(excerpt, '')), 'B') ||
          setweight(to_tsvector('english', regexp_replace(coalesce(content_html, ''), '<[^>]*>', ' ', 'g')), 'C')) STORED;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_post_status_idx" ON "comments" USING btree ("post_id","status");--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "comments_status_created_idx" ON "comments" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "comments_ip_created_idx" ON "comments" USING btree ("author_ip_hash","created_at");--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posts_series_idx" ON "posts" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "posts_search_idx" ON "posts" USING gin ("search_vector");