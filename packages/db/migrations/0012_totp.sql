CREATE TABLE "user_backup_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_totp" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_enc" text NOT NULL,
	"enabled_at" timestamp with time zone,
	"last_step" bigint,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "totp_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_backup_codes" ADD CONSTRAINT "user_backup_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_totp" ADD CONSTRAINT "user_totp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_backup_codes_key" ON "user_backup_codes" USING btree ("user_id","code_hash");--> statement-breakpoint
-- ---------- ยืนยันตัวตน 2 ชั้น (TOTP) ----------
-- ตารางระดับบุคคล: API ไม่มีสิทธิ์ตารางเลย · เปิด RLS ไว้ไม่มี policy (ปิดทุกทางที่ไม่ผ่านฟังก์ชัน)
ALTER TABLE user_totp ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_backup_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON user_totp, user_backup_codes FROM PUBLIC;
--> statement-breakpoint

-- สถานะของผู้ใช้ (ไม่คืนรหัสสำรอง)
CREATE FUNCTION auth.totp_state(uid uuid)
RETURNS TABLE (secret_enc text, enabled boolean, locked boolean, backup_left int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT t.secret_enc, t.enabled_at IS NOT NULL, coalesce(t.locked_until > now(), false),
          (SELECT count(*)::int FROM user_backup_codes b WHERE b.user_id = uid AND b.used_at IS NULL)
   FROM user_totp t WHERE t.user_id = uid $$;
--> statement-breakpoint

-- เริ่มตั้งค่า (เก็บ secret ไว้ก่อน ยังไม่เปิด) · เปิดอยู่แล้วเริ่มใหม่ไม่ได้ (ต้องปิดก่อน)
CREATE FUNCTION auth.totp_begin(uid uuid, secret_in text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ BEGIN
  IF EXISTS (SELECT 1 FROM user_totp WHERE user_id = uid AND enabled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'totp_already_enabled' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO user_totp (user_id, secret_enc) VALUES (uid, secret_in)
  ON CONFLICT (user_id) DO UPDATE SET secret_enc = excluded.secret_enc, last_step = NULL, failed_count = 0, locked_until = NULL;
END $$;
--> statement-breakpoint

-- บันทึกผลการตรวจรหัส 6 หลัก (ตรวจที่ API เพราะกุญแจถอดรหัสอยู่ที่ API)
-- ok: รหัสตรงกับช่วงเวลา step · กันใช้ช่วงเดิมซ้ำ · ผิดครบ max_fail พัก lock_minutes นาที
-- enable_it: ยืนยันรหัสแรกตอนตั้งค่า · sess: ตั้ง session นี้ว่ายืนยันแล้ว (งานสำคัญไม่ถามซ้ำ 15 นาที)
CREATE FUNCTION auth.totp_check(uid uuid, ok boolean, step bigint, enable_it boolean, sess uuid, max_fail int, lock_minutes int)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ DECLARE t user_totp%ROWTYPE;
BEGIN
  SELECT * INTO t FROM user_totp WHERE user_id = uid FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_set'; END IF;
  IF t.enabled_at IS NULL AND NOT enable_it THEN RETURN 'not_set'; END IF;
  IF t.locked_until > now() THEN RETURN 'locked'; END IF;
  IF NOT ok OR (t.last_step IS NOT NULL AND step <= t.last_step) THEN
    IF t.failed_count + 1 >= max_fail THEN
      UPDATE user_totp SET failed_count = 0, locked_until = now() + make_interval(mins => lock_minutes) WHERE user_id = uid;
    ELSE
      UPDATE user_totp SET failed_count = failed_count + 1 WHERE user_id = uid;
    END IF;
    RETURN 'invalid';
  END IF;
  UPDATE user_totp SET last_step = step, failed_count = 0, locked_until = NULL,
         enabled_at = CASE WHEN enable_it THEN coalesce(enabled_at, now()) ELSE enabled_at END
   WHERE user_id = uid;
  IF sess IS NOT NULL THEN
    UPDATE sessions SET totp_verified_at = now() WHERE id = sess AND user_id = uid AND revoked_at IS NULL;
  END IF;
  RETURN 'ok';
END $$;
--> statement-breakpoint

-- ใช้รหัสสำรอง (ครั้งเดียว) แทนรหัส 6 หลัก · นับรวมกับการใส่ผิด
CREATE FUNCTION auth.totp_use_backup(uid uuid, hash_in text, sess uuid, max_fail int, lock_minutes int) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ DECLARE t user_totp%ROWTYPE; used uuid;
BEGIN
  SELECT * INTO t FROM user_totp WHERE user_id = uid AND enabled_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_set'; END IF;
  IF t.locked_until > now() THEN RETURN 'locked'; END IF;
  UPDATE user_backup_codes SET used_at = now() WHERE user_id = uid AND code_hash = hash_in AND used_at IS NULL RETURNING id INTO used;
  IF used IS NULL THEN
    IF t.failed_count + 1 >= max_fail THEN
      UPDATE user_totp SET failed_count = 0, locked_until = now() + make_interval(mins => lock_minutes) WHERE user_id = uid;
    ELSE
      UPDATE user_totp SET failed_count = failed_count + 1 WHERE user_id = uid;
    END IF;
    RETURN 'invalid';
  END IF;
  UPDATE user_totp SET failed_count = 0 WHERE user_id = uid;
  IF sess IS NOT NULL THEN
    UPDATE sessions SET totp_verified_at = now() WHERE id = sess AND user_id = uid AND revoked_at IS NULL;
  END IF;
  RETURN 'ok';
END $$;
--> statement-breakpoint

-- รหัสสำรองชุดใหม่ (ชุดเก่าใช้ไม่ได้ทันที) · เฉพาะผู้ที่เปิดแล้ว
CREATE FUNCTION auth.totp_set_backup(uid uuid, hashes text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM user_totp WHERE user_id = uid AND enabled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'totp_not_enabled' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM user_backup_codes WHERE user_id = uid;
  INSERT INTO user_backup_codes (user_id, code_hash) SELECT uid, h FROM unnest(hashes) AS h;
END $$;
--> statement-breakpoint

CREATE FUNCTION auth.totp_disable(uid uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ DELETE FROM user_backup_codes WHERE user_id = uid; DELETE FROM user_totp WHERE user_id = uid; $$;
--> statement-breakpoint

-- session นี้ยืนยันรหัส 6 หลักภายใน mins นาทีที่ผ่านมา (และผู้ใช้ยังเปิดอยู่)
CREATE FUNCTION auth.totp_recent(sess uuid, uid uuid, mins int) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT EXISTS (
     SELECT 1 FROM sessions s JOIN user_totp t ON t.user_id = s.user_id AND t.enabled_at IS NOT NULL
     WHERE s.id = sess AND s.user_id = uid AND s.revoked_at IS NULL
       AND s.totp_verified_at > now() - make_interval(mins => mins)) $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth.totp_state(uuid), auth.totp_begin(uuid, text), auth.totp_check(uuid, boolean, bigint, boolean, uuid, int, int),
  auth.totp_use_backup(uuid, text, uuid, int, int), auth.totp_set_backup(uuid, text[]), auth.totp_disable(uuid), auth.totp_recent(uuid, uuid, int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.totp_state(uuid), auth.totp_begin(uuid, text), auth.totp_check(uuid, boolean, bigint, boolean, uuid, int, int),
  auth.totp_use_backup(uuid, text, uuid, int, int), auth.totp_set_backup(uuid, text[]), auth.totp_disable(uuid), auth.totp_recent(uuid, uuid, int) TO rental_app;
