# GitHub Pages 배포 + 시제품 연결 가이드

## v1.2.0-final 변경사항
- ✅ 폐기물 종류 단일화 (생활폐기물 전용)
- ✅ PN532 hex UID 직접 입력 옵션 (시연용)
- ✅ WebSocket 클라이언트 (`rebin-sync.js`)
- ✅ 서버 미연결 시 graceful degradation
- ✅ 1kg당 5포인트 자동 적립
- ✅ 통합 테스트 29/29 PASS 검증

---

## 1. GitHub Pages 배포 (5분)

```bash
# 1. GitHub 리포지토리 생성 (rebin-app)
# 2. 본 디렉토리 전체를 push
git init
git add .
git commit -m "Re:Bin v1.2.0-final"
git remote add origin https://github.com/USERNAME/rebin-app.git
git push -u origin main

# 3. GitHub Settings → Pages → Source: main / root
# 4. https://USERNAME.github.io/rebin-app/ 배포 자동 완료 (1-2분)
```

---

## 2. 폰에서 PWA 설치

### Android
1. Chrome으로 URL 접속
2. 하단 "홈 화면에 추가" 배너 탭
3. 앱처럼 전체화면 작동

### iPhone
1. Safari로 URL 접속
2. 공유 → "홈 화면에 추가"
3. 아이콘 탭으로 실행

---

## 3. 시제품 연결 시나리오

### A. 데스크톱 시연 (서버 + 펌웨어 + 앱)

```bash
# Terminal 1: 서버 실행 (노트북)
cd prototype/server
npm install
npm start
# → http://192.168.X.Y:3000

# Terminal 2: 펌웨어 빌드 (Arduino IDE)
# - prototype/firmware/rebin_core.ino 열기
# - WIFI_SSID, WIFI_PASSWORD, SERVER_URL 설정
# - ESP32 업로드

# Phone: PWA 앱 설정
# - 회원가입 시 "🔧 시연용 카드 직접 입력" 선택
# - 시리얼 모니터에서 카드 hex UID 확인 (예: 04A52BC3D2)
# - 입력 후 가입 완료
```

### B. 서버 URL 설정 (앱)

기본은 자동 감지. 수동 설정 필요 시 브라우저 콘솔에서:
```javascript
RebinSync.setServerUrl('http://192.168.1.100:3000');
```

### C. 작동 흐름 검증

```
[시리얼 모니터]
  Card detected: 04A52BC3D2
  Weight: 1235g
  POST: {"device_id":"RB-PROTO-01","rfid_uid":"04A52BC3D2","weight_g":1235,"ts":...}
  Response (200): {"ok":true,"id":1,...}

[서버 콘솔]
  [+] 04A52BC3D2 (안성센트럴파크 103-1502): 1235g
  [WS] 04A52BC3D2 connected (subs: 1)

[폰 PWA]
  토스트: "측정됨: 1.24kg"
  홈 화면 자동 갱신
  IndexedDB emissions 저장됨
  +6 포인트 적립
```

---

## 4. 주의사항 (중요)

### CORS 이슈
GitHub Pages(HTTPS) → 노트북 서버(HTTP) 연결 시 브라우저가 차단할 수 있음.

**해결 방안**:

**옵션 1**: 같은 WiFi에서 노트북 IP로 접속
- 폰 Chrome으로 `http://192.168.X.Y:8080` (노트북에서 정적 호스팅)
- 같은 IP 도메인 → CORS 회피

**옵션 2**: ngrok로 서버 HTTPS 터널
```bash
ngrok http 3000
# → https://xxxx.ngrok-free.app 발급
# 이 URL을 RebinSync.setServerUrl()로 설정
```

**옵션 3**: 무료 호스팅 (Render/Railway/Fly.io)
- prototype/server를 서버리스로 배포
- HTTPS 도메인으로 폰 PWA에서 직접 호출

### 시연 영상 촬영용
같은 WiFi + 노트북 IP 직접 접속이 가장 빠릅니다 (옵션 1).

---

## 5. 작동 확인 체크리스트

```
[ ] 1. GitHub Pages 배포 → URL 접속 OK
[ ] 2. 폰에서 홈 화면 추가 OK
[ ] 3. 회원가입 5단계 완료 OK
[ ] 4. 홈 화면 정상 표시 OK
[ ] 5. (시연) 노트북 서버 실행 OK
[ ] 6. (시연) ESP32 펌웨어 업로드 OK
[ ] 7. (시연) RFID 카드 태그 → 인증 음 OK
[ ] 8. (시연) 봉투 측정 → 무게 표시 OK
[ ] 9. (시연) 폰 PWA 자동 갱신 OK
[ ] 10. (시연) 포인트 +N 적립 OK
```

10개 모두 통과 시 시연 영상 촬영 가능.

---

## 6. 폐기물 단일화 확인

회원가입 후 브라우저 콘솔에서:
```javascript
const r = await RebinAPI.addEmission(2.5);
console.log(r.type === 'general' ? '✓ 단일화 OK' : '✗ 단일화 실패');

const stats = await RebinAPI.getStats('2026-05');
console.log('foodKg:', stats.foodKg, 'recycleKg:', stats.recycleKg);
// foodKg: 0, recycleKg: 0 → 단일화 성공
```

---

## 7. 통합 테스트 결과 (자동화)

```
PASS: 29 / 29 (100%)
- 회원가입 + 서버 등록 (4)
- 펌웨어 → 서버 → DB (5)
- WebSocket → 앱 IndexedDB (3)
- 다중 측정 + 통계/포인트 (4)
- 에러 케이스 (4)
- 다중 사용자 격리 (2)
- 환경 임팩트 (3)
- 측정 삭제 + 환수 (2)
- localStorage 영속성 (2)
```

상세: `15_app_integration/tests/full_integration_test.cjs`

---

## 8. 빠른 도움

문제 발생 시:
1. 브라우저 개발자 도구 콘솔 로그 확인
2. 서버 콘솔 로그 확인
3. 시리얼 모니터에서 펌웨어 출력 확인

이 3가지 로그를 보면 어디서 막혔는지 즉시 파악됩니다.
