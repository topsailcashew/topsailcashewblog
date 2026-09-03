CREATE TABLE "ap_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid,
	"inbox_uri" text NOT NULL,
	"status_code" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ap_followers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_uri" text NOT NULL,
	"inbox_uri" text NOT NULL,
	"shared_inbox_uri" text,
	"handle" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ap_followers_actor_uri_unique" UNIQUE("actor_uri")
);
--> statement-breakpoint
CREATE TABLE "email_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid,
	"subject" text NOT NULL,
	"body_html" text,
	"body_text" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_campaigns_status_check" CHECK ("email_campaigns"."status" in ('draft', 'sending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"open_count" integer DEFAULT 0 NOT NULL,
	"clicked_at" timestamp with time zone,
	"click_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_sends_campaign_subscriber_key" UNIQUE("campaign_id","subscriber_id"),
	CONSTRAINT "email_sends_status_check" CHECK ("email_sends"."status" in ('queued', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriber_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"send_id" uuid,
	"type" text NOT NULL,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriber_events_type_check" CHECK ("subscriber_events"."type" in ('subscribed', 'confirmed', 'unsubscribed', 'sent', 'opened', 'clicked', 'bounced', 'complained'))
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"source" text DEFAULT 'form' NOT NULL,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_term" text,
	"utm_content" text,
	"referrer_host" text,
	"landing_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscribers_email_unique" UNIQUE("email"),
	CONSTRAINT "subscribers_status_check" CHECK ("subscribers"."status" in ('pending', 'subscribed', 'unsubscribed', 'bounced', 'complained'))
);
--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "author_email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "source" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "remote_actor_uri" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "remote_object_uri" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "role" text DEFAULT 'informative' NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "long_description" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "blurhash" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "lqip" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "exif" jsonb;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "federated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ap_deliveries" ADD CONSTRAINT "ap_deliveries_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_campaign_id_email_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."email_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_events" ADD CONSTRAINT "subscriber_events_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_events" ADD CONSTRAINT "subscriber_events_send_id_email_sends_id_fk" FOREIGN KEY ("send_id") REFERENCES "public"."email_sends"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ap_deliveries_post_idx" ON "ap_deliveries" USING btree ("post_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ap_followers_active_idx" ON "ap_followers" USING btree ("active");--> statement-breakpoint
CREATE INDEX "email_campaigns_created_idx" ON "email_campaigns" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_campaigns_post_idx" ON "email_campaigns" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "email_sends_campaign_idx" ON "email_sends" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "email_sends_subscriber_idx" ON "email_sends" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "subscriber_events_subscriber_idx" ON "subscriber_events" USING btree ("subscriber_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "subscribers_status_created_idx" ON "subscribers" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "subscribers_created_at_idx" ON "subscribers" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "subscribers_unsubscribed_at_idx" ON "subscribers" USING btree ("unsubscribed_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_remote_object_uri_unique" UNIQUE("remote_object_uri");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_source_check" CHECK ("comments"."source" in ('web', 'fediverse'));--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_identity_check" CHECK (("comments"."source" = 'web' and "comments"."author_email" is not null)
          or ("comments"."source" = 'fediverse' and "comments"."remote_actor_uri" is not null));--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_role_check" CHECK ("media"."role" in ('informative', 'decorative', 'functional', 'complex'));