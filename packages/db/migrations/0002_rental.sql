CREATE TABLE "asset_types" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tracking" text NOT NULL,
	"code_prefix" text,
	"price_per_day" bigint NOT NULL,
	"deposit" bigint,
	"listed_on_marketplace" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_types_tracking_check" CHECK ("asset_types"."tracking" in ('unit', 'quantity')),
	CONSTRAINT "asset_types_price_check" CHECK ("asset_types"."price_per_day" >= 0 and coalesce("asset_types"."deposit", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "asset_variants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_type_id" uuid NOT NULL,
	"label" text NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_variants_quantity_check" CHECK ("asset_variants"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_type_id" uuid NOT NULL,
	"branch_id" uuid,
	"code" text NOT NULL,
	"model" text,
	"plate" text,
	"color" text,
	"odometer" integer,
	"status" text DEFAULT 'available' NOT NULL,
	"price_per_day" bigint,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_status_check" CHECK ("assets"."status" in ('available', 'maintenance', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"rental_id" uuid,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_lines_kind_check" CHECK ("bill_lines"."kind" in ('rental', 'extension', 'late_fee', 'fuel', 'damage', 'gear', 'discount', 'other')),
	CONSTRAINT "bill_lines_discount_check" CHECK (("bill_lines"."kind" = 'discount') = ("bill_lines"."amount" < 0)),
	CONSTRAINT "bill_lines_reason_check" CHECK ("bill_lines"."kind" not in ('discount', 'other') or "bill_lines"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"receipt_no" text,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bills_status_check" CHECK ("bills"."status" in ('open', 'paid', 'void'))
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"nationality" text,
	"phone" text,
	"email" text,
	"hotel_room" text,
	"checkout_date" date,
	"notes" text,
	"do_not_rent" boolean DEFAULT false NOT NULL,
	"do_not_rent_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_dnr_reason" CHECK (not "customers"."do_not_rent" or "customers"."do_not_rent_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "org_counters" (
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount" bigint NOT NULL,
	"received_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_method_check" CHECK ("payments"."method" in ('cash', 'promptpay', 'transfer', 'card')),
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "rental_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"rental_id" uuid NOT NULL,
	"asset_type_id" uuid NOT NULL,
	"asset_id" uuid,
	"variant_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"price_per_day" bigint NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rental_items_target_check" CHECK (("rental_items"."asset_id" is not null and "rental_items"."variant_id" is null and "rental_items"."quantity" = 1) or ("rental_items"."asset_id" is null and "rental_items"."variant_id" is not null and "rental_items"."quantity" > 0))
);
--> statement-breakpoint
CREATE TABLE "rentals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"branch_id" uuid,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"channel" text DEFAULT 'walk_in' NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"returned_at" timestamp with time zone,
	"payment_mode" text DEFAULT 'at_checkout' NOT NULL,
	"deposit" bigint,
	"notes" text,
	"created_by" uuid NOT NULL,
	"returned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rentals_status_check" CHECK ("rentals"."status" in ('active', 'returned', 'cancelled')),
	CONSTRAINT "rentals_channel_check" CHECK ("rentals"."channel" in ('walk_in', 'hotel', 'booking_page', 'marketplace')),
	CONSTRAINT "rentals_payment_check" CHECK ("rentals"."payment_mode" in ('at_checkout', 'pay_now')),
	CONSTRAINT "rentals_dates_check" CHECK ("rentals"."due_at" > "rentals"."start_at")
);
--> statement-breakpoint
ALTER TABLE "asset_types" ADD CONSTRAINT "asset_types_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_variants" ADD CONSTRAINT "asset_variants_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_variants" ADD CONSTRAINT "asset_variants_asset_type_id_asset_types_id_fk" FOREIGN KEY ("asset_type_id") REFERENCES "public"."asset_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_asset_type_id_asset_types_id_fk" FOREIGN KEY ("asset_type_id") REFERENCES "public"."asset_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_rental_id_rentals_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rentals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_counters" ADD CONSTRAINT "org_counters_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_items" ADD CONSTRAINT "rental_items_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_items" ADD CONSTRAINT "rental_items_rental_id_rentals_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rentals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_items" ADD CONSTRAINT "rental_items_asset_type_id_asset_types_id_fk" FOREIGN KEY ("asset_type_id") REFERENCES "public"."asset_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_items" ADD CONSTRAINT "rental_items_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_items" ADD CONSTRAINT "rental_items_variant_id_asset_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."asset_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_returned_by_users_id_fk" FOREIGN KEY ("returned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_types_org_idx" ON "asset_types" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_variants_type_label_key" ON "asset_variants" USING btree ("asset_type_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_org_code_key" ON "assets" USING btree ("org_id",upper("code"));--> statement-breakpoint
CREATE INDEX "assets_type_idx" ON "assets" USING btree ("asset_type_id");--> statement-breakpoint
CREATE INDEX "bill_lines_bill_idx" ON "bill_lines" USING btree ("bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bills_one_open_per_customer" ON "bills" USING btree ("customer_id") WHERE "bills"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "bills_receipt_key" ON "bills" USING btree ("org_id","receipt_no");--> statement-breakpoint
CREATE INDEX "bills_org_status_idx" ON "bills" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "customers_org_idx" ON "customers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "customers_room_idx" ON "customers" USING btree ("org_id","hotel_room");--> statement-breakpoint
CREATE UNIQUE INDEX "org_counters_key" ON "org_counters" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "payments_bill_idx" ON "payments" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "payments_org_time_idx" ON "payments" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rental_items_one_active_per_asset" ON "rental_items" USING btree ("asset_id") WHERE "rental_items"."asset_id" is not null and "rental_items"."released_at" is null;--> statement-breakpoint
CREATE INDEX "rental_items_rental_idx" ON "rental_items" USING btree ("rental_id");--> statement-breakpoint
CREATE INDEX "rental_items_variant_active_idx" ON "rental_items" USING btree ("variant_id") WHERE "rental_items"."released_at" is null;--> statement-breakpoint
CREATE INDEX "rentals_org_status_idx" ON "rentals" USING btree ("org_id","status","due_at");--> statement-breakpoint
CREATE INDEX "rentals_customer_idx" ON "rentals" USING btree ("customer_id");