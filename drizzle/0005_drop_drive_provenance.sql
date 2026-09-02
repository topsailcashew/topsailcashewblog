ALTER TABLE "posts" DROP CONSTRAINT "posts_drive_file_id_unique";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "drive_file_id";--> statement-breakpoint
ALTER TABLE "posts" DROP COLUMN "drive_modified_at";