-- เฟส 3: หน้าจองสาธารณะ (ลูกค้าไม่มีบัญชี ไม่มี session)
-- ทุกอย่างผ่านฟังก์ชัน SECURITY DEFINER ใน schema pub ที่คืนเฉพาะสิ่งที่หน้าจองต้องใช้
-- ไม่คืนข้อมูลลูกค้าคนอื่น ไม่คืนรหัสรถ/ทะเบียน · ร้านต้องเป็น active
-- ความว่างคิดแบบระวังไว้ก่อน (conservative): รวมยอดที่ถูกกันทุกช่วงที่ทับกัน ไม่หักลบการคืนก่อนรับ
-- สัญญาที่ยังไม่คืนถือว่ากันของไว้ถึง greatest(due_at, now()) เพราะรถยังไม่กลับร้าน

CREATE SCHEMA IF NOT EXISTS pub;
--> statement-breakpoint
REVOKE ALL ON SCHEMA pub FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA pub TO rental_app;
--> statement-breakpoint

-- ยกเลิกเองได้ก่อนเวลารับรถอย่างน้อยเท่านี้
CREATE FUNCTION pub.cancel_window() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '2 hours' $$;
--> statement-breakpoint

CREATE FUNCTION pub.org_of(slug_in text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT o.id FROM orgs o WHERE lower(o.slug) = lower(slug_in) AND o.status = 'active' $$;
--> statement-breakpoint

-- ข้อมูลร้าน + ประเภทที่จองได้
CREATE FUNCTION pub.shop(slug_in text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT jsonb_build_object(
     'orgId', o.id, 'name', o.name, 'slug', o.slug, 'timezone', o.timezone, 'currency', o.currency,
     'maxRentalDays', s.max_rental_days,
     'types', coalesce((
       SELECT jsonb_agg(jsonb_build_object(
         'id', t.id, 'name', t.name, 'tracking', t.tracking, 'pricePerDay', t.price_per_day, 'deposit', t.deposit,
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

-- จำนวนที่ว่างตลอดช่วง [from_at, to_at) ต่อประเภท/ไซส์ (ภายใน: ใช้ทั้งหน้าจองและตอนสร้างคำขอ)
CREATE FUNCTION pub.availability_for(org uuid, from_at timestamptz, to_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ WITH span AS (SELECT tstzrange(from_at, to_at) AS r),
   held_rentals AS (
     SELECT ri.asset_id, ri.variant_id, ri.asset_type_id, ri.quantity
     FROM rental_items ri JOIN rentals rt ON rt.id = ri.rental_id, span
     WHERE ri.org_id = org AND ri.released_at IS NULL
       AND tstzrange(rt.start_at, greatest(rt.due_at, now())) && span.r
   ),
   held_bookings AS (
     SELECT bi.asset_id, bi.variant_id, bi.asset_type_id, bi.quantity
     FROM booking_items bi, span
     WHERE bi.org_id = org AND bi.active AND bi.during && span.r
   ),
   units AS (
     SELECT t.id AS type_id,
       (SELECT count(*) FROM assets a WHERE a.asset_type_id = t.id AND a.status = 'available') AS total,
       (SELECT count(*) FROM assets a WHERE a.asset_type_id = t.id AND a.status = 'available'
          AND (a.id IN (SELECT asset_id FROM held_rentals WHERE asset_id IS NOT NULL)
               OR a.id IN (SELECT asset_id FROM held_bookings WHERE asset_id IS NOT NULL))) AS busy,
       (SELECT coalesce(sum(quantity), 0) FROM held_bookings hb WHERE hb.asset_type_id = t.id AND hb.asset_id IS NULL AND hb.variant_id IS NULL) AS unassigned
     FROM asset_types t WHERE t.org_id = org AND t.archived_at IS NULL AND t.tracking = 'unit'
   ),
   variants AS (
     SELECT v.id, v.asset_type_id, v.label,
       greatest(0, v.quantity
         - (SELECT coalesce(sum(quantity), 0) FROM held_rentals h WHERE h.variant_id = v.id)
         - (SELECT coalesce(sum(quantity), 0) FROM held_bookings h WHERE h.variant_id = v.id)) AS available
     FROM asset_variants v JOIN asset_types t ON t.id = v.asset_type_id
     WHERE v.org_id = org AND t.archived_at IS NULL AND t.tracking = 'quantity'
   )
   SELECT jsonb_build_object(
     'from', from_at, 'to', to_at,
     'types', coalesce((SELECT jsonb_agg(jsonb_build_object('id', u.type_id, 'tracking', 'unit', 'available', greatest(0, u.total - u.busy - u.unassigned))) FROM units u), '[]'::jsonb)
           || coalesce((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'tracking', 'quantity',
                  'available', (SELECT coalesce(sum(available), 0) FROM variants v WHERE v.asset_type_id = t.id),
                  'variants', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'label', v.label, 'available', v.available)), '[]'::jsonb) FROM variants v WHERE v.asset_type_id = t.id)))
                FROM asset_types t WHERE t.org_id = org AND t.archived_at IS NULL AND t.tracking = 'quantity'), '[]'::jsonb)) $$;
--> statement-breakpoint

CREATE FUNCTION pub.availability(slug_in text, from_at timestamptz, to_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ DECLARE o uuid;
BEGIN
  o := pub.org_of(slug_in);
  IF o IS NULL THEN RETURN NULL; END IF;
  IF to_at <= from_at OR to_at - from_at > interval '61 days' THEN RAISE EXCEPTION 'invalid_range' USING ERRCODE = '22023'; END IF;
  RETURN pub.availability_for(o, from_at, to_at);
END $$;
--> statement-breakpoint

-- สร้างคำขอจอง (สถานะ requested · ยังไม่กันของ จนกว่าร้านยืนยัน)
CREATE FUNCTION pub.create_booking(slug_in text, payload jsonb, token_hash_in text, ip_in text)
RETURNS TABLE (booking_id uuid, booking_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
#variable_conflict use_column
DECLARE
  o uuid; max_days int; d int; pickup timestamptz; avail jsonb; it jsonb; t record; v record; bid uuid; c text;
  prefix text; parts text[]; alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; tries int := 0;
  wanted jsonb := '{}'::jsonb; key text; have int; prev_org text;
BEGIN
  SELECT og.id, s.max_rental_days INTO o, max_days FROM orgs og JOIN org_settings s ON s.org_id = og.id
  WHERE lower(og.slug) = lower(slug_in) AND og.status = 'active';
  IF o IS NULL THEN RAISE EXCEPTION 'shop_not_found' USING ERRCODE = 'P0002'; END IF;
  -- trigger กันอ้างข้อมูลข้ามร้านตรวจด้วย app.org_id · ตั้งเป็นร้านนี้ชั่วคราวแล้วคืนค่าเดิมตอนจบ
  prev_org := current_setting('app.org_id', true);
  PERFORM set_config('app.org_id', o::text, true);

  d := (payload->>'days')::int;
  pickup := (payload->>'pickupAt')::timestamptz;
  IF d IS NULL OR d < 1 OR d > least(coalesce(max_days, 60), 60) THEN RAISE EXCEPTION 'too_many_days' USING ERRCODE = '22023'; END IF;
  IF pickup IS NULL OR pickup <= now() OR pickup > now() + interval '120 days' THEN RAISE EXCEPTION 'invalid_pickup' USING ERRCODE = '22023'; END IF;
  IF coalesce(trim(payload->>'fullName'), '') = '' OR coalesce(trim(payload->>'whatsapp'), '') = '' THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(payload->'items') <> 'array' OR jsonb_array_length(payload->'items') NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;

  -- รวมจำนวนที่ขอต่อประเภท/ไซส์ แล้วเทียบกับที่ว่างตลอดช่วง
  FOR it IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    IF coalesce((it->>'quantity')::int, 0) NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023'; END IF;
    SELECT * INTO t FROM asset_types WHERE id = (it->>'typeId')::uuid AND org_id = o AND archived_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_item' USING ERRCODE = '22023'; END IF;
    IF t.tracking = 'quantity' THEN
      SELECT * INTO v FROM asset_variants WHERE id = (it->>'variantId')::uuid AND asset_type_id = t.id;
      IF NOT FOUND THEN RAISE EXCEPTION 'invalid_item' USING ERRCODE = '22023'; END IF;
      key := 'v:' || v.id;
    ELSE
      key := 't:' || t.id;
    END IF;
    wanted := jsonb_set(wanted, ARRAY[key], to_jsonb(coalesce((wanted->>key)::int, 0) + (it->>'quantity')::int));
  END LOOP;

  avail := pub.availability_for(o, pickup, pickup + make_interval(days => d));
  FOR key IN SELECT jsonb_object_keys(wanted) LOOP
    IF left(key, 2) = 't:' THEN
      SELECT (x->>'available')::int INTO have FROM jsonb_array_elements(avail->'types') x WHERE x->>'id' = substr(key, 3);
    ELSE
      SELECT (y->>'available')::int INTO have FROM jsonb_array_elements(avail->'types') x, jsonb_array_elements(x->'variants') y WHERE y->>'id' = substr(key, 3);
    END IF;
    IF coalesce(have, 0) < (wanted->>key)::int THEN RAISE EXCEPTION 'not_available' USING ERRCODE = '23514'; END IF;
  END LOOP;

  -- รหัสจอง: 2 ตัวจากชื่อร้านใน URL (kohtao-rental → KR) + 4 ตัวสุ่มที่ไม่สับสน
  parts := regexp_split_to_array(regexp_replace(upper(slug_in), '[^A-Z-]', '', 'g'), '-+');
  IF array_length(parts, 1) >= 2 AND length(parts[1]) > 0 AND length(parts[2]) > 0 THEN
    prefix := left(parts[1], 1) || left(parts[2], 1);
  ELSE
    prefix := rpad(left(coalesce(parts[1], ''), 2), 2, 'X');
  END IF;
  LOOP
    c := prefix || '-' || (SELECT string_agg(substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1), '') FROM generate_series(1, 4));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM bookings b WHERE b.org_id = o AND b.code = c);
    tries := tries + 1;
    IF tries > 20 THEN RAISE EXCEPTION 'code_exhausted'; END IF;
  END LOOP;

  INSERT INTO bookings (org_id, code, full_name, whatsapp, email, hotel_room, checkout_date, has_license, pickup_at, days, notes, source, manage_token_hash, ip)
  VALUES (o, c, left(trim(payload->>'fullName'), 100), left(trim(payload->>'whatsapp'), 20), nullif(left(trim(payload->>'email'), 120), ''),
          nullif(left(trim(payload->>'hotelRoom'), 10), ''), nullif(payload->>'checkoutDate', '')::date, coalesce((payload->>'hasLicense')::boolean, false),
          pickup, d, nullif(left(trim(payload->>'notes'), 500), ''), nullif(left(trim(payload->>'source'), 40), ''), token_hash_in, ip_in)
  RETURNING id INTO bid;

  FOR it IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    SELECT * INTO t FROM asset_types WHERE id = (it->>'typeId')::uuid;
    IF t.tracking = 'quantity' THEN
      INSERT INTO booking_items (org_id, booking_id, asset_type_id, variant_id, quantity, price_per_day)
      VALUES (o, bid, t.id, (it->>'variantId')::uuid, (it->>'quantity')::int, t.price_per_day);
    ELSE
      -- ของรายชิ้น: 1 แถวต่อ 1 คัน เพื่อให้ร้านกำหนดคันทีละแถว
      INSERT INTO booking_items (org_id, booking_id, asset_type_id, quantity, price_per_day)
      SELECT o, bid, t.id, 1, t.price_per_day FROM generate_series(1, (it->>'quantity')::int);
    END IF;
  END LOOP;

  INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, entity_id, after, ip)
  VALUES (o, NULL, 'booking.requested', 'booking', bid::text, jsonb_build_object('code', c, 'pickupAt', pickup, 'days', d), ip_in);
  INSERT INTO outbox_events (org_id, type, payload) VALUES (o, 'booking.requested', jsonb_build_object('bookingId', bid, 'code', c));
  PERFORM set_config('app.org_id', coalesce(prev_org, ''), true);
  RETURN QUERY SELECT bid, c;
END $$;
--> statement-breakpoint

-- หน้าดู/ยกเลิกการจองของลูกค้า (ลิงก์ส่วนตัว) · ปิดเบอร์ไว้เหลือ 3 ตัวท้าย · ไม่คืนอีเมล
CREATE FUNCTION pub.booking_by_token(token_hash_in text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT jsonb_build_object(
     'code', b.code, 'status', b.status, 'shopName', o.name, 'shopSlug', o.slug, 'timezone', o.timezone,
     'fullName', b.full_name,
     'whatsappMasked', '••• ' || right(regexp_replace(b.whatsapp, '\D', '', 'g'), 3),
     'hotelRoom', b.hotel_room, 'checkoutDate', b.checkout_date,
     'pickupAt', b.pickup_at, 'days', b.days, 'createdAt', b.created_at, 'rejectReason', b.reject_reason,
     'cancellable', b.status IN ('requested', 'confirmed') AND b.pickup_at - now() > pub.cancel_window(),
     'cancelWindowHours', extract(epoch FROM pub.cancel_window()) / 3600,
     'total', (SELECT coalesce(sum(i.price_per_day * i.quantity * b.days), 0) FROM booking_items i WHERE i.booking_id = b.id),
     'items', (SELECT coalesce(jsonb_agg(jsonb_build_object('typeName', t.name, 'variantLabel', v.label, 'quantity', i.quantity, 'pricePerDay', i.price_per_day) ORDER BY t.sort_order, t.name), '[]'::jsonb)
               FROM booking_items i JOIN asset_types t ON t.id = i.asset_type_id LEFT JOIN asset_variants v ON v.id = i.variant_id
               WHERE i.booking_id = b.id))
   FROM bookings b JOIN orgs o ON o.id = b.org_id
   WHERE b.manage_token_hash = token_hash_in $$;
--> statement-breakpoint

CREATE FUNCTION pub.cancel_booking(token_hash_in text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
#variable_conflict use_column
DECLARE b bookings%ROWTYPE; prev_org text; result jsonb;
BEGIN
  SELECT * INTO b FROM bookings WHERE manage_token_hash = token_hash_in FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking_not_found' USING ERRCODE = 'P0002'; END IF;
  prev_org := current_setting('app.org_id', true);
  PERFORM set_config('app.org_id', b.org_id::text, true);
  IF b.status NOT IN ('requested', 'confirmed') OR b.pickup_at - now() <= pub.cancel_window() THEN
    RAISE EXCEPTION 'booking_not_cancellable' USING ERRCODE = '23514';
  END IF;
  UPDATE bookings SET status = 'cancelled' WHERE id = b.id;
  UPDATE booking_items SET active = false WHERE booking_id = b.id;
  INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, entity_id, before)
  VALUES (b.org_id, NULL, 'booking.cancelled_by_customer', 'booking', b.id::text, jsonb_build_object('status', b.status));
  INSERT INTO outbox_events (org_id, type, payload) VALUES (b.org_id, 'booking.cancelled', jsonb_build_object('bookingId', b.id, 'code', b.code));
  PERFORM set_config('app.org_id', coalesce(prev_org, ''), true);
  result := pub.booking_by_token(token_hash_in);
  RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pub FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pub.shop(text), pub.availability(text, timestamptz, timestamptz), pub.create_booking(text, jsonb, text, text),
  pub.booking_by_token(text), pub.cancel_booking(text), pub.cancel_window() TO rental_app;
