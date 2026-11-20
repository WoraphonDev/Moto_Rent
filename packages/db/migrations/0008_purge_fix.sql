-- แก้ app.mark_media_purged: trigger same_org_refs ของ media ต้องรู้ app.org_id
-- งานลบเอกสารไม่มี session ของร้าน จึงตั้ง org ของแถวนั้นชั่วคราวในธุรกรรม แล้วคืนค่าเดิม
CREATE OR REPLACE FUNCTION app.mark_media_purged(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ DECLARE o uuid; prev text;
BEGIN
  SELECT org_id INTO o FROM media WHERE id = target AND deleted_at IS NULL AND delete_after <= now();
  IF o IS NULL THEN RETURN; END IF;
  prev := current_setting('app.org_id', true);
  PERFORM set_config('app.org_id', o::text, true);
  UPDATE media SET deleted_at = now() WHERE id = target;
  INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, entity_id) VALUES (o, NULL, 'media.purged', 'media', target::text);
  PERFORM set_config('app.org_id', coalesce(prev, ''), true);
END $$;
