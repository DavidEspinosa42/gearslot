CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"max_active_per_user" integer NOT NULL,
	CONSTRAINT "categories_cap_non_negative" CHECK ("categories"."max_active_per_user" >= 0)
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "lab_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"timezone" text DEFAULT 'America/Argentina/Buenos_Aires' NOT NULL,
	"slot_minutes" integer DEFAULT 15 NOT NULL,
	"min_minutes" integer DEFAULT 15 NOT NULL,
	"max_minutes" integer DEFAULT 4320 NOT NULL,
	"horizon_days" integer DEFAULT 30 NOT NULL,
	"retention_months" integer DEFAULT 12 NOT NULL,
	CONSTRAINT "lab_settings_single_row" CHECK ("lab_settings"."id"),
	CONSTRAINT "lab_settings_slot_positive" CHECK ("lab_settings"."slot_minutes" > 0),
	CONSTRAINT "lab_settings_bounds" CHECK ("lab_settings"."min_minutes" > 0 AND "lab_settings"."max_minutes" >= "lab_settings"."min_minutes"),
	CONSTRAINT "lab_settings_horizon_positive" CHECK ("lab_settings"."horizon_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"blocked_until" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "reservations_user_key_unique" UNIQUE("user_id","idempotency_key"),
	CONSTRAINT "reservations_range_valid" CHECK ("reservations"."ends_at" > "reservations"."starts_at"),
	CONSTRAINT "reservations_blocked_covers_end" CHECK ("reservations"."blocked_until" >= "reservations"."ends_at"),
	CONSTRAINT "reservations_status_valid" CHECK ("reservations"."status" IN ('active', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category_id" text NOT NULL,
	"model" text NOT NULL,
	"location_label" text NOT NULL,
	"buffer_minutes" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_name_unique" UNIQUE("name"),
	CONSTRAINT "resources_buffer_non_negative" CHECK ("resources"."buffer_minutes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_records_created_at_idx" ON "idempotency_records" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "reservations_user_status_idx" ON "reservations" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "reservations_resource_start_idx" ON "reservations" USING btree ("resource_id","starts_at");--> statement-breakpoint
CREATE INDEX "reservations_created_at_idx" ON "reservations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "resources_model_idx" ON "resources" USING btree ("model");