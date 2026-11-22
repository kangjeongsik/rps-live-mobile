# v0.7.28 Supabase 영구 저장 설정
1. Supabase 프로젝트 생성 → SQL Editor에서 `supabase-prizes.sql` 실행.
2. Render → 서비스 → Environment → `DATABASE_URL`에 Supabase의 **Postgres 연결 문자열** 입력. 클라이언트에 절대 노출하지 마세요. Supabase 연결 방식에 맞는 SSL 설정을 사용하세요.
3. GitHub에 이 ZIP 내부 파일 업로드 후 Render 재배포.
4. 관리자 화면에서 **가짜 테스트 코드** 2개 등록, 테스트 우승자에게 1개 지급, 중복 수령 시 동일 코드가 반환되는지 확인.
5. Render 재시작 후 관리자 재고·지급 완료 내역이 유지되는지 확인. 경기 참가자·우승 상태 자체는 여전히 서버 메모리에 있어 재시작하면 소실됩니다.
6. **실제 기프트카드는 위 검증과 DB 백업·접근권한 점검 완료 전 등록하지 마세요.**
주의: PIN은 DB에 평문 저장됩니다. DB 관리자 접근 통제와 백업 암호화를 반드시 적용하세요.
