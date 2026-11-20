-- ความปลอดภัยชั้นฐานข้อมูล
-- 1) API ใช้ role rental_app ที่อยู่ใต้ RLS เสมอ · ไม่ใช่เจ้าของตาราง จึงข้าม RLS ไม่ได้
-- 2) ข้อมูลร้านกั้นด้วย app.org_id ที่ API ตั้งต่อธุรกรรม (set_config แบบ local)
-- 3) งานก่อนรู้ตัวตน (เข้าระบบ, เปิดลิงก์เชิญ, ตรวจ session) ผ่านฟังก์ชัน SECURITY DEFINER ใน schema auth ที่คืนเฉพาะสิ่งที่จำเป็น
-- 4) ประวัติการใช้งานเพิ่มได้อย่างเดียว

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rental_app') THEN
    CREATE ROLE rental_app NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS auth;
--> statement-breakpoint
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, app, auth TO rental_app;
--> statement-breakpoint

-- ---------- context ----------
CREATE FUNCTION app.user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app.org_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
-- บทบาทของผู้ใช้ปัจจุบันในร้านปัจจุบัน · definer เพื่อไม่ให้ policy ของ memberships วนเรียกตัวเอง
CREATE FUNCTION app.org_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT m.role FROM public.memberships m
   WHERE m.org_id = app.org_id() AND m.user_id = app.user_id() AND m.status = 'active' $$;
--> statement-breakpoint
CREATE FUNCTION app.is_member() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app.org_role() IS NOT NULL $$;
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO rental_app;
--> statement-breakpoint

-- ---------- RLS ----------
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE org_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- orgs: เห็นร้านที่ตัวเองเป็นสมาชิก · แก้ได้เฉพาะเจ้าของ · สร้างผ่าน auth.create_org เท่านั้น
GRANT SELECT, UPDATE ON orgs TO rental_app;
--> statement-breakpoint
CREATE POLICY member_read ON orgs FOR SELECT TO rental_app
  USING (id IN (SELECT org_id FROM memberships WHERE user_id = app.user_id() AND status = 'active'));
--> statement-breakpoint
CREATE POLICY owner_update ON orgs FOR UPDATE TO rental_app
  USING (id = app.org_id() AND app.org_role() = 'owner') WITH CHECK (id = app.org_id());
--> statement-breakpoint

GRANT SELECT, UPDATE ON org_settings TO rental_app;
--> statement-breakpoint
CREATE POLICY member_read ON org_settings FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY owner_update ON org_settings FOR UPDATE TO rental_app
  USING (org_id = app.org_id() AND app.org_role() = 'owner') WITH CHECK (org_id = app.org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON branches TO rental_app;
--> statement-breakpoint
CREATE POLICY member_read ON branches FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY admin_write ON branches FOR INSERT TO rental_app
  WITH CHECK (org_id = app.org_id() AND app.org_role() IN ('owner', 'manager'));
--> statement-breakpoint
CREATE POLICY admin_update ON branches FOR UPDATE TO rental_app
  USING (org_id = app.org_id() AND app.org_role() IN ('owner', 'manager')) WITH CHECK (org_id = app.org_id());
--> statement-breakpoint

-- users: เห็นตัวเองและเพื่อนร่วมร้านปัจจุบัน · ไม่ให้อ่าน password_hash ผ่านสิทธิ์คอลัมน์
GRANT SELECT (id, username, display_name, phone, email, created_at, disabled_at) ON users TO rental_app;
--> statement-breakpoint
GRANT UPDATE (display_name, phone, email) ON users TO rental_app;
--> statement-breakpoint
CREATE POLICY self_or_colleague ON users FOR SELECT TO rental_app
  USING (id = app.user_id() OR (app.is_member() AND id IN (SELECT user_id FROM memberships WHERE org_id = app.org_id())));
--> statement-breakpoint
CREATE POLICY self_update ON users FOR UPDATE TO rental_app USING (id = app.user_id()) WITH CHECK (id = app.user_id());
--> statement-breakpoint

-- memberships: เห็นของร้านปัจจุบัน + ของตัวเองทุกร้าน (ไว้เลือกร้านตอนเข้าระบบ) · จัดการได้เฉพาะเจ้าของ
GRANT SELECT, INSERT, UPDATE ON memberships TO rental_app;
--> statement-breakpoint
CREATE POLICY read_own_or_org ON memberships FOR SELECT TO rental_app
  USING (user_id = app.user_id() OR (org_id = app.org_id() AND app.is_member()));
--> statement-breakpoint
CREATE POLICY owner_insert ON memberships FOR INSERT TO rental_app
  WITH CHECK (org_id = app.org_id() AND app.org_role() = 'owner');
--> statement-breakpoint
-- เจ้าของปิดบัญชีตัวเองไม่ได้ กันร้านไม่เหลือเจ้าของ
CREATE POLICY owner_update ON memberships FOR UPDATE TO rental_app
  USING (org_id = app.org_id() AND app.org_role() = 'owner')
  WITH CHECK (org_id = app.org_id() AND NOT (user_id = app.user_id() AND (status <> 'active' OR role <> 'owner')));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON invitations TO rental_app;
--> statement-breakpoint
CREATE POLICY owner_read ON invitations FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.org_role() = 'owner');
--> statement-breakpoint
CREATE POLICY owner_insert ON invitations FOR INSERT TO rental_app
  WITH CHECK (org_id = app.org_id() AND app.org_role() = 'owner' AND invited_by = app.user_id() AND accepted_at IS NULL);
--> statement-breakpoint
CREATE POLICY owner_update ON invitations FOR UPDATE TO rental_app
  USING (org_id = app.org_id() AND app.org_role() = 'owner') WITH CHECK (org_id = app.org_id() AND accepted_at IS NULL);
--> statement-breakpoint

-- devices: สมาชิกขอเพิ่มเครื่องได้ (สถานะ pending เท่านั้น) · อนุมัติ/ตัดสิทธิ์ได้เฉพาะเจ้าของ
GRANT SELECT, INSERT, UPDATE ON devices TO rental_app;
--> statement-breakpoint
CREATE POLICY member_read ON devices FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY member_request ON devices FOR INSERT TO rental_app
  WITH CHECK (org_id = app.org_id() AND app.is_member() AND requested_by = app.user_id() AND status = 'pending' AND approved_by IS NULL);
--> statement-breakpoint
CREATE POLICY owner_update ON devices FOR UPDATE TO rental_app
  USING (org_id = app.org_id() AND app.org_role() = 'owner') WITH CHECK (org_id = app.org_id());
--> statement-breakpoint

-- sessions: เจ้าของ session จัดการของตัวเอง · เจ้าของร้านเพิกถอน session ของคนในร้านได้
GRANT SELECT, INSERT, UPDATE ON sessions TO rental_app;
--> statement-breakpoint
CREATE POLICY own_session ON sessions FOR ALL TO rental_app
  USING (user_id = app.user_id()) WITH CHECK (user_id = app.user_id() AND org_id = app.org_id() AND app.is_member());
--> statement-breakpoint
CREATE POLICY owner_read ON sessions FOR SELECT TO rental_app USING (org_id = app.org_id() AND app.org_role() = 'owner');
--> statement-breakpoint
CREATE POLICY owner_revoke ON sessions FOR UPDATE TO rental_app
  USING (org_id = app.org_id() AND app.org_role() = 'owner') WITH CHECK (org_id = app.org_id());
--> statement-breakpoint

-- audit_log: สมาชิกเขียนในนามตัวเอง · อ่านได้เฉพาะเจ้าของ/ผู้จัดการ · ไม่มีสิทธิ์แก้หรือลบ
GRANT SELECT, INSERT ON audit_log TO rental_app;
--> statement-breakpoint
CREATE POLICY member_insert ON audit_log FOR INSERT TO rental_app
  WITH CHECK (org_id = app.org_id() AND app.is_member() AND actor_user_id = app.user_id());
--> statement-breakpoint
CREATE POLICY admin_read ON audit_log FOR SELECT TO rental_app
  USING (org_id = app.org_id() AND app.org_role() IN ('owner', 'manager'));
--> statement-breakpoint
CREATE FUNCTION app.audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION app.audit_log_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION app.audit_log_immutable();
--> statement-breakpoint

-- outbox: API เขียนอย่างเดียว · worker อ่านด้วย role ของตัวเอง (เพิ่มเมื่อมี worker)
GRANT INSERT ON outbox_events TO rental_app;
--> statement-breakpoint
CREATE POLICY member_insert ON outbox_events FOR INSERT TO rental_app WITH CHECK (org_id = app.org_id() AND app.is_member());
--> statement-breakpoint

-- ---------- auth: งานก่อนรู้ตัวตน ----------
-- หาผู้ใช้จากชื่อผู้ใช้หรือเบอร์ · คืน hash ให้ API ตรวจรหัสเอง (ไม่ตรวจในฐานข้อมูลเพื่อใช้ argon2)
CREATE FUNCTION auth.find_login(identifier text)
RETURNS TABLE (user_id uuid, password_hash text, locked_until timestamptz, disabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT u.id, u.password_hash, u.locked_until, u.disabled_at IS NOT NULL
   FROM users u
   WHERE lower(u.username) = lower(identifier) OR (u.phone IS NOT NULL AND u.phone = identifier)
   LIMIT 1 $$;
--> statement-breakpoint
-- นับครั้งที่ผิด · ครบ max_attempts ล็อก lock_minutes นาที แล้วเริ่มนับใหม่ · คืนเวลาที่ล็อกถึง (null = ยังไม่ล็อก)
CREATE FUNCTION auth.record_login_failure(uid uuid, max_attempts int, lock_minutes int)
RETURNS TABLE (out_failed_logins int, out_locked_until timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  UPDATE users u SET
    failed_logins = CASE WHEN u.failed_logins + 1 >= max_attempts THEN 0 ELSE u.failed_logins + 1 END,
    locked_until = CASE WHEN u.failed_logins + 1 >= max_attempts THEN now() + make_interval(mins => lock_minutes) ELSE u.locked_until END
  WHERE u.id = uid
  RETURNING CASE WHEN u.failed_logins = 0 THEN max_attempts ELSE u.failed_logins END, u.locked_until;
END $$;
--> statement-breakpoint
CREATE FUNCTION auth.record_login_success(uid uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = uid $$;
--> statement-breakpoint
-- ตรวจ session จาก hash ของ token · ต้องยังไม่หมดอายุ ผู้ใช้ไม่ถูกปิด สมาชิกภาพยัง active และเครื่องยังได้รับอนุมัติ
CREATE FUNCTION auth.session_lookup(token_hash_in text, idle_minutes int)
RETURNS TABLE (session_id uuid, user_id uuid, org_id uuid, device_id uuid, role text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ UPDATE sessions s SET last_seen_at = now()
   FROM memberships m, users u
   WHERE s.token_hash = token_hash_in
     AND s.revoked_at IS NULL AND s.expires_at > now()
     AND s.last_seen_at > now() - make_interval(mins => idle_minutes)
     AND m.org_id = s.org_id AND m.user_id = s.user_id AND m.status = 'active'
     AND u.id = s.user_id AND u.disabled_at IS NULL
     AND (s.device_id IS NULL OR EXISTS (SELECT 1 FROM devices d WHERE d.id = s.device_id AND d.status = 'approved'))
   RETURNING s.id, s.user_id, s.org_id, s.device_id, m.role $$;
--> statement-breakpoint
-- เปิดลิงก์เชิญ/ลิงก์ตั้งรหัสใหม่ · คืนเฉพาะข้อมูลที่หน้าตั้งรหัสต้องแสดง
CREATE FUNCTION auth.invitation_lookup(token_hash_in text)
RETURNS TABLE (invitation_id uuid, kind text, org_name text, username text, display_name text, role text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT i.id, i.kind, o.name, i.username, i.display_name, i.role, i.expires_at
   FROM invitations i JOIN orgs o ON o.id = i.org_id
   WHERE i.token_hash = token_hash_in AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
     AND o.status = 'active' $$;
--> statement-breakpoint
-- รับคำเชิญ: สร้างผู้ใช้ (หรือเปลี่ยนรหัสกรณี reset) + สมาชิกภาพ ในธุรกรรมเดียว · ใช้ได้ครั้งเดียว
CREATE FUNCTION auth.accept_invitation(token_hash_in text, password_hash_in text)
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
    UPDATE users u SET password_hash = password_hash_in, password_changed_at = now(), failed_logins = 0, locked_until = NULL
    WHERE u.id = inv.user_id RETURNING u.id INTO uid;
    -- ตั้งรหัสใหม่แล้วออกจากระบบทุกเครื่อง
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
-- สมัครร้านใหม่ (SaaS onboarding): ร้าน + ค่าตั้งต้น + สาขาแรก + เจ้าของ ในธุรกรรมเดียว
CREATE FUNCTION auth.create_org(
  slug_in text, name_in text, owner_username text, owner_display_name text, owner_phone text, password_hash_in text
) RETURNS TABLE (user_id uuid, org_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
#variable_conflict use_column
DECLARE oid uuid; uid uuid;
BEGIN
  INSERT INTO orgs (slug, name) VALUES (lower(slug_in), name_in) RETURNING id INTO oid;
  INSERT INTO org_settings (org_id) VALUES (oid);
  INSERT INTO branches (org_id, name) VALUES (oid, name_in);
  INSERT INTO users (username, display_name, phone, password_hash, password_changed_at)
  VALUES (owner_username, owner_display_name, owner_phone, password_hash_in, now()) RETURNING id INTO uid;
  INSERT INTO memberships (org_id, user_id, role) VALUES (oid, uid, 'owner');
  INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, entity_id) VALUES (oid, uid, 'org.created', 'org', oid::text);
  RETURN QUERY SELECT uid, oid;
END $$;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO rental_app;
