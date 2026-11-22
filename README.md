# 가위바위보 LIVE v0.6.0 (모바일 온라인 테스트)

## 변경 사항
- Render 등 Node.js 호스팅의 PORT 및 0.0.0.0 리스닝 지원
- 관리자 페이지와 관리자 명령에 HTTP Basic 인증 적용 (HTTPS에서 사용)
- PLAYER 001부터 참가 순서대로 번호 부여, 초기 최대 200명
- 기존 모바일 화면, 실시간 채팅, 대결 연출, 10초 선택 잠금 유지

## Render 배포
1. 이 폴더의 파일을 새 GitHub 저장소 루트에 업로드 (비밀키/개인정보 업로드 금지).
2. Render.com > New > Web Service > GitHub 저장소 연결.
3. Runtime: Node, Build Command: npm install --omit=dev, Start Command: npm start, Instance: Free (제공되는 경우).
4. Environment에 ADMIN_PASSWORD(12자 이상, 충분히 긴 고유 비밀번호), ADMIN_USER=admin 등록.
5. 배포 완료 후 Render가 실제로 발급한 https://...onrender.com 주소를 참가자에게 공유.
6. 관리자는 https://...onrender.com/admin 접속. 브라우저 인증창에 admin 및 설정한 비밀번호 입력.

## 중요
- 이 버전은 서버 메모리에 참가자/채팅/게임 상태를 보관합니다. 무료 서버가 재시작/휴면되면 데이터가 사라집니다. 정기 운영 전 DB 영속화 필요.
- 무료 서버의 휴면, 동시접속/대역폭 제한, 무료 플랜 제공 여부는 Render 최신 정책 확인 필요.
- 공개 URL을 알면 누구나 참가할 수 있습니다. 지인 테스트에서는 링크 공유 범위를 관리하세요.
- 참가자 토큰은 브라우저에 저장됩니다. 공유기기 이용에 주의하세요.
- 우승 상품 수령 기능은 아직 구현되지 않았습니다.
- 접속 인원 200명은 서버 코드의 최대 등록 수일 뿐, 무료 서버의 동시 접속 성능을 보장하지 않습니다.

## 로컬 테스트
ADMIN_PASSWORD 환경변수 설정 후 npm start (Windows PowerShell: $env:ADMIN_PASSWORD="충분히긴비밀번호"; npm start).


### v0.7.7 참가자별 화면
- 본인 기준 좌측 배치 및 대결 애니메이션 방향 통일
- 최종 우승 / 탈락 상태 메시지 구분
