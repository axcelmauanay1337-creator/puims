-- 0006: a handover can carry forward a specific EXPECTED dose of an order (order id + slot time),
-- since expected doses are derived, not stored. Several slots of one order may be carried.
ALTER TABLE handover_item ADD COLUMN slot_at timestamptz;
ALTER TABLE handover_item ADD CONSTRAINT handover_item_slot_chk CHECK ((kind = 'NEBULIZATION_ORDER') = (slot_at IS NOT NULL));
ALTER TABLE handover_item DROP CONSTRAINT handover_item_handover_id_kind_ref_id_key;
CREATE UNIQUE INDEX handover_item_uq ON handover_item (handover_id, kind, ref_id, coalesce(slot_at, '-infinity'::timestamptz));
