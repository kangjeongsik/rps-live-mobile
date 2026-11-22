# v0.7.28
- Supabase PostgreSQL 기반 영구 상품 재고 및 지급 기록
- DB 트랜잭션 + advisory lock + unique constraint로 동일 우승자 중복 지급 방지
- 재고 행 FOR UPDATE SKIP LOCKED로 동시 수령 방지
- DATABASE_URL 미설정 시 상품 기능 실패 처리 (파일 저장 대체 없음)
