CREATE TABLE "agent_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"model_id" integer,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"total" numeric NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_agent" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"system_prompt" text NOT NULL,
	"organization_id" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_agent_model" (
	"id" serial PRIMARY KEY NOT NULL,
	"custom_agent_id" integer NOT NULL,
	"model_id" integer NOT NULL,
	"priority" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ia_model" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price_per_input_token" numeric NOT NULL,
	"price_per_output_token" numeric NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"access_token" text NOT NULL,
	"billing_email" text NOT NULL,
	"monthly_spending_limit" numeric NOT NULL,
	"slug" text NOT NULL,
	"logo" text NOT NULL,
	"current_spent" numeric NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role_id" integer,
	"organization_id" integer,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_agent_id_custom_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."custom_agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_model_id_ia_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ia_model"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_agent" ADD CONSTRAINT "custom_agent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_agent_model" ADD CONSTRAINT "custom_agent_model_custom_agent_id_custom_agent_id_fk" FOREIGN KEY ("custom_agent_id") REFERENCES "public"."custom_agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_agent_model" ADD CONSTRAINT "custom_agent_model_model_id_ia_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ia_model"("id") ON DELETE no action ON UPDATE no action;