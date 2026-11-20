-- เฟส 1 (ส่วนที่เหลือ) + เฟส 2 + เฟส 3: RLS, กันจองซ้อน, กฎที่ฐานข้อมูลบังคับเอง

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE rentals ADD CONSTRAINT rentals_booking_fk FOREIGN KEY (booking_id) REFERENCES bookings(id);
--> statement-breakpoint
ALTER TABLE media ADD CONSTRAINT media_maintenance_fk FOREIGN KEY (maintenance_id) REFERENCES maintenance_records(id);
--> statement-breakpoint

-- ---------- กันจองซ้อน: คันเดียวกันถูกกันในช่วงเวลาที่ทับกันไม่ได้ (เฉพาะคำขอที่ยังกันของอยู่) ----------
ALTER TABLE booking_items ADD COLUMN during tstzrange;
--> statement-breakpoint
ALTER TABLE booking_items ADD CONSTRAINT booking_items_no_overlap
  EXCLUDE USING gist (asset_id WITH =, during WITH &&) WHERE (asset_id IS NOT NULL AND active);
--> statement-breakpoint
ALTER TABLE booking_items ADD CONSTRAINT booking_items_during_check CHECK (NOT active OR during IS NOT NULL);
--> statement-breakpoint

ALTER TABLE media ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE day_closes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE maintenance_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE booking_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- รูป/เอกสาร: สมาชิกเพิ่มและอ่านรายการได้ · แก้ได้เฉพาะเวลาลบ (ลบตามกำหนด PDPA) · ไม่มีลบแถวจริง
GRANT SELECT, INSERT ON media TO rental_app;
--> statement-breakpoint
GRANT UPDATE (deleted_at, delete_after) ON media TO rental_app;
--> statement-breakpoint
CREATE POLICY member_read ON media FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY member_insert ON media FOR INSERT TO rental_app WITH CHECK (org_id = app.org_id() AND app.is_member() AND created_by = app.user_id());
--> statement-breakpoint
CREATE POLICY member_update ON media FOR UPDATE TO rental_app USING (org_id = app.org_id() AND app.is_member()) WITH CHECK (org_id = app.org_id());
--> statement-breakpoint

-- ปิดยอดสิ้นวัน: ปิดได้ทุกคนในร้าน · ปิดแล้วแก้/ลบไม่ได้
GRANT SELECT, INSERT ON day_closes TO rental_app;
--> statement-breakpoint
CREATE POLICY member_read ON day_closes FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY member_insert ON day_closes FOR INSERT TO rental_app WITH CHECK (org_id = app.org_id() AND app.is_member() AND closed_by = app.user_id());
--> statement-breakpoint
-- ยกเลิกบิลที่จ่ายในวันที่ปิดยอดแล้วไม่ได้ (ยอดของวันนั้นถูกล็อก)
CREATE FUNCTION app.bills_day_lock() RETURNS trigger LANGUAGE plpgsql AS
$$ DECLARE tz text;
BEGIN
  IF NEW.status = 'void' AND OLD.status = 'paid' THEN
    SELECT timezone INTO tz FROM orgs WHERE id = NEW.org_id;
    IF EXISTS (SELECT 1 FROM day_closes d WHERE d.org_id = NEW.org_id AND d.business_date = (OLD.paid_at AT TIME ZONE coalesce(tz, 'Asia/Bangkok'))::date) THEN
      RAISE EXCEPTION 'day_closed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bills_day_lock BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION app.bills_day_lock();
--> statement-breakpoint

-- ซ่อมบำรุง: ทุกคนบันทึกได้ · แก้ได้เฉพาะเจ้าของ/ผู้จัดการ
GRANT SELECT, INSERT, UPDATE ON maintenance_records TO rental_app;
--> statement-breakpoint
CREATE POLICY member_read ON maintenance_records FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY member_insert ON maintenance_records FOR INSERT TO rental_app WITH CHECK (org_id = app.org_id() AND app.is_member() AND created_by = app.user_id());
--> statement-breakpoint
CREATE POLICY admin_update ON maintenance_records FOR UPDATE TO rental_app
  USING (org_id = app.org_id() AND app.org_role() IN ('owner', 'manager')) WITH CHECK (org_id = app.org_id());
--> statement-breakpoint

-- ปรับสต็อก: เจ้าของ/ผู้จัดการเท่านั้น · บันทึกแล้วแก้/ลบไม่ได้
GRANT SELECT, INSERT ON stock_adjustments TO rental_app;
--> statement-breakpoint
CREATE POLICY member_read ON stock_adjustments FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY admin_insert ON stock_adjustments FOR INSERT TO rental_app
  WITH CHECK (org_id = app.org_id() AND app.org_role() IN ('owner', 'manager') AND created_by = app.user_id());
--> statement-breakpoint

-- เทมเพลตข้อความ: ทุกคนอ่าน (กดส่ง) · เจ้าของ/ผู้จัดการแก้
GRANT SELECT, INSERT, UPDATE ON message_templates TO rental_app;
--> statement-breakpoint
CREATE POLICY member_read ON message_templates FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY admin_insert ON message_templates FOR INSERT TO rental_app WITH CHECK (org_id = app.org_id() AND app.org_role() IN ('owner', 'manager'));
--> statement-breakpoint
CREATE POLICY admin_update ON message_templates FOR UPDATE TO rental_app
  USING (org_id = app.org_id() AND app.org_role() IN ('owner', 'manager')) WITH CHECK (org_id = app.org_id());
--> statement-breakpoint

-- คำขอจอง: พนักงานจัดการได้ (ยืนยัน/ปฏิเสธ/กำหนดคัน) · ลูกค้าสร้างผ่านฟังก์ชันสาธารณะ (เพิ่มใน migration ของเฟส 3)
GRANT SELECT, INSERT, UPDATE ON bookings, booking_items TO rental_app;
--> statement-breakpoint
CREATE POLICY member_all ON bookings FOR ALL TO rental_app
  USING (org_id = app.org_id() AND app.is_member()) WITH CHECK (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY member_all ON booking_items FOR ALL TO rental_app
  USING (org_id = app.org_id() AND app.is_member()) WITH CHECK (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint

-- ---------- กันอ้างข้อมูลข้ามร้าน (เพิ่มตารางใหม่) ----------
CREATE OR REPLACE FUNCTION app.same_org_refs() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF TG_TABLE_NAME = 'assets' THEN
    PERFORM app.assert_visible('asset_types', NEW.asset_type_id); PERFORM app.assert_visible('branches', NEW.branch_id);
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
CREATE TRIGGER same_org_refs BEFORE INSERT OR UPDATE ON media FOR EACH ROW EXECUTE FUNCTION app.same_org_refs();
--> statement-breakpoint
CREATE TRIGGER same_org_refs BEFORE INSERT OR UPDATE ON maintenance_records FOR EACH ROW EXECUTE FUNCTION app.same_org_refs();
--> statement-breakpoint
CREATE TRIGGER same_org_refs BEFORE INSERT ON stock_adjustments FOR EACH ROW EXECUTE FUNCTION app.same_org_refs();
--> statement-breakpoint
CREATE TRIGGER same_org_refs BEFORE INSERT OR UPDATE ON booking_items FOR EACH ROW EXECUTE FUNCTION app.same_org_refs();
--> statement-breakpoint
CREATE TRIGGER same_org_refs BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION app.same_org_refs();
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO rental_app;
