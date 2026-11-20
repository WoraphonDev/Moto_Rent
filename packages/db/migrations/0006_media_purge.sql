-- ลบเอกสารลูกค้าที่ครบกำหนด (PDPA) · งานเบื้องหลังทำข้ามทุกร้าน จึงต้องผ่านฟังก์ชันที่คืนเฉพาะสิ่งจำเป็น
-- คืนเฉพาะ id + ที่อยู่ไฟล์ของรายการที่เลยกำหนดแล้ว (ไม่คืนข้อมูลลูกค้า)
CREATE FUNCTION app.media_due_for_purge(max_rows int)
RETURNS TABLE (media_id uuid, org_id uuid, storage_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT m.id, m.org_id, m.storage_key FROM media m
   WHERE m.deleted_at IS NULL AND m.delete_after IS NOT NULL AND m.delete_after <= now()
   ORDER BY m.delete_after LIMIT greatest(1, least(max_rows, 500)) $$;
--> statement-breakpoint
-- บันทึกว่าลบไฟล์แล้ว + เขียนประวัติของร้านนั้น (ผู้ทำ = ระบบ)
CREATE FUNCTION app.mark_media_purged(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ DECLARE o uuid;
BEGIN
  UPDATE media SET deleted_at = now() WHERE id = target AND deleted_at IS NULL AND delete_after <= now() RETURNING org_id INTO o;
  IF o IS NOT NULL THEN
    INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, entity_id) VALUES (o, NULL, 'media.purged', 'media', target::text);
  END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.media_due_for_purge(int), app.mark_media_purged(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.media_due_for_purge(int), app.mark_media_purged(uuid) TO rental_app;
