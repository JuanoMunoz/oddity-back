CREATE TYPE "public"."mode" AS ENUM('CHAT', 'FILE', 'IMAGE', 'VIDEO');--> statement-breakpoint
ALTER TABLE "custom_agent" ADD COLUMN "mode" "mode" DEFAULT 'CHAT' NOT NULL;