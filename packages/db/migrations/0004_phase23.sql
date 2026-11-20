CREATE TABLE "booking_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"asset_type_id" uuid NOT NULL,
	"variant_id" uuid,
	"asset_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"price_per_day" bigint NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	CONSTRAINT "booking_items_quantity_check" CHECK ("booking_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"channel" text DEFAULT 'booking_page' NOT NULL,
	"full_name" text NOT NULL,
	"whatsapp" text NOT NULL,
	"email" text,
	"hotel_room" text,
	"checkout_date" date,
	"has_license" boolean DEFAULT false NOT NULL,
	"pickup_at" timestamp with time zone NOT NULL,
	"days" integer NOT NULL,
	"notes" text,
	"source" text,
	"manage_token_hash" text NOT NULL,
	"customer_id" uuid,
	"rental_id" uuid,
	"reject_reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_status_check" CHECK ("bookings"."status" in ('requested', 'confirmed', 'rejected', 'cancelled', 'picked_up', 'no_show')),
	CONSTRAINT "bookings_channel_check" CHECK ("bookings"."channel" in ('booking_page', 'marketplace', 'phone')),
	CONSTRAINT "bookings_days_check" CHECK ("bookings"."days" between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "day_closes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"branch_id" uuid,
	"business_date" date NOT NULL,
	"expected_cash" bigint NOT NULL,
	"counted_cash" bigint NOT NULL,
	"expected_other" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"closed_by" uuid NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	"odometer" integer,
	"performed_on" date NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_kind_check" CHECK ("maintenance_records"."kind" in ('oil', 'tire', 'brake', 'repair', 'insurance', 'tax', 'other')),
	CONSTRAINT "maintenance_cost_check" CHECK ("maintenance_records"."cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"slot" text,
	"stage" text,
	"rental_id" uuid,
	"customer_id" uuid,
	"asset_id" uuid,
	"maintenance_id" uuid,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_after" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "media_kind_check" CHECK ("media"."kind" in ('vehicle_photo', 'document', 'signature', 'maintenance_receipt')),
	CONSTRAINT "media_stage_check" CHECK ("media"."stage" is null or "media"."stage" in ('checkout', 'return')),
	CONSTRAINT "media_size_check" CHECK ("media"."size_bytes" > 0 and "media"."size_bytes" <= 15728640)
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"body" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_org_id_key_pk" PRIMARY KEY("org_id","key"),
	CONSTRAINT "message_templates_key_check" CHECK ("message_templates"."key" in ('booking_confirmed', 'booking_rejected', 'return_reminder', 'receipt', 'thank_you'))
);
--> statement-breakpoint
CREATE TABLE "stock_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_adjustments_delta_check" CHECK ("stock_adjustments"."delta" <> 0)
);
--> statement-breakpoint
ALTER TABLE "asset_types" ADD COLUMN "service_interval_km" integer;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "insurance_expires_on" date;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "tax_expires_on" date;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "next_service_odometer" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "rentals" ADD COLUMN "signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rentals" ADD COLUMN "signer_name" text;--> statement-breakpoint
ALTER TABLE "rentals" ADD COLUMN "booking_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_asset_type_id_asset_types_id_fk" FOREIGN KEY ("asset_type_id") REFERENCES "public"."asset_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_variant_id_asset_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."asset_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_rental_id_rentals_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rentals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_closes" ADD CONSTRAINT "day_closes_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_closes" ADD CONSTRAINT "day_closes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_closes" ADD CONSTRAINT "day_closes_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_rental_id_rentals_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rentals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_variant_id_asset_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."asset_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_items_booking_idx" ON "booking_items" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_org_code_key" ON "bookings" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_token_key" ON "bookings" USING btree ("manage_token_hash");--> statement-breakpoint
CREATE INDEX "bookings_org_status_idx" ON "bookings" USING btree ("org_id","status","pickup_at");--> statement-breakpoint
CREATE UNIQUE INDEX "day_closes_org_date_key" ON "day_closes" USING btree ("org_id","business_date");--> statement-breakpoint
CREATE INDEX "maintenance_asset_idx" ON "maintenance_records" USING btree ("asset_id","performed_on");--> statement-breakpoint
CREATE INDEX "media_rental_idx" ON "media" USING btree ("rental_id");--> statement-breakpoint
CREATE INDEX "media_customer_idx" ON "media" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "media_purge_idx" ON "media" USING btree ("delete_after") WHERE "media"."deleted_at" is null and "media"."delete_after" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "media_storage_key" ON "media" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "stock_adjustments_variant_idx" ON "stock_adjustments" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_client_key" ON "payments" USING btree ("org_id","client_id");