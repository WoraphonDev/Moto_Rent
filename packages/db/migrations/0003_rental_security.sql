-- เฟส 1: RLS + กฎที่ฐานข้อมูลบังคับเอง (กันได้แม้โค้ด API ผิด)
-- 1) ทุกตารางกั้นด้วย org_id = app.org_id() และต้องเป็นสมาชิกร้าน
-- 2) อ้างข้อมูลข้ามร้านไม่ได้ (trigger ตรวจว่าแถวที่อ้างถึงมองเห็นได้ใต้ RLS ของร้านนี้)
-- 3) เงิน: รายการบิลและการรับเงินแก้/ลบไม่ได้ · บิลที่จ่ายแล้วกลับไปเปิดไม่ได้ · ยกเลิกบิลได้เฉพาะเจ้าของ
-- 4) ส่วนลดเกินเพดานของพนักงานถูกปฏิเสธที่ฐานข้อมูล

ALTER TABLE asset_types ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE asset_variants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE rentals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE rental_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE bill_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE org_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------- ของให้เช่า: ทุกคนอ่าน · เจ้าของ/ผู้จัดการแก้ ----------
GRANT SELECT, INSERT, UPDATE ON asset_types, assets, asset_variants TO rental_app;
--> statement-breakpoint
CREATE POLICY member_read ON asset_types FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY admin_insert ON asset_types FOR INSERT TO rental_app WITH CHECK (org_id = app.org_id() AND app.org_role() IN ('owner', 'manager'));
--> statement-breakpoint
CREATE POLICY admin_update ON asset_types FOR UPDATE TO rental_app
  USING (org_id = app.org_id() AND app.org_role() IN ('owner', 'manager')) WITH CHECK (org_id = app.org_id());
--> statement-breakpoint
CREATE POLICY member_read ON assets FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY admin_insert ON assets FOR INSERT TO rental_app WITH CHECK (org_id = app.org_id() AND app.org_role() IN ('owner', 'manager'));
--> statement-breakpoint
-- พนักงานแก้ได้เฉพาะเลขไมล์ (ตอนรับคืน) ผ่าน trigger ด้านล่าง · เจ้าของ/ผู้จัดการแก้ได้ทุกช่อง
CREATE POLICY member_update ON assets FOR UPDATE TO rental_app
  USING (org_id = app.org_id() AND app.is_member()) WITH CHECK (org_id = app.org_id());
--> statement-breakpoint
CREATE POLICY member_read ON asset_variants FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY admin_insert ON asset_variants FOR INSERT TO rental_app WITH CHECK (org_id = app.org_id() AND app.org_role() IN ('owner', 'manager'));
--> statement-breakpoint
CREATE POLICY admin_update ON asset_variants FOR UPDATE TO rental_app
  USING (org_id = app.org_id() AND app.org_role() IN ('owner', 'manager')) WITH CHECK (org_id = app.org_id());
--> statement-breakpoint
CREATE FUNCTION app.assets_staff_guard() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF app.org_role() NOT IN ('owner', 'manager') AND
     (NEW.asset_type_id, NEW.code, NEW.status, NEW.price_per_day, NEW.plate, NEW.model, NEW.color, NEW.branch_id)
     IS DISTINCT FROM (OLD.asset_type_id, OLD.code, OLD.status, OLD.price_per_day, OLD.plate, OLD.model, OLD.color, OLD.branch_id) THEN
    RAISE EXCEPTION 'forbidden_field' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER assets_staff_guard BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION app.assets_staff_guard();
--> statement-breakpoint

-- ---------- ลูกค้า: ทุกคนเพิ่ม/แก้ได้ · ธง "ไม่ให้เช่า" เฉพาะเจ้าของ/ผู้จัดการ ----------
GRANT SELECT, INSERT, UPDATE ON customers TO rental_app;
--> statement-breakpoint
CREATE POLICY member_all ON customers FOR ALL TO rental_app
  USING (org_id = app.org_id() AND app.is_member()) WITH CHECK (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE FUNCTION app.customers_flag_guard() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF app.org_role() NOT IN ('owner', 'manager') AND
     (TG_OP = 'INSERT' AND NEW.do_not_rent OR TG_OP = 'UPDATE' AND (NEW.do_not_rent, NEW.do_not_rent_reason) IS DISTINCT FROM (OLD.do_not_rent, OLD.do_not_rent_reason)) THEN
    RAISE EXCEPTION 'forbidden_field' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER customers_flag_guard BEFORE INSERT OR UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION app.customers_flag_guard();
--> statement-breakpoint

-- ---------- สัญญาเช่า ----------
GRANT SELECT, INSERT, UPDATE ON rentals, rental_items TO rental_app;
--> statement-breakpoint
CREATE POLICY member_all ON rentals FOR ALL TO rental_app
  USING (org_id = app.org_id() AND app.is_member()) WITH CHECK (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY member_all ON rental_items FOR ALL TO rental_app
  USING (org_id = app.org_id() AND app.is_member()) WITH CHECK (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
-- ยกเลิกสัญญาได้เฉพาะเจ้าของ · สัญญาที่จบแล้วกลับมา active ไม่ได้
CREATE FUNCTION app.rentals_status_guard() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' AND app.org_role() <> 'owner' THEN
    RAISE EXCEPTION 'owner_only' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'active' AND NEW.status = 'active' THEN
    RAISE EXCEPTION 'rental_closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER rentals_status_guard BEFORE UPDATE ON rentals FOR EACH ROW EXECUTE FUNCTION app.rentals_status_guard();
--> statement-breakpoint

-- ---------- บิล ----------
GRANT SELECT, INSERT, UPDATE ON bills TO rental_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON bill_lines, payments TO rental_app;
--> statement-breakpoint
CREATE POLICY member_all ON bills FOR ALL TO rental_app
  USING (org_id = app.org_id() AND app.is_member()) WITH CHECK (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY member_insert ON bill_lines FOR INSERT TO rental_app
  WITH CHECK (org_id = app.org_id() AND app.is_member() AND created_by = app.user_id());
--> statement-breakpoint
CREATE POLICY member_read ON bill_lines FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY member_insert ON payments FOR INSERT TO rental_app
  WITH CHECK (org_id = app.org_id() AND app.is_member() AND received_by = app.user_id());
--> statement-breakpoint
CREATE POLICY member_read ON payments FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE FUNCTION app.bills_status_guard() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF NEW.status = 'void' AND OLD.status <> 'void' AND app.org_role() <> 'owner' THEN
    RAISE EXCEPTION 'owner_only' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('paid', 'void') AND NEW.status = 'open' THEN
    RAISE EXCEPTION 'bill_closed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'void' AND NEW.status <> 'void' THEN
    RAISE EXCEPTION 'bill_closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bills_status_guard BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION app.bills_status_guard();
--> statement-breakpoint
-- เพิ่มรายการ/รับเงินได้เฉพาะบิลที่เปิดอยู่ · ส่วนลดเกินเพดานของคนนั้นถูกปฏิเสธ (เจ้าของไม่มีเพดาน)
CREATE FUNCTION app.bill_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$ DECLARE st text; cap bigint;
BEGIN
  SELECT status INTO st FROM bills WHERE id = NEW.bill_id;
  IF st IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'bill_closed' USING ERRCODE = '23514'; END IF;
  IF NEW.kind = 'discount' AND app.org_role() <> 'owner' THEN
    cap := app.discount_cap();
    IF -NEW.amount > cap THEN RAISE EXCEPTION 'discount_over_limit' USING ERRCODE = '42501'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.payments_guard() RETURNS trigger LANGUAGE plpgsql AS
$$ DECLARE st text;
BEGIN
  SELECT status INTO st FROM bills WHERE id = NEW.bill_id;
  IF st IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'bill_closed' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- เพดานส่วนลดของผู้ใช้ปัจจุบัน: ค่าเฉพาะคน (memberships.discount_limit) หรือค่าของร้าน
CREATE FUNCTION app.discount_cap() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT coalesce(m.discount_limit, s.staff_discount_cap)
   FROM memberships m JOIN org_settings s ON s.org_id = m.org_id
   WHERE m.org_id = app.org_id() AND m.user_id = app.user_id() AND m.status = 'active' $$;
--> statement-breakpoint
CREATE TRIGGER bill_lines_guard BEFORE INSERT ON bill_lines FOR EACH ROW EXECUTE FUNCTION app.bill_lines_guard();
--> statement-breakpoint
CREATE TRIGGER payments_guard BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION app.payments_guard();
--> statement-breakpoint

-- ---------- เลขเอกสาร ----------
CREATE FUNCTION app.next_counter(counter_name text) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ DECLARE v bigint;
BEGIN
  IF NOT app.is_member() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  INSERT INTO org_counters (org_id, name, value) VALUES (app.org_id(), counter_name, 1)
  ON CONFLICT (org_id, name) DO UPDATE SET value = org_counters.value + 1
  RETURNING value INTO v;
  RETURN v;
END $$;
--> statement-breakpoint

-- ---------- กันอ้างข้อมูลข้ามร้าน ----------
-- ตรวจด้วยการมองหาแถวที่อ้างถึงภายใต้ RLS ของผู้ใช้ปัจจุบัน: แถวของร้านอื่นมองไม่เห็น จึงถือว่าไม่มี
CREATE FUNCTION app.assert_visible(tbl regclass, ref uuid) RETURNS void LANGUAGE plpgsql AS
$$ DECLARE found boolean;
BEGIN
  IF ref IS NULL THEN RETURN; END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE id = $1 AND org_id = app.org_id())', tbl) INTO found USING ref;
  IF NOT found THEN RAISE EXCEPTION 'cross_org_reference: %', tbl USING ERRCODE = '23503'; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.same_org_refs() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF TG_TABLE_NAME = 'assets' THEN
    PERFORM app.assert_visible('asset_types', NEW.asset_type_id); PERFORM app.assert_visible('branches', NEW.branch_id);
  ELSIF TG_TABLE_NAME = 'asset_variants' THEN
    PERFORM app.assert_visible('asset_types', NEW.asset_type_id);
  ELSIF TG_TABLE_NAME = 'rentals' THEN
    PERFORM app.assert_visible('customers', NEW.customer_id); PERFORM app.assert_visible('branches', NEW.branch_id);
  ELSIF TG_TABLE_NAME = 'rental_items' THEN
    PERFORM app.assert_visible('rentals', NEW.rental_id); PERFORM app.assert_visible('asset_types', NEW.asset_type_id);
    PERFORM app.assert_visible('assets', NEW.asset_id); PERFORM app.assert_visible('asset_variants', NEW.variant_id);
  ELSIF TG_TABLE_NAME = 'bills' THEN
    PERFORM app.assert_visible('customers', NEW.customer_id);
  ELSIF TG_TABLE_NAME = 'bill_lines' THEN
    PERFORM app.assert_visible('bills', NEW.bill_id); PERFORM app.assert_visible('rentals', NEW.rental_id);
  ELSIF TG_TABLE_NAME = 'payments' THEN
    PERFORM app.assert_visible('bills', NEW.bill_id);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER same_org_refs BEFORE INSERT OR UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION app.same_org_refs();
--> statement-breakpoint
CREATE TRIGGER same_org_refs BEFORE INSERT OR UPDATE ON asset_variants FOR EACH ROW EXECUTE FUNCTION app.same_org_refs();
--> statement-breakpoint
CREATE TRIGGER same_org_refs BEFORE INSERT OR UPDATE ON rentals FOR EACH ROW EXECUTE FUNCTION app.same_org_refs();
--> statement-breakpoint
CREATE TRIGGER same_org_refs BEFORE INSERT OR UPDATE ON rental_items FOR EACH ROW EXECUTE FUNCTION app.same_org_refs();
--> statement-breakpoint
CREATE TRIGGER same_org_refs BEFORE INSERT OR UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION app.same_org_refs();
--> statement-breakpoint
CREATE TRIGGER same_org_refs BEFORE INSERT ON bill_lines FOR EACH ROW EXECUTE FUNCTION app.same_org_refs();
--> statement-breakpoint
CREATE TRIGGER same_org_refs BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION app.same_org_refs();
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO rental_app;
