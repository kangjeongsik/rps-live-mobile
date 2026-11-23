const loopback=new Set(['127.0.0.1','localhost','[::1]']);
function failure(message){return Object.assign(Error(message),{configuration:true})}
function insist(condition,message){if(!condition)throw failure(message)}
function url(value,label){
  try{return new URL(value)}catch{throw failure(label+' 형식을 확인하세요')}
}
function configuration(env=process.env){
  const mode=env.RPS_ENV||'local';
  insist(['local','staging','production'].includes(mode),'RPS_ENV 값은 local, staging, production 중 하나입니다');
  insist(env.ADMIN_PASSWORD?.length>=12,'ADMIN_PASSWORD는 12자 이상이어야 합니다');
  insist(/^[^:\r\n]{1,64}$/.test(env.ADMIN_USER||'admin'),'ADMIN_USER 형식을 확인하세요');
  const database=url(env.DATABASE_URL,'DATABASE_URL');
  insist(['postgres:','postgresql:'].includes(database.protocol)&&database.username&&database.pathname.length>1,
    'DATABASE_URL에 PostgreSQL 호스트, 역할, 데이터베이스를 설정하세요');
  insist(![...database.searchParams.keys()].some(name=>/^(host|hostaddr|port|user|dbname|database|password|service|options|sslmode|sslrootcert|sslcert|sslkey)$/i.test(name)),
    'DATABASE_URL의 연결 대상 및 TLS 설정은 기본 주소와 SUPABASE_DB_CA에서 지정하세요');
  const name=decodeURIComponent(database.pathname.slice(1));
  const role=decodeURIComponent(database.username);
  const secureMode=mode!=='local';
  insist(secureMode||loopback.has(database.hostname),'local 모드의 DATABASE_URL은 루프백만 허용됩니다');
  insist(!secureMode||env.RPS_LOCAL_DB_NO_TLS!=='1','스테이징과 운영은 PostgreSQL TLS가 필요합니다');
  let origin=null;
  if(secureMode||env.PUBLIC_ORIGIN){
    const configured=url(env.PUBLIC_ORIGIN,'PUBLIC_ORIGIN');
    insist(configured.href===configured.origin+'/'&&
      (configured.protocol==='https:'||(!secureMode&&configured.protocol==='http:'&&loopback.has(configured.hostname))),
    'PUBLIC_ORIGIN에 서비스의 원본 주소만 설정하세요');
    origin=configured.origin;
  }
  if(mode==='staging'){
    insist(env.STAGING_DB_HOST&&env.STAGING_DB_NAME&&env.STAGING_DB_ROLE&&/^[a-f0-9-]{36}$/i.test(env.STAGING_DB_ID||''),
      'STAGING_DB_HOST, STAGING_DB_NAME, STAGING_DB_ROLE, STAGING_DB_ID가 필요합니다');
    insist(database.hostname===env.STAGING_DB_HOST.toLowerCase()&&name===env.STAGING_DB_NAME&&role===(env.STAGING_DB_LOGIN||env.STAGING_DB_ROLE),
      'DATABASE_URL이 스테이징 허용 대상과 일치하지 않습니다');
  }
  insist(!env.DAILY_SCHEDULER_TOKEN||env.DAILY_SCHEDULER_TOKEN.length>=32,'DAILY_SCHEDULER_TOKEN은 32자 이상이어야 합니다');
  insist(env.DAILY_PUSH_DELIVERY!=='enabled'||(env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_KEY),'푸시 활성화에는 VAPID 키 쌍이 필요합니다');
  insist(Boolean(env.VAPID_PUBLIC_KEY)===Boolean(env.VAPID_PRIVATE_KEY),'VAPID 키 쌍을 함께 설정하세요');
  if(mode==='staging'&&env.DAILY_PUSH_DELIVERY==='enabled')insist(env.STAGING_ALLOW_PUSH==='enabled','스테이징 푸시를 명시적으로 활성화하세요');
  insist(!env.RPS_CAMPAIGN_TEST_AT||mode==='local','테스트 시계는 로컬에서만 사용할 수 있습니다');
  return {mode,name,role:mode==='staging'?env.STAGING_DB_ROLE:role,origin,tag:env.STAGING_DB_ID||null,noTLS:mode==='local'&&env.RPS_LOCAL_DB_NO_TLS==='1'};
}

const required={
  rps_events:'SELECT,INSERT,UPDATE',rps_event_runtime:'SELECT,INSERT,UPDATE',rps_event_aliases:'SELECT,UPDATE',
  rps_prize_cards:'SELECT,INSERT,UPDATE,DELETE',rps_prize_awards:'SELECT,INSERT',rps_device_blocks:'SELECT,INSERT,UPDATE,DELETE',
  rps_winners:'SELECT,INSERT,UPDATE',rps_inquiries:'SELECT,INSERT,UPDATE',rps_push_subscriptions:'SELECT,INSERT,UPDATE,DELETE',
  daily_schedules:'SELECT,UPDATE',daily_occurrences:'SELECT,INSERT,UPDATE',daily_reservations:'SELECT,INSERT,UPDATE',
  daily_participations:'SELECT,INSERT,UPDATE',daily_execution_log:'SELECT,INSERT',daily_notification_jobs:'SELECT,INSERT,UPDATE',
  daily_notification_preferences:'SELECT,INSERT,UPDATE',
  sponsor_companies:'SELECT,INSERT,UPDATE',sponsor_campaigns:'SELECT,INSERT,UPDATE',
  campaign_participants:'SELECT,INSERT,UPDATE',campaign_quiz_questions:'SELECT,INSERT,DELETE',
  campaign_quiz_submissions:'SELECT,INSERT',campaign_missions:'SELECT,INSERT,DELETE',
  campaign_mission_progress:'SELECT,INSERT',campaign_mission_attempts:'SELECT,INSERT',
  campaign_activity_logs:'SELECT,INSERT',campaign_notification_preferences:'SELECT,INSERT,UPDATE',
  advertising_packages:'SELECT,UPDATE',advertising_pricing_rules:'SELECT,INSERT,UPDATE',
  advertising_leads:'SELECT,INSERT,UPDATE',advertising_proposals:'SELECT,INSERT,UPDATE',
  advertising_contracts:'SELECT,INSERT,UPDATE',advertising_activity_logs:'SELECT,INSERT',
  store_locations:'SELECT,INSERT,UPDATE',store_staff_accounts:'SELECT,INSERT,UPDATE',store_staff_sessions:'SELECT,INSERT,DELETE',
  coupon_rate_limits:'SELECT,INSERT,UPDATE',coupon_policies:'SELECT,INSERT,UPDATE',coupon_policy_stores:'SELECT,INSERT,DELETE',
  coupon_issuances:'SELECT,INSERT,UPDATE',coupon_presentations:'SELECT,INSERT,UPDATE',
  coupon_redemptions:'SELECT,INSERT,UPDATE',coupon_redemption_adjustments:'SELECT,INSERT,UPDATE',
  coupon_verification_logs:'SELECT,INSERT',advertising_settlements:'SELECT,INSERT,UPDATE',
  advertising_settlement_items:'SELECT,INSERT',advertising_settlement_adjustments:'SELECT,INSERT'
};
async function preflight(pool,config){
  const {rows:[db]}=await pool.query(`SELECT current_database() AS name,current_user AS role,
    to_regclass('public.rps_staging_identity') IS NOT NULL AS tagged,
    NOT (r.rolsuper OR r.rolbypassrls) AS restricted
    FROM pg_roles r WHERE r.rolname=current_user`);
  insist(db?.name===config.name,'연결된 DB 이름이 설정과 일치하지 않습니다');
  if(config.mode==='staging'){
    insist(db.tagged&&db.role===config.role&&db.restricted,'스테이징 DB 마커와 제한된 앱 역할을 확인하세요');
    const {rows}=await pool.query(`SELECT environment,instance_id::text,
      has_table_privilege('public.rps_staging_identity','INSERT,UPDATE,DELETE,TRUNCATE') AS writable
      FROM public.rps_staging_identity`);
    insist(rows.length===1&&!rows[0].writable&&rows[0].environment==='staging'&&rows[0].instance_id===config.tag.toLowerCase(),
      '스테이징 DB 식별자가 일치하지 않습니다');
  }
  if(config.mode==='production')insist(!db.tagged,'운영 모드에서 스테이징 DB를 사용할 수 없습니다');
  const names=Object.keys(required);
  const {rows:checks}=await pool.query(`SELECT n.name, to_regclass('public.'||n.name) AS present,c.relrowsecurity AS rls,
    CASE WHEN c.oid IS NOT NULL THEN (SELECT bool_and(has_table_privilege(c.oid,token))
      FROM unnest(string_to_array(n.permissions,',')) AS token) ELSE false END AS allowed,
    CASE WHEN c.oid IS NOT NULL THEN has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')
      OR has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') ELSE false END AS public_access
    FROM unnest($1::text[],$2::text[]) AS n(name,permissions)
    LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||n.name) ORDER BY n.name`,[names,Object.values(required)]);
  const bad=checks.find(row=>!row.present||!row.rls||!row.allowed||row.public_access);
  insist(!bad,'마이그레이션 또는 앱 권한을 확인하세요: '+bad?.name);
  const {rows:[alias]}=await pool.query("SELECT EXISTS(SELECT 1 FROM public.rps_event_aliases WHERE name='default') AS visible");
  insist(alias.visible,'앱 역할이 기본 대회 포인터를 읽을 수 없습니다. RLS 정책을 확인하세요');
  const {rows:[objects]}=await pool.query(`SELECT
    (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A')
      AND tgname IN ('phase5_settlement_immutable','phase5_settlement_items_immutable','phase5_settlement_adjustments_immutable')
      AND tgfoid=to_regprocedure('public.phase5_protect_settlement()')) AS triggers,
    (SELECT bool_and(coalesce(has_sequence_privilege(to_regclass('public.'||seq),'USAGE'),false))
      FROM unnest(ARRAY['daily_execution_log_id_seq','campaign_activity_logs_id_seq',
        'advertising_activity_logs_id_seq','coupon_verification_logs_id_seq']) AS seq) AS sequences`);
  insist(objects.triggers===3&&objects.sequences,'정산 불변성 트리거와 실행 기록 시퀀스 권한을 확인하세요');
}
module.exports={configuration,preflight,required};
