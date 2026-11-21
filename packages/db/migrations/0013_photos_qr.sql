ALTER TABLE "media" DROP CONSTRAINT "media_kind_check";--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "contact_whatsapp" text;--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "asset_types" ADD COLUMN "cover_media_id" uuid;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "cover_media_id" uuid;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "qr_token" text DEFAULT replace(gen_random_uuid()::text, '-', '') NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "asset_type_id" uuid;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_asset_type_id_asset_types_id_fk" FOREIGN KEY ("asset_type_id") REFERENCES "public"."asset_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_qr_token_key" ON "assets" USING btree ("qr_token");--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_contact_check" CHECK (("org_settings"."contact_whatsapp" is null or "org_settings"."contact_whatsapp" ~ '^[+]?[0-9]{8,15}$') and ("org_settings"."contact_phone" is null or "org_settings"."contact_phone" ~ '^[+]?[0-9]{8,15}$'));--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_kind_check" CHECK ("media"."kind" in ('vehicle_photo', 'document', 'signature', 'maintenance_receipt', 'cover'));--> statement-breakpoint

-- ---------- รูปหน้าปก + สติกเกอร์ QR + ช่องทางติดต่อร้าน (canvas หน้า 9–10) ----------
-- FK ของรูปหน้าปกเพิ่มด้วย SQL (media อยู่ใน ops.ts ซึ่ง import rental.ts · เดียวกับ media_maintenance_fk)
ALTER TABLE asset_types ADD CONSTRAINT asset_types_cover_media_fk FOREIGN KEY (cover_media_id) REFERENCES media(id);
--> statement-breakpoint
ALTER TABLE assets ADD CONSTRAINT assets_cover_media_fk FOREIGN KEY (cover_media_id) REFERENCES media(id);
--> statement-breakpoint
-- รูปหน้าปกผูกกับเป้าหมายเดียว (ประเภท หรือ คัน) · asset_type_id ใช้กับรูปหน้าปกเท่านั้น
ALTER TABLE media ADD CONSTRAINT media_cover_target_check
  CHECK (kind <> 'cover' OR ((asset_id IS NULL) <> (asset_type_id IS NULL)));
--> statement-breakpoint
ALTER TABLE media ADD CONSTRAINT media_asset_type_only_cover CHECK (asset_type_id IS NULL OR kind = 'cover');
--> statement-breakpoint

-- รูปที่ตั้งเป็นหน้าปกต้องเป็นรูปชนิด cover ของร้านนี้ ที่อัปโหลดมาให้เป้าหมายนี้ และยังไม่ถูกลบ
-- (ตรวจใต้ RLS ของผู้ใช้ปัจจุบันเหมือน app.assert_visible: รูปของร้านอื่นมองไม่เห็น จึงถือว่าไม่มี)
CREATE FUNCTION app.assert_cover(ref uuid, for_asset uuid, for_type uuid) RETURNS void LANGUAGE plpgsql AS
$$ BEGIN
  IF ref IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM media m
    WHERE m.id = ref AND m.org_id = app.org_id() AND m.kind = 'cover' AND m.deleted_at IS NULL
      AND m.asset_id IS NOT DISTINCT FROM for_asset AND m.asset_type_id IS NOT DISTINCT FROM for_type
  ) THEN
    RAISE EXCEPTION 'cross_org_reference: media' USING ERRCODE = '23503';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.same_org_refs() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF TG_TABLE_NAME = 'asset_types' THEN
    IF TG_OP = 'INSERT' OR NEW.cover_media_id IS DISTINCT FROM OLD.cover_media_id THEN
      PERFORM app.assert_cover(NEW.cover_media_id, NULL, NEW.id);
    END IF;
  ELSIF TG_TABLE_NAME = 'assets' THEN
    PERFORM app.assert_visible('asset_types', NEW.asset_type_id); PERFORM app.assert_visible('branches', NEW.branch_id);
    IF TG_OP = 'INSERT' OR NEW.cover_media_id IS DISTINCT FROM OLD.cover_media_id THEN
      PERFORM app.assert_cover(NEW.cover_media_id, NEW.id, NULL);
    END IF;
  ELSIF TG_TABLE_NAME = 'asset_variants' THEN
    PERFORM app.assert_visible('asset_types', NEW.asset_type_id);
  ELSIF TG_TABLE_NAME = 'rentals' THEN
    PERFORM app.assert_visible('customers', NEW.customer_id); PERFORM app.assert_visible('branches', NEW.branch_id);
    PERFORM app.assert_visible('bookings', NEW.booking_id);
  ELSIF TG_TABLE_NAME = 'rental_items' THEN
    PERFORM app.assert_visible('rentals', NEW.rental_id); PERFORM app.assert_visible('asset_types', NEW.asset_type_id);
    PERFORM app.assert_visible('assets', NEW.asset_id); PERFORM app.assert_visible('asset_variants', NEW.variant_id);
  ELSIF TG_TABLE_NAME = 'bills' THEN
    PERFORM app.assert_visible('customers', NEW.customer_id);
  ELSIF TG_TABLE_NAME = 'bill_lines' THEN
    PERFORM app.assert_visible('bills', NEW.bill_id); PERFORM app.assert_visible('rentals', NEW.rental_id);
  ELSIF TG_TABLE_NAME = 'payments' THEN
    PERFORM app.assert_visible('bills', NEW.bill_id);
  ELSIF TG_TABLE_NAME = 'media' THEN
    PERFORM app.assert_visible('rentals', NEW.rental_id); PERFORM app.assert_visible('customers', NEW.customer_id);
    PERFORM app.assert_visible('assets', NEW.asset_id); PERFORM app.assert_visible('maintenance_records', NEW.maintenance_id);
    PERFORM app.assert_visible('asset_types', NEW.asset_type_id);
  ELSIF TG_TABLE_NAME = 'maintenance_records' THEN
    PERFORM app.assert_visible('assets', NEW.asset_id);
  ELSIF TG_TABLE_NAME = 'stock_adjustments' THEN
    PERFORM app.assert_visible('asset_variants', NEW.variant_id);
  ELSIF TG_TABLE_NAME = 'booking_items' THEN
    PERFORM app.assert_visible('bookings', NEW.booking_id); PERFORM app.assert_visible('asset_types', NEW.asset_type_id);
    PERFORM app.assert_visible('assets', NEW.asset_id); PERFORM app.assert_visible('asset_variants', NEW.variant_id);
  ELSIF TG_TABLE_NAME = 'bookings' THEN
    PERFORM app.assert_visible('customers', NEW.customer_id); PERFORM app.assert_visible('rentals', NEW.rental_id);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER same_org_refs BEFORE INSERT OR UPDATE ON asset_types FOR EACH ROW EXECUTE FUNCTION app.same_org_refs();
--> statement-breakpoint
-- พนักงานเปลี่ยนรูปหน้าปก/หมุน QR ไม่ได้ (เจ้าของ/ผู้จัดการเท่านั้น)
CREATE OR REPLACE FUNCTION app.assets_staff_guard() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF app.org_role() NOT IN ('owner', 'manager') AND
     (NEW.asset_type_id, NEW.code, NEW.status, NEW.price_per_day, NEW.plate, NEW.model, NEW.color, NEW.branch_id, NEW.cover_media_id, NEW.qr_token)
     IS DISTINCT FROM (OLD.asset_type_id, OLD.code, OLD.status, OLD.price_per_day, OLD.plate, OLD.model, OLD.color, OLD.branch_id, OLD.cover_media_id, OLD.qr_token) THEN
    RAISE EXCEPTION 'forbidden_field' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.assert_cover(uuid, uuid, uuid) TO rental_app;
--> statement-breakpoint

-- ---------- หน้าจองสาธารณะ: บอกว่าประเภทไหนมีรูปหน้าปก (คัดลอกจาก 0011 + hasCover/coverMediaId) ----------
-- coverMediaId ใช้ทำ URL ของรูป (?v= กันแคชรูปเก่า) · API ตัดออกก่อนส่งให้หน้าเว็บ
CREATE OR REPLACE FUNCTION pub.shop(slug_in text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT jsonb_build_object(
     'orgId', o.id, 'name', o.name, 'slug', o.slug, 'timezone', o.timezone, 'currency', o.currency,
     'maxRentalDays', s.max_rental_days,
     'types', coalesce((
       SELECT jsonb_agg(jsonb_build_object(
         'id', t.id, 'name', coalesce(t.public_name, t.name), 'tracking', t.tracking, 'pricePerDay', t.price_per_day, 'deposit', t.deposit,
         'hasCover', t.cover_media_id IS NOT NULL, 'coverMediaId', t.cover_media_id,
         'variants', coalesce((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'label', v.label) ORDER BY v.created_at)
                               FROM asset_variants v WHERE v.asset_type_id = t.id AND v.quantity > 0), '[]'::jsonb)
       ) ORDER BY t.sort_order, t.created_at)
       FROM asset_types t
       WHERE t.org_id = o.id AND t.archived_at IS NULL
         AND (t.tracking = 'quantity' OR EXISTS (SELECT 1 FROM assets a WHERE a.asset_type_id = t.id AND a.status <> 'retired'))
     ), '[]'::jsonb))
   FROM orgs o JOIN org_settings s ON s.org_id = o.id
   WHERE lower(o.slug) = lower(slug_in) AND o.status = 'active' $$;
--> statement-breakpoint
-- ไฟล์รูปหน้าปกของประเภท (หน้าจอง) · คืนเฉพาะรูปชนิด cover ของประเภทที่ยังเปิดอยู่ ในร้านที่เปิดหน้าจอง
CREATE FUNCTION pub.type_cover(slug_in text, type_in uuid)
RETURNS TABLE (media_id uuid, storage_key text, content_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT m.id, m.storage_key, m.content_type
   FROM orgs o
   JOIN org_settings s ON s.org_id = o.id AND s.public_booking_enabled
   JOIN asset_types t ON t.org_id = o.id AND t.id = type_in AND t.archived_at IS NULL
   JOIN media m ON m.id = t.cover_media_id AND m.org_id = o.id AND m.kind = 'cover' AND m.deleted_at IS NULL
   WHERE lower(o.slug) = lower(slug_in) AND o.status = 'active' $$;
--> statement-breakpoint
-- สแกน QR บนตัวรถ: คืนเฉพาะข้อมูลร้าน + รหัสคัน + ชื่อประเภท (ไม่มีข้อมูลลูกค้า สัญญา ทะเบียน)
CREATE FUNCTION pub.qr_lookup(token_in text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT jsonb_build_object(
     'shopName', o.name, 'shopSlug', o.slug, 'code', a.code,
     'typeId', t.id, 'typePublicName', coalesce(t.public_name, t.name),
     'contactWhatsapp', s.contact_whatsapp, 'contactPhone', s.contact_phone,
     'bookingEnabled', s.public_booking_enabled,
     'hasCover', coalesce(a.cover_media_id, t.cover_media_id) IS NOT NULL,
     'coverMediaId', coalesce(a.cover_media_id, t.cover_media_id))
   FROM assets a
   JOIN asset_types t ON t.id = a.asset_type_id
   JOIN orgs o ON o.id = a.org_id
   JOIN org_settings s ON s.org_id = o.id
   WHERE a.qr_token = token_in AND o.status = 'active' $$;
--> statement-breakpoint
-- ไฟล์รูปหน้าปกของคันที่สแกน (ของคันเอง ไม่มีใช้ของประเภท) · รูปชนิด cover เท่านั้น
CREATE FUNCTION pub.qr_cover(token_in text)
RETURNS TABLE (media_id uuid, storage_key text, content_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT m.id, m.storage_key, m.content_type
   FROM assets a
   JOIN asset_types t ON t.id = a.asset_type_id
   JOIN orgs o ON o.id = a.org_id AND o.status = 'active'
   JOIN media m ON m.id = coalesce(a.cover_media_id, t.cover_media_id) AND m.org_id = a.org_id AND m.kind = 'cover' AND m.deleted_at IS NULL
   WHERE a.qr_token = token_in $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pub.type_cover(text, uuid), pub.qr_lookup(text), pub.qr_cover(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pub.type_cover(text, uuid), pub.qr_lookup(text), pub.qr_cover(text) TO rental_app;
