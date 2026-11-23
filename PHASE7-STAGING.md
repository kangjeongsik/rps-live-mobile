# Phase 7 스테이징 실행안 · v0.13.0

## 소스 대조

phase7-work는 phase6-work v0.13.0의 배포용 사본입니다. 앱 코드와 기존 render.yaml은 동일합니다. 작업 폴더에 Git 메타데이터가 없고 알려진 GitHub 저장소의 현재 브랜치·커밋은 확인되지 않았습니다. 기존 ZIP은 이전 버전 기준입니다. 승인 후 별도 비공개 배포 저장소의 staging/v0.13.0 브랜치 후보에 이 사본을 연결하고 Render에서 같은 Git SHA를 지정합니다. 같은 저장소를 사용한다면 운영 서비스가 이 브랜치를 구독하지 않는지 확인합니다.

| 항목 | 코드 기준 |
| --- | --- |
| 실행 | Node.js >=20, npm install --omit=dev, npm start → node server.cjs, /health |
| Render | 기존 render.yaml은 rps-live-mobile-test 무료 웹과 관리자 변수만 설정합니다. 신규 스테이징은 별도 예시 Blueprint 또는 수동 설정이 필요합니다. |
| 시작 조건 | HTTPS 원본, DB 호스트·이름·로그인, current_user, 읽기 전용 UUID 표식, 역할·RLS·트리거를 검사한 후 기동합니다. |
| SQL | scripts/migrate-local.cjs는 루프백 전용입니다. 클라우드 빈 DB에는 staging/apply-fresh.psql을 사용합니다. |
| DAILY | 인증된 POST /api/v1/daily/run을 사용합니다. 응답 processed는 처리 대상 수이며 실제 개시는 DB opened_at으로 확인합니다. |
| 쿠키·QR | 관리자·직원·쿠폰 소유 쿠키는 Secure, HttpOnly, SameSite=Strict입니다. 쿠폰함은 2분짜리 코드를 QR과 수동 입력 형태로 제공합니다. 카메라에는 BarcodeDetector와 getUserMedia가 필요하며 거부·미지원 시 수동 입력을 사용합니다. |

## 비용과 지역

Render 웹과 DB의 우선 검토 지역은 싱가포르입니다. Render Hobby 워크스페이스, 미국 달러 기준 기본 추정이며 세금, 사용량 초과, 추가 저장공간과 워크스페이스 비용은 별도입니다.

| 구성 | 월 예상 기본료 | 조건 |
| --- | --- | --- |
| Free 웹 + Free Render PostgreSQL | $0 | 수동 검증. 웹은 15분 유휴 시 중단되고 재기동에 약 1분이 걸릴 수 있습니다. DB는 1GB, 30일 만료, 백업 미지원, 워크스페이스당 1개입니다. |
| 위 구성 + Render Cron | $1부터 | 자동 호출과 콜드 스타트 지연 측정. Cron은 유료입니다. |
| 상시 웹 + 유료 Render PostgreSQL + Cron | 약 $14부터 | 웹 $7 + DB $6 + Cron 최소 $1. 저장공간 비용을 별도 확인합니다. 웹 유휴 절전 폐지와 유료 DB PITR을 사용하며 Hobby 복구 기간은 3일입니다. |
| Render 웹 + 별도 Supabase 싱가포르 프로젝트 | Free DB $0, 별도 Pro 플랜 $25부터 | 웹·Cron 별도. Free 프로젝트는 1주 비활성 시 일시 정지될 수 있고 프로젝트 슬롯을 확인해야 합니다. |

[Render 가격](https://render.com/pricing) · [유료 기본 웹·DB 예시](https://render.com/articles/production-rails-hosting-guide) · [Render 무료 제한](https://render.com/docs/free) · [Render Cron](https://render.com/docs/cronjobs) · [Render 복구](https://render.com/docs/postgresql-backups) · [Render 지역](https://render.com/docs/regions) · [Supabase 가격](https://supabase.com/pricing) · [Supabase 지역](https://supabase.com/docs/guides/platform/regions)

## 승인 후 시행 순서

1. 배포용 비공개 저장소와 브랜치, 신규 서비스명, 싱가포르, DB 플랜과 예산을 확정합니다. Render Git 접근을 허용하고 새 서비스의 자동 배포를 끕니다. 예시 Blueprint에는 웹만 있으며 DB와 Cron은 별도입니다.
2. 신규 PostgreSQL 17 인스턴스 또는 별도 Supabase 프로젝트를 준비합니다. 마이그레이션 역할과 별개인 LOGIN 앱 역할에 운영 계정 권한을 상속시키지 않습니다. 앱 역할은 DB 소유자, 슈퍼유저, BYPASSRLS, CREATEROLE을 사용하지 않습니다. 일반 PostgreSQL에 anon, authenticated 역할이 없으면 준비합니다. 운영 데이터를 복사하지 않습니다.
3. 승인한 스테이징 DB의 외부 DNS 전체 주소를 사용하고 인증서 검증을 유지합니다. Render Postgres 내부 주소의 자체 서명 TLS는 현재 앱의 인증서 검증 요구에 맞지 않으므로 fromDatabase 자동 연결과 내부 주소는 사용하지 않습니다. 외부 접속 허용 목록은 스테이징 서비스의 실제 아웃바운드 범위와 관리 주소로 제한합니다. 앱 DATABASE_URL에는 sslmode 등의 TLS 쿼리 옵션을 넣지 않습니다. 필요하면 신뢰할 CA를 SUPABASE_DB_CA에 설정합니다. Supabase 대안은 별도 프로젝트의 IPv4 Session pooler 5432부터 검증하며 STAGING_DB_LOGIN과 실제 current_user를 구분합니다. [Render DB TLS](https://render.com/docs/postgresql-creating-connecting) · [Render 외부 IP](https://render.com/docs/outbound-ip-addresses) · [Supabase 연결](https://supabase.com/docs/guides/database/connecting-to-postgres)
4. 클라우드 SQL 실행을 승인받은 뒤 관리 역할의 psql 세션에서 DB 호스트·이름을 대조합니다. PGHOST, PGPORT, PGDATABASE, PGUSER와 PGSSLMODE=verify-full, 신뢰 루트 CA 설정을 사용하고 비밀번호는 프롬프트나 비밀 저장소에 입력합니다. phase7-work에서 아래 명령을 실행합니다. 세 변수는 승인된 DB 이름, 제한 앱 역할, 새 UUID로 치환합니다.
   ~~~
   psql -X -W -v staging_db=REPLACE_DB -v staging_role=REPLACE_ROLE -v staging_id=REPLACE_UUID -f staging/apply-fresh.psql
   ~~~
   이 실행안은 빈 DB를 확인한 뒤 경품 → v0.7.31 → v0.7.32 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 순서로 원본 SQL 8개를 포함하고 스테이징 표식·권한을 설정합니다. 파일 단위 실행이므로 중간 오류가 나면 적용 상태를 조사합니다. 기존 업무 테이블이 있는 DB는 다시 실행할 수 없습니다.
5. 앱 역할로 아래 읽기 전용 점검을 실행해 marker_matches와 marker_read_only가 참인지 확인합니다. .env.staging.example에 맞춰 실제 비밀값은 Render 설정에만 입력합니다. PUBLIC_ORIGIN은 새 서비스의 정확한 HTTPS 원본입니다. 스테이징 전용 VAPID를 준비하더라도 별도 발송 승인 전에는 DAILY_PUSH_DELIVERY와 STAGING_ALLOW_PUSH를 disabled로 둡니다.
   ~~~
   psql -X -W -v staging_id=REPLACE_UUID -f staging/check-staging.psql
   ~~~
6. 승인된 SHA를 수동 배포합니다. /health의 HTTP 200과 database: up, 관리자 /api/v1/admin/operations의 version 0.13.0을 확인합니다. DB 표식·역할이 틀리면 기동하지 않아야 합니다.

## DAILY 자동 실행과 시범운영

승인 후 Render Cron 또는 별도 스케줄러에서 UTC 0 12 * * * 에 node staging/run-daily.cjs를 실행합니다. Cron은 웹과 같은 배포 SHA를 사용하고 스테이징 STAGING_WEB_ORIGIN과 STAGING_WEB_ORIGIN_CONFIRMED에 같은 HTTPS 원본을 지정합니다. DAILY_SCHEDULER_TOKEN은 웹과 같은 스테이징 전용 비밀값입니다. Cron에는 DB 비밀번호가 필요하지 않습니다. 네트워크·콜드 스타트·일시 오류는 제한적으로 재시도하며 인증 오류·리디렉션은 중단합니다.

예정 시각, 최초 호출 시각, HTTP 성공 시각, DB opened_at, started_at을 기록합니다. staging/check-staging.psql의 seconds_to_open으로 실제 지연을 비교합니다. 수동 실행 시간은 정시 측정에서 제외합니다. 무료 웹의 지연이 합의된 허용 범위를 넘으면 상시 웹으로 재검토합니다.

| 실기기 점검 | Android Chrome | iPhone Safari |
| --- | --- | --- |
| 참가자 예약·퀴즈·미션·협찬 경기·쿠폰 발급과 소유 확인 | 미검증 | 미검증 |
| 매장 로그인·카메라 QR·수동 코드·금액·승인·중복 차단 | 미검증 | 미검증 |
| 관리자 기업·제안·계약·게시·쿠폰·정산 | 미검증 | 미검증 |

가상 카페·매장·직원·참가자만 등록합니다. 기기 모델·OS·브라우저 버전, 21시 지연, 재접속, 스캔·수동 입력, 승인과 데이터 보존 결과를 기록합니다. 실제 광고비 청구와 결제는 하지 않습니다.

비공개 저장소 업로드·브랜치 푸시, Render 생성·배포, 클라우드 DB 생성·SQL 실행, 유료 플랜·Cron 활성화, 실제 푸시, 운영 변경은 승인 후에만 진행합니다.
