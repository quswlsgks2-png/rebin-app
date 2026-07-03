# Re:Bin PWA v1.2.8 핫픽스 노트

**릴리즈일**: 2026.05.09
**기준 버전**: v1.2.7
**유형**: Critical 버그 픽스 + UX 안정성 강화

## 🔴 Critical 핫픽스

### #1. service-worker 캐시 버전 동기화 (가장 시급)
- **이전 (v1.2.7)**: CACHE_VERSION = 'rebin-v1.2.5' (잠금 상태)
- **수정 (v1.2.8)**: CACHE_VERSION = 'rebin-v1.2.8'
- **영향**: PWA 사용자가 새 코드를 받지 못해 v1.2.6/v1.2.7 신기능 안 보이는 이슈 해결

## 🟡 Important 안정화

### #2. Claude API JSON 파싱 robust 강화
- 자연어 prefix 추가 시 정규식으로 `{ ... }` 추출
- 파싱 실패 시 명확한 에러 메시지 + console 로그
- ```json``` 블록 처리 강화

### #3. 등급 계산 — 0kg 측정 제외
- `weight_kg > 0`인 emission만 카운트
- 빈 봉투 인증 시 가짜 등급 상승 방지

### #4. 카메라 권한 거부 / 잘못된 파일 안내
- 사진 미선택 시 toast 안내 ("권한 확인" 메시지)
- 이미지가 아닌 파일 차단

### #5. 이미지 자동 리사이징 (Canvas)
- 1024px 이내로 자동 축소 (비율 유지)
- JPEG 0.85 품질 (인식에 충분)
- 효과:
  - Anthropic API 5MB 제한 회피
  - 모바일 메모리 절약
  - API 호출 비용 ↓ (입력 토큰 적어짐)
  - 네트워크 비용 ↓

## 📁 변경 파일

| 파일 | 변경 |
|---|---|
| `service-worker.js` | CACHE_VERSION 1.2.5 → 1.2.8 (캐시 무효화) |
| `app.js` | analyzeWaste JSON 파싱 강화 + processImage 신규 (리사이징) + 카메라 권한 안내 |
| `data-layer.js` | APP_VERSION 1.2.8 + getGrade 0kg 필터 |
| `index.html` | 버전 표시 1.2.8 |
| `CHANGELOG_v1.2.8.md` | 핫픽스 노트 |

## 🔄 사용자 마이그레이션

PWA 설치 사용자는 다음 행동으로 새 버전 받음:
1. 앱 새로고침 (자동 service-worker 업데이트)
2. 또는 강제 새로고침 (Ctrl+Shift+R / Cmd+Shift+R)
3. 또는 브라우저에서 service worker unregister

## 🔮 v1.2.9 예정

- 등급 달성 시 toast 축하 (사용자 동기 부여)
- Re:Scan 결과 IndexedDB 저장 (최근 10개 히스토리)
- 설정 화면에 Claude API 키 관리 UI
- 모달 Esc 키 닫기 (접근성)
