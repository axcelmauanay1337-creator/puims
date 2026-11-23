-- 0009: policy interlocks found in the Milestone 8 review.
-- U-09 (may payment classification be stored?) is undecided → interim rule "not stored".
-- The column stays for a future, approved migration but must remain empty until the DPO decides.
UPDATE diagnostic_appointment SET payment_class = NULL WHERE payment_class IS NOT NULL;
ALTER TABLE diagnostic_appointment ADD CONSTRAINT diag_payment_u09 CHECK (payment_class IS NULL);
