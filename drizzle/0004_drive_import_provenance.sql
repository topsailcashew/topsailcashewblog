ALTER TABLE "posts" ADD COLUMN "drive_file_id" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "drive_modified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_drive_file_id_unique" UNIQUE("drive_file_id");