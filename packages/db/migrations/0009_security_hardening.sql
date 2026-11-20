-- แก้จากการตรวจความปลอดภัย (OWASP) 2026-11-21

-- ---------- ตัวตน: ชื่อผู้ใช้กับเบอร์โทรต้องไม่ชนกัน ----------
-- ชื่อผู้ใช้ต้องมีตัวอักษรอย่างน้อย 1 ตัว (เบอร์โทรเป็นตัวเลขล้วน) · หาเจอทั้งสองแบบต้องได้ชื่อผู้ใช้ก่อนเสมอ
ALTER TABLE users ADD CONSTRAINT users_username_has_letter CHECK (username ~ '[A-Za-z]');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth.find_login(identifier text)
RETURNS TABLE (user_id uuid, password_hash text, locked_until timestamptz, disabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT u.id, u.password_hash, u.locked_until, u.disabled_at IS NOT NULL
   FROM users u
   WHERE lower(u.username) = lower(identifier) OR (u.phone IS NOT NULL AND u.phone = identifier)
   ORDER BY (lower(u.username) = lower(identifier)) DESC
   LIMIT 1 $$;
--> statement-breakpoint
-- รหัสผ่านของผู้ใช้จาก id (ยืนยันรหัสพนักงานซ้ำ) · ไม่ต้องหาจากชื่อผู้ใช้ที่อาจชนกับเบอร์
CREATE FUNCTION auth.password_hash_of(uid uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT password_hash FROM users WHERE id = uid AND disabled_at IS NULL $$;
--> statement-breakpoint

-- ---------- ลิงก์เชิญ/ตั้งรหัสใหม่: จำกัดว่าตั้งรหัสใหม่ได้เฉพาะสมาชิกของร้านนี้เท่านั้น ----------
DROP POLICY owner_insert ON invitations;
--> statement-breakpoint
CREATE POLICY owner_insert ON invitations FOR INSERT TO rental_app
  WITH CHECK (
    org_id = app.org_id() AND app.org_role() = 'owner' AND invited_by = app.user_id() AND accepted_at IS NULL
    AND role <> 'owner'
    AND ((kind = 'invite' AND user_id IS NULL)
      OR (kind = 'reset' AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = invitations.org_id AND m.user_id = invitations.user_id AND m.status = 'active')))
  );
--> statement-breakpoint
-- แก้ได้เฉพาะยกเลิกลิงก์
REVOKE UPDATE ON invitations FROM rental_app;
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON invitations TO rental_app;
--> statement-breakpoint
-- รับคำเชิญ: ลิงก์ตั้งรหัสใหม่ใช้ได้เฉพาะคนที่ยังเป็นสมาชิกร้านนั้น และไม่ได้อยู่ร้านอื่น
-- (รหัสผ่านเป็นของผู้ใช้ทั้งระบบ · เจ้าของร้านหนึ่งต้องตั้งรหัสให้คนที่มีสิทธิ์ในร้านอื่นไม่ได้)
CREATE OR REPLACE FUNCTION auth.accept_invitation(token_hash_in text, password_hash_in text)
RETURNS TABLE (user_id uuid, org_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
#variable_conflict use_column
DECLARE inv invitations%ROWTYPE; uid uuid;
BEGIN
  SELECT * INTO inv FROM invitations i
  WHERE i.token_hash = token_hash_in AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation_invalid' USING ERRCODE = 'P0002'; END IF;

  IF inv.kind = 'reset' THEN
    IF NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = inv.org_id AND m.user_id = inv.user_id AND m.status = 'active' AND m.role <> 'owner')
       OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = inv.user_id AND m.org_id <> inv.org_id AND m.status = 'active') THEN
      RAISE EXCEPTION 'invitation_invalid' USING ERRCODE = 'P0002';
    END IF;
    UPDATE users u SET password_hash = password_hash_in, password_changed_at = now(), failed_logins = 0, locked_until = NULL
    WHERE u.id = inv.user_id RETURNING u.id INTO uid;
    UPDATE sessions s SET revoked_at = now() WHERE s.user_id = uid AND s.revoked_at IS NULL;
  ELSE
    INSERT INTO users (username, display_name, phone, password_hash, password_changed_at)
    VALUES (inv.username, inv.display_name, inv.phone, password_hash_in, now())
    RETURNING id INTO uid;
    INSERT INTO memberships (org_id, user_id, role) VALUES (inv.org_id, uid, inv.role);
  END IF;

  UPDATE invitations SET accepted_at = now(), user_id = uid WHERE id = inv.id;
  INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, entity_id)
  VALUES (inv.org_id, uid, CASE WHEN inv.kind = 'reset' THEN 'auth.password_reset' ELSE 'auth.invitation_accepted' END, 'user', uid::text);
  RETURN QUERY SELECT uid, inv.org_id;
END $$;
--> statement-breakpoint
-- API ไม่ได้สร้างสมาชิกเอง (สร้างผ่าน accept_invitation / create_org เท่านั้น)
REVOKE INSERT ON memberships FROM rental_app;
--> statement-breakpoint
DROP POLICY owner_insert ON memberships;
--> statement-breakpoint

-- ---------- session ----------
-- โหมดลูกค้า: เครื่องที่ยื่นให้ลูกค้าเซ็นใช้ได้เฉพาะสัญญาเดียว จนพนักงานใส่รหัสผ่านปลดล็อก
ALTER TABLE sessions ADD COLUMN customer_mode_rental_id uuid REFERENCES rentals(id);
--> statement-breakpoint
-- แก้ได้เฉพาะเวลาเพิกถอนและโหมดลูกค้า (เดิมแก้ได้ทุกคอลัมน์ รวม user_id/token_hash)
REVOKE UPDATE ON sessions FROM rental_app;
--> statement-breakpoint
GRANT UPDATE (revoked_at, customer_mode_rental_id) ON sessions TO rental_app;
--> statement-breakpoint
DROP FUNCTION auth.session_lookup(text, int);
--> statement-breakpoint
-- เพิ่ม: ร้านต้อง active · เครื่องต้องเป็นของร้านเดียวกัน · คืนโหมดลูกค้า
CREATE FUNCTION auth.session_lookup(token_hash_in text, idle_minutes int)
RETURNS TABLE (session_id uuid, user_id uuid, org_id uuid, device_id uuid, role text, customer_mode_rental_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ UPDATE sessions s SET last_seen_at = now()
   FROM memberships m, users u, orgs o
   WHERE s.token_hash = token_hash_in
     AND s.revoked_at IS NULL AND s.expires_at > now()
     AND s.last_seen_at > now() - make_interval(mins => idle_minutes)
     AND m.org_id = s.org_id AND m.user_id = s.user_id AND m.status = 'active'
     AND u.id = s.user_id AND u.disabled_at IS NULL
     AND o.id = s.org_id AND o.status = 'active'
     AND (s.device_id IS NULL OR EXISTS (SELECT 1 FROM devices d WHERE d.id = s.device_id AND d.org_id = s.org_id AND d.status = 'approved'))
   RETURNING s.id, s.user_id, s.org_id, s.device_id, m.role, s.customer_mode_rental_id $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth.session_lookup(text, int), auth.password_hash_of(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.session_lookup(text, int), auth.password_hash_of(uuid) TO rental_app;
--> statement-breakpoint

-- ---------- เงิน ----------
-- ส่วนลดรวมทั้งบิลของคนที่ไม่ใช่เจ้าของต้องไม่เกินเพดาน (เดิมตรวจทีละรายการ ลดหลายครั้งรวมเกินได้)
-- ล็อกแถวบิลก่อนรวม กันสองเครื่องเพิ่มส่วนลดพร้อมกัน
CREATE OR REPLACE FUNCTION app.bill_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$ DECLARE st text; cap bigint; given bigint;
BEGIN
  SELECT status INTO st FROM bills WHERE id = NEW.bill_id FOR UPDATE;
  IF st IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'bill_closed' USING ERRCODE = '23514'; END IF;
  IF NEW.kind = 'discount' AND app.org_role() <> 'owner' THEN
    cap := app.discount_cap();
    SELECT coalesce(-sum(l.amount), 0) INTO given FROM bill_lines l
      JOIN memberships m ON m.user_id = l.created_by AND m.org_id = l.org_id
      WHERE l.bill_id = NEW.bill_id AND l.kind = 'discount' AND m.role <> 'owner';
    IF given - NEW.amount > cap THEN RAISE EXCEPTION 'discount_over_limit' USING ERRCODE = '42501'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- วันที่ปิดยอดแล้ว: รับเงินเพิ่มในวันนั้นไม่ได้ และยกเลิกบิลที่มีเงินรับในวันนั้นไม่ได้
CREATE FUNCTION app.business_date(org uuid, at timestamptz) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT (at AT TIME ZONE coalesce((SELECT timezone FROM orgs WHERE id = org), 'Asia/Bangkok'))::date $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payments_guard() RETURNS trigger LANGUAGE plpgsql AS
$$ DECLARE st text;
BEGIN
  SELECT status INTO st FROM bills WHERE id = NEW.bill_id;
  IF st IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'bill_closed' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM day_closes d WHERE d.org_id = NEW.org_id AND d.business_date = app.business_date(NEW.org_id, now())) THEN
    RAISE EXCEPTION 'day_closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.bills_day_lock() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF NEW.status = 'void' AND OLD.status <> 'void' THEN
    IF EXISTS (SELECT 1 FROM payments p JOIN day_closes d ON d.org_id = p.org_id AND d.business_date = app.business_date(p.org_id, p.created_at)
               WHERE p.bill_id = NEW.id) THEN
      RAISE EXCEPTION 'day_closed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- ---------- อ้างข้อมูลข้ามร้าน: ครอบคลุมตอนสร้างคำขอจองและสาขาของการปิดยอด ----------
DROP TRIGGER same_org_refs ON bookings;
--> statement-breakpoint
CREATE TRIGGER same_org_refs BEFORE INSERT OR UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION app.same_org_refs();
--> statement-breakpoint
CREATE FUNCTION app.day_close_refs() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN PERFORM app.assert_visible('branches', NEW.branch_id); RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER same_org_refs BEFORE INSERT ON day_closes FOR EACH ROW EXECUTE FUNCTION app.day_close_refs();
--> statement-breakpoint

-- ---------- หน้าจองสาธารณะ: เจ้าของต้องเปิดเอง (ร้านใหม่ปิดไว้ก่อน) ----------
ALTER TABLE org_settings ADD COLUMN public_booking_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- ร้านที่มีอยู่แล้ว (ร้านต้นแบบ) เปิดไว้ตามเดิม
UPDATE org_settings SET public_booking_enabled = true;
--> statement-breakpoint
CREATE FUNCTION pub.booking_enabled(slug_in text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT coalesce((SELECT s.public_booking_enabled FROM orgs o JOIN org_settings s ON s.org_id = o.id
                    WHERE lower(o.slug) = lower(slug_in) AND o.status = 'active'), false) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pub.booking_enabled(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pub.booking_enabled(text) TO rental_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.business_date(uuid, timestamptz) TO rental_app;
