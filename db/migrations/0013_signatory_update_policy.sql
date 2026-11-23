-- 0013: the Chief RT may complete an active signatory entry (add its e-signature or RT account link once —
-- enforced by signatory_guard), not only deactivate it.
DROP POLICY signatory_update ON signatory;
CREATE POLICY signatory_update ON signatory FOR UPDATE
  USING ((SELECT app_is_chief()))
  WITH CHECK ((SELECT app_is_chief()) AND (active OR deactivated_by = (SELECT app_active_staff_id())));
