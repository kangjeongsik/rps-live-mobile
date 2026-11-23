BEGIN;

CREATE TABLE IF NOT EXISTS public.advertising_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL, name text NOT NULL, description text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('quiz','mission','rps')),
  min_days integer NOT NULL CHECK (min_days BETWEEN 1 AND 31),
  max_days integer NOT NULL CHECK (max_days BETWEEN 1 AND 31),
  default_days integer NOT NULL, activities jsonb NOT NULL,
  suggested_billing text NOT NULL CHECK (suggested_billing IN ('fixed','performance','hybrid')),
  enabled boolean NOT NULL DEFAULT true,
  CHECK (min_days <= default_days AND default_days <= max_days)
);

CREATE TABLE IF NOT EXISTS public.advertising_pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES public.advertising_packages(id),
  rule_code text NOT NULL, field text NOT NULL
    CHECK (field IN ('goal','industry','has_store','needs_consultation','benefits','duration','budget','audience')),
  match_value text NOT NULL, weight integer NOT NULL CHECK (weight BETWEEN 1 AND 1000),
  reason text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  UNIQUE (package_id,rule_code)
);

INSERT INTO public.advertising_packages(code,name,description,event_type,min_days,max_days,default_days,activities,suggested_billing)
VALUES
 ('store_visit','매장 방문형','오프라인 매장 방문과 구매 유도','quiz',1,7,3,
  '["브랜드 퀴즈","매장 위치와 방문 혜택 안내","향후 조건부 할인쿠폰 연결"]','performance'),
 ('brand_awareness','브랜드 홍보형','브랜드·신제품 인지도와 콘텐츠 참여 확대','quiz',1,7,3,
  '["브랜드 또는 제품 객관식 퀴즈","브랜드 콘텐츠 확인","필요 시 별도 협찬 가위바위보"]','fixed'),
 ('seven_day','7일 참여형','반복 참여와 브랜드 관심 유지','mission',7,7,7,
  '["일일 퀴즈","브랜드 콘텐츠 확인 미션","누적 완료 및 연속 참여 측정"]','fixed'),
 ('consultation','상담·예약형','서비스 상담과 예약 문의 유도','quiz',3,14,7,
  '["서비스 이해 퀴즈","상담·예약 안내","향후 상담·예약 성과 인증 연결"]','hybrid')
ON CONFLICT(code) DO NOTHING;

INSERT INTO public.advertising_pricing_rules(package_id,rule_code,field,match_value,weight,reason)
SELECT p.id,r.rule_code,r.field,r.match_value,r.weight,r.reason
FROM (VALUES
 ('store_visit','goal','goal','store_visit',100,'매장 방문 유도가 주요 목표입니다.'),
 ('store_visit','industry','industry','카페|식당|음식|소매|매장|베이커리|retail|cafe',35,'오프라인 방문에 적합한 업종입니다.'),
 ('store_visit','store','has_store','true',15,'방문할 오프라인 매장이 있습니다.'),
 ('store_visit','benefit','benefits','쿠폰|할인|현장|매장',8,'매장 방문과 연결할 혜택이 있습니다.'),
 ('brand_awareness','goal','goal','brand_awareness',100,'브랜드 또는 제품 인지도가 주요 목표입니다.'),
 ('brand_awareness','industry','industry','화장품|브랜드|출시|제품|뷰티|제조',35,'브랜드 콘텐츠 활용에 적합한 업종입니다.'),
 ('seven_day','goal','goal','engagement',100,'반복 참여가 주요 목표입니다.'),
 ('seven_day','duration','duration','7',15,'희망 기간이 7일 운영에 맞습니다.'),
 ('consultation','goal','goal','consultation',100,'상담이나 예약 유도가 주요 목표입니다.'),
 ('consultation','industry','industry','집수리|청소|교육|전문|상담|예약|서비스',35,'상담·예약 전환과 잘 맞는 업종입니다.'),
 ('consultation','need','needs_consultation','true',25,'상담 또는 예약 안내가 필요합니다.')
) AS r(package_code,rule_code,field,match_value,weight,reason)
JOIN public.advertising_packages p ON p.code=r.package_code
ON CONFLICT(package_id,rule_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.advertising_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.sponsor_companies(id),
  industry text NOT NULL, goal text NOT NULL, goal_note text NOT NULL DEFAULT '',
  budget_krw numeric(14,0) CHECK (budget_krw >= 0), desired_days integer CHECK (desired_days BETWEEN 1 AND 31),
  audience text NOT NULL DEFAULT '', has_store boolean NOT NULL DEFAULT false,
  benefits text NOT NULL DEFAULT '', needs_consultation boolean NOT NULL DEFAULT false,
  consultation_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id,id)
);
CREATE INDEX IF NOT EXISTS advertising_leads_company_idx ON public.advertising_leads(company_id,created_at DESC);

CREATE TABLE IF NOT EXISTS public.advertising_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.sponsor_companies(id),
  lead_id uuid NOT NULL, package_id uuid NOT NULL REFERENCES public.advertising_packages(id),
  campaign_id uuid UNIQUE REFERENCES public.sponsor_campaigns(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','sent','cancelled')),
  revision bigint NOT NULL DEFAULT 0,
  title text NOT NULL, description text NOT NULL, recommendation_reason text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('quiz','mission','rps')),
  activities jsonb NOT NULL, benefit_notes text NOT NULL, join_terms text NOT NULL,
  opens_at timestamptz NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  expected_reach integer CHECK(expected_reach >= 0),
  coupon_policy_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  FOREIGN KEY(company_id,lead_id) REFERENCES public.advertising_leads(company_id,id),
  CHECK (opens_at <= starts_at AND starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS advertising_proposals_company_idx ON public.advertising_proposals(company_id,created_at DESC);

CREATE TABLE IF NOT EXISTS public.advertising_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid UNIQUE NOT NULL REFERENCES public.advertising_proposals(id),
  revision bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'consulting' CHECK(status IN
    ('consulting','proposal_writing','proposal_sent','negotiating','confirmed','running','ended','cancelled')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('fixed','performance','hybrid')),
  performance_basis text CHECK(performance_basis IN ('validated_coupon','validated_purchase')),
  fixed_fee_krw numeric(14,0), unit_fee_krw numeric(14,0), purchase_rate_bps integer,
  cap_krw numeric(14,0), projected_coupon_uses integer, projected_purchase_krw numeric(14,0),
  estimate_krw numeric(14,0),
  contract_start date NOT NULL, contract_end date NOT NULL,
  discount_payer text NOT NULL CHECK(discount_payer IN ('advertiser','platform','shared','none')),
  vat_mode text NOT NULL CHECK(vat_mode IN ('exclusive','inclusive','exempt')),
  settlement_cycle text NOT NULL CHECK(settlement_cycle IN ('end_of_campaign','monthly','weekly')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CHECK (contract_start <= contract_end),
  CHECK (fixed_fee_krw IS NULL OR fixed_fee_krw > 0),
  CHECK (unit_fee_krw IS NULL OR unit_fee_krw > 0),
  CHECK (purchase_rate_bps IS NULL OR purchase_rate_bps BETWEEN 1 AND 10000),
  CHECK (cap_krw IS NULL OR (cap_krw > 0 AND cap_krw >= coalesce(fixed_fee_krw,0))),
  CHECK (projected_coupon_uses IS NULL OR projected_coupon_uses >= 0),
  CHECK (projected_purchase_krw IS NULL OR projected_purchase_krw >= 0),
  CHECK ((billing_mode IN ('fixed','hybrid')) = (fixed_fee_krw IS NOT NULL)),
  CHECK ((billing_mode IN ('performance','hybrid')) = (performance_basis IS NOT NULL)),
  CHECK ((unit_fee_krw IS NOT NULL) = coalesce(performance_basis='validated_coupon',false)),
  CHECK ((purchase_rate_bps IS NOT NULL) = coalesce(performance_basis='validated_purchase',false))
);

CREATE TABLE IF NOT EXISTS public.advertising_activity_logs (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.sponsor_companies(id),
  lead_id uuid REFERENCES public.advertising_leads(id),
  proposal_id uuid REFERENCES public.advertising_proposals(id),
  contract_id uuid REFERENCES public.advertising_contracts(id),
  action text NOT NULL, detail text NOT NULL DEFAULT '', occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS advertising_activity_company_idx ON public.advertising_activity_logs(company_id,id DESC);

ALTER TABLE public.sponsor_campaigns
  ADD COLUMN IF NOT EXISTS advertising_plan jsonb,
  ADD COLUMN IF NOT EXISTS advertising_review_required boolean NOT NULL DEFAULT false;

DO $$
DECLARE target text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.sponsor_campaigns'::regclass
     AND conname='sponsor_campaigns_ad_product_fk') THEN
    ALTER TABLE public.sponsor_campaigns ADD CONSTRAINT sponsor_campaigns_ad_product_fk
      FOREIGN KEY (ad_product_id) REFERENCES public.advertising_packages(id) NOT VALID;
  END IF;
  FOREACH target IN ARRAY ARRAY['advertising_packages','advertising_pricing_rules','advertising_leads',
    'advertising_proposals','advertising_contracts','advertising_activity_logs']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', target);
  END LOOP;
END $$;

COMMIT;
