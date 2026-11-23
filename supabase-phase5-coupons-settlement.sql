BEGIN;

ALTER TABLE advertising_contracts
  ADD COLUMN IF NOT EXISTS cap_scope text NOT NULL DEFAULT 'campaign' CHECK(cap_scope IN ('campaign','period')),
  ADD COLUMN IF NOT EXISTS vat_rate_bps integer NOT NULL DEFAULT 1000 CHECK(vat_rate_bps BETWEEN 0 AND 3000),
  ADD COLUMN IF NOT EXISTS evidence_level text NOT NULL DEFAULT 'store' CHECK(evidence_level IN ('store','external'));

CREATE TABLE IF NOT EXISTS store_locations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES sponsor_companies(id),
  name text NOT NULL, address text NOT NULL DEFAULT '', active boolean NOT NULL DEFAULT true,
  UNIQUE(company_id,id)
);
CREATE TABLE IF NOT EXISTS store_staff_accounts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), store_id uuid NOT NULL REFERENCES store_locations(id),
  username text NOT NULL UNIQUE, display_name text NOT NULL, password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true, can_request_cancel boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(store_id,id)
);
CREATE TABLE IF NOT EXISTS store_staff_sessions(
  token_hash text PRIMARY KEY, staff_id uuid NOT NULL REFERENCES store_staff_accounts(id),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS coupon_rate_limits(
  key text NOT NULL, window_start timestamptz NOT NULL, hits integer NOT NULL,
  PRIMARY KEY(key,window_start)
);
CREATE INDEX IF NOT EXISTS coupon_rate_window_idx ON coupon_rate_limits(window_start);

CREATE TABLE IF NOT EXISTS coupon_policies(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES sponsor_campaigns(id),
  name text NOT NULL, description text NOT NULL DEFAULT '', terms text NOT NULL DEFAULT '', exclusions text NOT NULL DEFAULT '',
  minimum_krw numeric(14,0) NOT NULL CHECK(minimum_krw>0), discount_krw numeric(14,0) NOT NULL CHECK(discount_krw>0 AND discount_krw<=minimum_krw),
  issue_starts_at timestamptz NOT NULL, issue_ends_at timestamptz NOT NULL,
  valid_from timestamptz NOT NULL, valid_until timestamptz NOT NULL,
  inventory integer NOT NULL CHECK(inventory BETWEEN 1 AND 1000000),
  per_person integer NOT NULL CHECK(per_person BETWEEN 1 AND 20),
  eligibility text NOT NULL CHECK(eligibility IN ('quiz_complete','quiz_score','all_missions','winner')),
  minimum_score integer CHECK(minimum_score>=0),
  active boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(issue_starts_at<issue_ends_at AND valid_from<valid_until AND issue_ends_at<=valid_until),
  CHECK((eligibility='quiz_score')=(minimum_score IS NOT NULL)),
  UNIQUE(id,campaign_id)
);
CREATE TABLE IF NOT EXISTS coupon_policy_stores(
  policy_id uuid NOT NULL REFERENCES coupon_policies(id), store_id uuid NOT NULL REFERENCES store_locations(id),
  PRIMARY KEY(policy_id,store_id)
);
CREATE TABLE IF NOT EXISTS coupon_issuances(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), policy_id uuid NOT NULL, campaign_id uuid NOT NULL,
  participant_id uuid NOT NULL, slot integer NOT NULL CHECK(slot>0),
  eligibility_snapshot jsonb NOT NULL, terms_snapshot jsonb NOT NULL, owner_hash text,
  status text NOT NULL DEFAULT 'available' CHECK(status IN ('available','used','cancelled','suspended')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(policy_id,participant_id,slot), UNIQUE(id,campaign_id),
  FOREIGN KEY(policy_id,campaign_id) REFERENCES coupon_policies(id,campaign_id),
  FOREIGN KEY(campaign_id,participant_id) REFERENCES campaign_participants(campaign_id,id)
);
CREATE INDEX IF NOT EXISTS coupon_issuances_member_idx ON coupon_issuances(participant_id);
CREATE TABLE IF NOT EXISTS coupon_presentations(
  issuance_id uuid PRIMARY KEY REFERENCES coupon_issuances(id), token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL, store_id uuid REFERENCES store_locations(id),
  challenge_hash text, failed integer NOT NULL DEFAULT 0, owner_confirmed_at timestamptz
);

CREATE TABLE IF NOT EXISTS coupon_redemptions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), issuance_id uuid UNIQUE NOT NULL,
  company_id uuid NOT NULL, campaign_id uuid NOT NULL, store_id uuid NOT NULL, staff_id uuid NOT NULL,
  request_id uuid NOT NULL, before_discount_krw numeric(14,0) NOT NULL,
  paid_krw numeric(14,0) NOT NULL CHECK(paid_krw>=0), discount_krw numeric(14,0) NOT NULL CHECK(discount_krw>0),
  approved_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'approved'
    CHECK(status IN ('approved','partially_refunded','refunded','cancelled')),
  external_verified_at timestamptz, external_reference text, external_amount_krw numeric(14,0),
  UNIQUE(store_id,request_id), UNIQUE(company_id,external_reference),
  CHECK(before_discount_krw=paid_krw+discount_krw),
  CHECK(external_amount_krw IS NULL OR external_amount_krw=paid_krw),
  FOREIGN KEY(issuance_id,campaign_id) REFERENCES coupon_issuances(id,campaign_id),
  FOREIGN KEY(store_id,staff_id) REFERENCES store_staff_accounts(store_id,id),
  FOREIGN KEY(company_id,store_id) REFERENCES store_locations(company_id,id)
);
CREATE INDEX IF NOT EXISTS coupon_redemptions_campaign_idx ON coupon_redemptions(campaign_id,approved_at);
CREATE TABLE IF NOT EXISTS coupon_redemption_adjustments(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), redemption_id uuid NOT NULL REFERENCES coupon_redemptions(id),
  requested_by uuid REFERENCES store_staff_accounts(id), kind text NOT NULL CHECK(kind IN ('cancel','refund')),
  reason text NOT NULL, evidence_reference text NOT NULL DEFAULT '', refund_krw numeric(14,0) CHECK(refund_krw>=0),
  full_reversal boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, decided_by text
);
CREATE UNIQUE INDEX IF NOT EXISTS coupon_adjustment_pending_idx ON coupon_redemption_adjustments(redemption_id) WHERE status='pending';
CREATE UNIQUE INDEX IF NOT EXISTS coupon_refund_reference_idx ON coupon_redemption_adjustments(redemption_id,evidence_reference)
  WHERE kind='refund' AND status='approved';
CREATE TABLE IF NOT EXISTS coupon_verification_logs(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, issuance_id uuid REFERENCES coupon_issuances(id),
  redemption_id uuid REFERENCES coupon_redemptions(id), staff_id uuid REFERENCES store_staff_accounts(id),
  store_id uuid REFERENCES store_locations(id), actor text NOT NULL, action text NOT NULL, detail text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS advertising_settlements(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid NOT NULL REFERENCES advertising_contracts(id),
  company_id uuid NOT NULL REFERENCES sponsor_companies(id), campaign_id uuid NOT NULL REFERENCES sponsor_campaigns(id),
  period_start date NOT NULL, period_end date NOT NULL, status text NOT NULL DEFAULT 'collecting'
    CHECK(status IN ('collecting','needs_review','reviewed','finalized')),
  snapshot jsonb NOT NULL, fingerprint text NOT NULL, finalized_at timestamptz, finalized_by text,
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(period_start<period_end),
  UNIQUE(contract_id,period_start)
);
CREATE TABLE IF NOT EXISTS advertising_settlement_items(
  settlement_id uuid NOT NULL REFERENCES advertising_settlements(id), redemption_id uuid NOT NULL UNIQUE REFERENCES coupon_redemptions(id),
  eligible_count integer NOT NULL CHECK(eligible_count IN (0,1)), eligible_krw numeric(14,0) NOT NULL CHECK(eligible_krw>=0),
  PRIMARY KEY(settlement_id,redemption_id)
);
CREATE TABLE IF NOT EXISTS advertising_settlement_adjustments(
  settlement_id uuid NOT NULL REFERENCES advertising_settlements(id),
  adjustment_id uuid NOT NULL UNIQUE REFERENCES coupon_redemption_adjustments(id),
  origin_id uuid NOT NULL REFERENCES advertising_settlements(id), count_delta integer NOT NULL CHECK(count_delta IN (-1,0)),
  purchase_delta numeric(14,0) NOT NULL CHECK(purchase_delta<=0),
  PRIMARY KEY(settlement_id,adjustment_id)
);

CREATE OR REPLACE FUNCTION phase5_protect_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stage text;
BEGIN
  IF TG_TABLE_NAME='advertising_settlements' THEN
    IF OLD.status='finalized' THEN RAISE EXCEPTION 'Finalized settlement is immutable'; END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      SELECT status INTO stage FROM advertising_settlements WHERE id=OLD.settlement_id FOR SHARE;
      IF stage='finalized' THEN
        RAISE EXCEPTION 'Finalized settlement lines are immutable';
      END IF;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT status INTO stage FROM advertising_settlements WHERE id=NEW.settlement_id FOR SHARE;
      IF stage='finalized' THEN
        RAISE EXCEPTION 'Finalized settlement lines are immutable';
      END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS phase5_settlement_immutable ON advertising_settlements;
CREATE TRIGGER phase5_settlement_immutable BEFORE UPDATE OR DELETE ON advertising_settlements
  FOR EACH ROW EXECUTE FUNCTION phase5_protect_settlement();
DROP TRIGGER IF EXISTS phase5_settlement_items_immutable ON advertising_settlement_items;
CREATE TRIGGER phase5_settlement_items_immutable BEFORE INSERT OR UPDATE OR DELETE ON advertising_settlement_items
  FOR EACH ROW EXECUTE FUNCTION phase5_protect_settlement();
DROP TRIGGER IF EXISTS phase5_settlement_adjustments_immutable ON advertising_settlement_adjustments;
CREATE TRIGGER phase5_settlement_adjustments_immutable BEFORE INSERT OR UPDATE OR DELETE ON advertising_settlement_adjustments
  FOR EACH ROW EXECUTE FUNCTION phase5_protect_settlement();

DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['store_locations','store_staff_accounts','store_staff_sessions','coupon_rate_limits',
    'coupon_policies','coupon_policy_stores','coupon_issuances','coupon_presentations','coupon_redemptions',
    'coupon_redemption_adjustments','coupon_verification_logs','advertising_settlements',
    'advertising_settlement_items','advertising_settlement_adjustments']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',name);
  END LOOP;
  REVOKE ALL ON SEQUENCE public.coupon_verification_logs_id_seq FROM PUBLIC,anon,authenticated;
END $$;
COMMIT;
