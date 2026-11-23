# v0.13.0 스테이징과 시범운영 준비

이 절차는 신설 스테이징과 로컬 테스트를 위한 것입니다. 운영 연결 문자열, 운영 데이터, 운영 VAPID 키·관리자 비밀값을 옮기지 않습니다. 새로운 회사·매장·직원·참가자·계약은 합성 데이터로 만듭니다.

## DB 및 앱 준비

1. 운영과 별도의 PostgreSQL DB 또는 별도 Supabase 프로젝트를 생성합니다. 연결 호스트·DB 이름·로그인 역할을 관리 콘솔에서 교차 확인합니다. 앱 계정은 로그인 가능한 제한 역할로 만들고 스키마 소유자 및 RLS 우회 역할을 앱에 사용하지 않습니다. 일반 PostgreSQL 테스트 DB에는 기존 SQL이 가정하는 anon, authenticated 역할을 관리자가 먼저 생성합니다.
2. 빈 DB에는 supabase-prizes.sql → supabase-v0.7.31.sql → supabase-v0.7.32.sql → supabase-phase1-events.sql → supabase-phase2-daily.sql → supabase-phase3-campaigns.sql → supabase-phase4-advertising.sql → supabase-phase5-coupons-settlement.sql 순서로 적용합니다. 이미 적용한 DB의 적용 이력을 먼저 확인합니다. 특히 supabase-prizes.sql 의 FK 명령은 이미 실행한 DB에서 그대로 재실행하면 제약 이름 충돌이 발생할 수 있습니다.
3. 확인한 스테이징 DSN에만 마이그레이션 관리 역할로 scripts/staging-identity.sql 을 실행합니다. psql 변수 staging_db, staging_role, staging_id 에는 신설 스테이징 DB 이름, 제한 앱 역할, 새 UUID를 각각 지정합니다. 스크립트는 대상 DB 이름을 확인하고 같은 표식으로 재실행할 수 있습니다. 기존 표식을 새 값으로 바꾸려 하면 중단합니다. 운영에는 이 설정 스크립트를 실행하지 않습니다.
4. .env.staging.example 을 참고해 연결과 HTTPS 호스트, 독립 관리자 계정, 독립 스케줄러 토큰을 스테이징 서비스의 비밀 설정에 입력합니다. STAGING_DB_LOGIN 은 풀러 접속 ID가 DB 역할과 다를 때만 입력합니다. STAGING_DB_ROLE 은 DB에서 보이는 current_user 입니다. PostgreSQL 인증서 검증을 유지하고 프로젝트 CA가 필요하면 SUPABASE_DB_CA 에 입력합니다. 로컬 전용 TLS 예외는 스테이징과 운영에서 거부됩니다.
5. RPS_ENV=staging 에서 URL 허용 대상, DB 내부 식별자, 권한, RLS, 기본 대회 포인터, 시퀀스 및 정산 불변성 트리거를 검사합니다. 연결·설정 검사에 실패하면 웹 포트를 열거나 일정 작업을 시작하기 전에 프로세스가 종료됩니다. 일반 운영 모드에는 검증된 운영 HTTPS 원본과 운영 DB URL을 별도로 설정하며 스테이징 표식이 있는 DB는 거부됩니다.
6. VAPID는 스테이징 전용 키 쌍을 사용합니다. 발송 기본값은 꺼짐입니다. 합성 테스트 구독만 준비한 뒤 스테이징에서 발송 승인을 별도로 받으면 STAGING_ALLOW_PUSH=enabled 및 DAILY_PUSH_DELIVERY=enabled 를 설정합니다. 일반 공급자 HTTPS 푸시 호스트만 허용합니다. 추가 공급자가 필요하면 소유 주체와 호스트를 검토한 뒤 PUSH_ALLOWED_HOSTS 에 정확한 호스트만 지정합니다.

## Render 서비스와 DAILY 실행

별도 Render Web Service에서 phase6-work 내용이 들어 있는 스테이징 브랜치를 연결합니다. Build Command는 npm install --omit=dev, Start Command는 npm start, HTTP Health Check Path는 /health 입니다. 자동 배포와 기존 운영 서비스의 설정 변경은 별도로 승인받습니다. 초기 검증은 웹 인스턴스 1개에서 수행합니다. SSE 구독과 관리자 시도 제한, 프로세스 집계 지표는 현재 웹 인스턴스에 귀속됩니다.

21:00 KST는 12:00 UTC입니다. 승인 후 별도 스테이징 Cron 또는 외부 스케줄러의 0 12 * * * 실행에서 POST /api/v1/daily/run 을 호출합니다. 전용 DAILY_SCHEDULER_TOKEN 을 HTTPS Bearer 헤더로 전달하며 값은 스케줄러의 비밀 설정에 보관합니다. 헤더와 URL 토큰을 로그에 남기지 않습니다. 토큰은 최소 32자이며 운영 토큰과 분리합니다. 일시 장애는 제한된 재시도로 처리합니다. 같은 날짜의 중복 실행은 PostgreSQL 제약과 상태 전이로 안전하게 처리됩니다.

무료 Render 웹 서비스는 유휴 시 중단되고 재기동에 시간이 걸릴 수 있습니다. 시범운영 전 21시 HTTP 응답 시각, DB 상의 DAILY open 시각 및 차이를 측정합니다. 충분한 정시성이 필요하면 스테이징에서 사전 기동 또는 상시 가동 서비스의 설정을 검토합니다. 준비 지연 시 기존 시간 정책에 따라 회차를 준비하거나 대기 한도를 지난 회차를 만료 처리합니다.

Render 공식 문서
- https://render.com/docs/free
- https://render.com/docs/cronjobs
- https://render.com/docs/health-checks

## 운영 점검과 장애 복구

- 공개 GET /health 는 DB 정상 시 200, 연결 장애 시 503을 반환합니다. DB 주소와 오류 세부값은 반환하지 않습니다. 관리자 GET /api/v1/admin/operations 에서 기동 시간, 최근 스케줄러 실행·성공·실패 시각, DAILY 처리 회차 수, 캠페인·쿠폰 승인·정산 요청 집계를 확인합니다.
- 프로세스 집계는 재시작 시 초기화됩니다. 이후 일정 실행, 쿠폰 승인·취소 및 확정 정산은 기존 DB 감사 이력으로 확인합니다. DB 오류가 지속되면 먼저 상태와 연결 권한을 확인합니다.
- 승인 응답 유실은 같은 요청 ID·코드·금액으로 복구합니다. 이미 확정된 정산 재요청은 같은 정산서를 반환합니다. 모니터링 및 로그에 인증 토큰, 쿠폰 코드, 연결 문자열을 남기지 않습니다.
- DAILY·협찬 토너먼트는 기존 PostgreSQL 상태를 복구합니다. 별도 진입점인 / 의 진행자 상대 레거시 게임은 진행 상태가 메모리에 있으므로 재시작 시 초기화됩니다. 시범운영에서 재시작 복구가 필요한 경기에는 저장형 토너먼트 경로를 사용합니다.

## 재현 가능한 로컬 검증

1. 별도의 루프백 PostgreSQL 17에 rps_local_ 로 시작하는 빈 합성 DB를 준비하고 anon 및 authenticated 역할을 생성합니다.
2. RPS_LOCAL_MIGRATION_DB 와 RPS_LOCAL_MIGRATION_DSN 에 명시한 DB 이름과 루프백 DSN을 설정하고 node scripts/migrate-local.cjs 를 실행합니다. 실행기는 마이그레이션별 트랜잭션과 체크섬을 관리합니다. 다시 실행하면 기존 파일을 건너뛰고, 같은 이름의 파일 변경이나 기존 미추적 스키마를 감지하면 중단합니다.
3. RPS_E2E_DSN 을 해당 루프백 합성 DB에 설정하고 node tests/phase6-integration.cjs 를 실행합니다. 선택적으로 RPS_E2E_MAINTENANCE_DSN 을 같은 인스턴스의 postgres 관리 DB로 설정하면 테스트 DB 접속 차단·복구를 검증합니다. 이 검사는 해당 로컬 합성 DB에서만 실행합니다. 같은 DB에서 반복할 때는 별도의 빈 합성 DB를 새로 준비합니다.
4. 카메라를 사용하는 실기기 검증은 HTTPS 스테이징에서 아래 표와 같이 진행합니다.

| 점검 | 방법 |
|---|---|
| Android Chrome | QR 권한 허용·거부, 코드 입력 대체, 360~430px, 승인 후 상태 갱신 확인 |
| iPhone Safari | 같은 흐름 확인. QR API 미지원 시 수동 코드 입력으로 승인까지 진행 |
| 스테이징 로그인·재접속 | 참가·직원 세션의 새로고침·뒤로 가기·만료, 쿠폰 2분 만료 경계, 소유 확인 |
| 시범운영 승인 | 운영자·매장 담당자가 현장 QR 및 POS/영수증 확인 절차를 검증한 뒤 진행 |
