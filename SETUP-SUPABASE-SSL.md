# v0.7.30 Supabase SSL CA 설정 (Render)

1. Supabase 프로젝트 → **Project Settings → Database**에서 SSL / CA certificate 항목을 찾습니다. UI가 변경된 경우 Connect → Connection settings 또는 Database 설정의 SSL certificate 항목을 확인하세요.
2. **Download CA certificate**로 PEM 인증서를 다운로드합니다. 인증서가 제공되지 않는 경우 Supabase 공식 지원 문서를 통해 해당 프로젝트의 인증서 발급/체인을 확인하세요. 다른 사이트에서 임의 인증서를 가져오지 마세요.
3. 인증서 파일을 텍스트 편집기로 열고 `-----BEGIN CERTIFICATE-----`부터 `-----END CERTIFICATE-----`까지 전체 내용을 복사합니다.
4. Render → 서비스 → Environment → Add Environment Variable:
   - KEY: `SUPABASE_DB_CA`
   - VALUE: 위 인증서 PEM 전체. 줄바꿈을 유지하거나 `\n`으로 붙여 넣을 수 있습니다.
5. 기존 `DATABASE_URL`, `ADMIN_USER`, `ADMIN_PASSWORD`는 유지하고 **Save, deploy**합니다.
6. 관리자 화면에서 가짜 테스트 카드 `TEST-GOOGLE-001`을 등록한 뒤 **재고 새로고침**으로 확인합니다.

주의:
- SSL 검증을 끄는 `PGSSL=disable` 등의 설정은 사용하지 않습니다.
- DB 접속 URL은 비밀번호가 포함된 비밀값입니다. 공유하지 마세요.
- `SUPABASE_DB_CA`는 CA 공개 인증서이지만 Render 환경변수에 보관하여 프로젝트별 관리가 쉽도록 했습니다.
- 인증서 갱신 시 이 환경변수도 교체해야 합니다.
- DB 연결에 성공해도 실제 카드 지급은 테스트 및 접근통제 점검 완료 후 시작하세요.
