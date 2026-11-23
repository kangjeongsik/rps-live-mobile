\set ON_ERROR_STOP on
\echo Use only on a separately provisioned staging database with verified synthetic data.
BEGIN;
SELECT set_config('rps.staging_db', :'staging_db', true);
SELECT set_config('rps.staging_role', :'staging_role', true);
SELECT set_config('rps.staging_id', :'staging_id', true);

DO $$
DECLARE
  db text := current_setting('rps.staging_db');
  app text := current_setting('rps.staging_role');
  marker uuid := current_setting('rps.staging_id')::uuid;
  t record;
BEGIN
  IF current_database() <> db OR app IN (current_user,'anon','authenticated','public') OR NOT EXISTS(
    SELECT 1 FROM pg_roles WHERE rolname=app AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole
  ) THEN RAISE EXCEPTION 'Staging database or restricted app role does not match'; END IF;
  EXECUTE 'CREATE TABLE IF NOT EXISTS public.rps_staging_identity (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    environment text NOT NULL CHECK(environment=''staging''), instance_id uuid NOT NULL
  )';
  IF EXISTS (SELECT 1 FROM public.rps_staging_identity WHERE instance_id<>marker)
    THEN RAISE EXCEPTION 'Existing staging identity is different'; END IF;
  INSERT INTO public.rps_staging_identity(environment,instance_id) VALUES('staging',marker) ON CONFLICT DO NOTHING;
  REVOKE ALL ON public.rps_staging_identity FROM PUBLIC,anon,authenticated;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I',app);
  EXECUTE format('REVOKE ALL ON public.rps_staging_identity FROM %I',app);
  EXECUTE format('GRANT SELECT ON public.rps_staging_identity TO %I',app);
  FOR t IN SELECT * FROM (VALUES
    ('rps_events','SELECT,INSERT,UPDATE'),
    ('rps_event_runtime','SELECT,INSERT,UPDATE'),
    ('rps_event_aliases','SELECT,UPDATE'),
    ('rps_prize_cards','SELECT,INSERT,UPDATE,DELETE'),
    ('rps_prize_awards','SELECT,INSERT'),
    ('rps_device_blocks','SELECT,INSERT,UPDATE,DELETE'),
    ('rps_winners','SELECT,INSERT,UPDATE'),
    ('rps_inquiries','SELECT,INSERT,UPDATE'),
    ('rps_push_subscriptions','SELECT,INSERT,UPDATE,DELETE'),
    ('daily_schedules','SELECT,UPDATE'),
    ('daily_occurrences','SELECT,INSERT,UPDATE'),
    ('daily_reservations','SELECT,INSERT,UPDATE'),
    ('daily_participations','SELECT,INSERT,UPDATE'),
    ('daily_execution_log','SELECT,INSERT'),
    ('daily_notification_jobs','SELECT,INSERT,UPDATE'),
    ('daily_notification_preferences','SELECT,INSERT,UPDATE'),
    ('sponsor_companies','SELECT,INSERT,UPDATE'),
    ('sponsor_campaigns','SELECT,INSERT,UPDATE'),
    ('campaign_participants','SELECT,INSERT,UPDATE'),
    ('campaign_quiz_questions','SELECT,INSERT,DELETE'),
    ('campaign_quiz_submissions','SELECT,INSERT'),
    ('campaign_missions','SELECT,INSERT,DELETE'),
    ('campaign_mission_progress','SELECT,INSERT'),
    ('campaign_mission_attempts','SELECT,INSERT'),
    ('campaign_activity_logs','SELECT,INSERT'),
    ('campaign_notification_preferences','SELECT,INSERT,UPDATE'),
    ('advertising_packages','SELECT,UPDATE'),
    ('advertising_pricing_rules','SELECT,INSERT,UPDATE'),
    ('advertising_leads','SELECT,INSERT,UPDATE'),
    ('advertising_proposals','SELECT,INSERT,UPDATE'),
    ('advertising_contracts','SELECT,INSERT,UPDATE'),
    ('advertising_activity_logs','SELECT,INSERT'),
    ('store_locations','SELECT,INSERT,UPDATE'),
    ('store_staff_accounts','SELECT,INSERT,UPDATE'),
    ('store_staff_sessions','SELECT,INSERT,DELETE'),
    ('coupon_rate_limits','SELECT,INSERT,UPDATE'),
    ('coupon_policies','SELECT,INSERT,UPDATE'),
    ('coupon_policy_stores','SELECT,INSERT,DELETE'),
    ('coupon_issuances','SELECT,INSERT,UPDATE'),
    ('coupon_presentations','SELECT,INSERT,UPDATE'),
    ('coupon_redemptions','SELECT,INSERT,UPDATE'),
    ('coupon_redemption_adjustments','SELECT,INSERT,UPDATE'),
    ('coupon_verification_logs','SELECT,INSERT'),
    ('advertising_settlements','SELECT,INSERT,UPDATE'),
    ('advertising_settlement_items','SELECT,INSERT'),
    ('advertising_settlement_adjustments','SELECT,INSERT')
  ) AS v(relation,privileges)
  LOOP
    EXECUTE format('GRANT %s ON TABLE public.%I TO %I',t.privileges,t.relation,app);
    EXECUTE format('DROP POLICY IF EXISTS phase6_staging_app ON public.%I',t.relation);
    EXECUTE format('CREATE POLICY phase6_staging_app ON public.%I FOR ALL TO %I USING (true) WITH CHECK (true)',t.relation,app);
  END LOOP;
  EXECUTE format('GRANT USAGE ON SEQUENCE public.daily_execution_log_id_seq, public.campaign_activity_logs_id_seq,
    public.advertising_activity_logs_id_seq, public.coupon_verification_logs_id_seq TO %I',app);
END $$;
COMMIT;
