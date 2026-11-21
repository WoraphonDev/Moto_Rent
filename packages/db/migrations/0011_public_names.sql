ALTER TABLE "asset_types" ADD COLUMN "public_name" text;--> statement-breakpoint
ALTER TABLE "asset_types" ADD CONSTRAINT "asset_types_public_name_check" CHECK ("asset_types"."public_name" is null or char_length("asset_types"."public_name") between 1 and 60);--> statement-breakpoint
-- หน้าจอง/หน้าการจองของลูกค้าใช้ชื่อที่ลูกค้าเห็น (ภาษาอังกฤษ) ถ้าร้านตั้งไว้
CREATE OR REPLACE FUNCTION pub.shop(slug_in text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT jsonb_build_object(
     'orgId', o.id, 'name', o.name, 'slug', o.slug, 'timezone', o.timezone, 'currency', o.currency,
     'maxRentalDays', s.max_rental_days,
     'types', coalesce((
       SELECT jsonb_agg(jsonb_build_object(
         'id', t.id, 'name', coalesce(t.public_name, t.name), 'tracking', t.tracking, 'pricePerDay', t.price_per_day, 'deposit', t.deposit,
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
CREATE OR REPLACE FUNCTION pub.booking_by_token(token_hash_in text) RETURNS jsonb
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
     'items', (SELECT coalesce(jsonb_agg(jsonb_build_object('typeName', coalesce(t.public_name, t.name), 'variantLabel', v.label, 'quantity', i.quantity, 'pricePerDay', i.price_per_day) ORDER BY t.sort_order, t.name), '[]'::jsonb)
               FROM booking_items i JOIN asset_types t ON t.id = i.asset_type_id LEFT JOIN asset_variants v ON v.id = i.variant_id
               WHERE i.booking_id = b.id))
   FROM bookings b JOIN orgs o ON o.id = b.org_id
   WHERE b.manage_token_hash = token_hash_in $$;
