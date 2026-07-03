# Re:Bin PWA v1.2.9 핫픽스 노트

**릴리즈일**: 2026.05.09
**기준 버전**: v1.2.8
**유형**: 실작동 버그 수정 + 포인트 시스템 명확화

## 🔴 사용자 보고 이슈 → 모두 해결

### #1. 등급 변경 안 됨 → ✅ FIXED
**원인**: `renderHome()`이 배출 후 호출되지만 등급 카드 갱신 코드 없음
**수정**: renderHome 안에서 `window.refreshGradeAndEco()` 자동 호출
**효과**: 배출 즉시 등급 카드 + 누적 임팩트 자동 갱신

### #2. 누적 버튼 안 눌림 → ✅ FIXED (4중 안전장치)
**원인**: 캐시 + IIFE 실행 타이밍
**수정**: HTML body 끝에 inline script로 `setEcoMode` 즉시 정의
**4중 안전장치**:
1. HTML body 끝 inline script (가장 먼저 정의)
2. 인라인 onclick 핸들러
3. addEventListener 직접 바인딩 (DOMContentLoaded + setTimeout)
4. document level 이벤트 위임

### #3. 포인트 일괄 적립 → ✅ FIXED + 명확화
**원인**: `_checkBadges()`가 결과 화면에서 호출되어 7개 배지 동시 적립 가능 (최대 6,850P)
**수정 내용**:
- 배지 자동 클레임 임시 비활성화 (v1.3.0에서 등급제와 통합 예정)
- 등급 도달 시 자동 보너스 추가 (1회만, 명확한 기준)
- 결과 화면 메시지 명확화: "월간 감량 챌린지 달성 시 적립"

## ✨ 신규 — 등급 도달 보너스

| 등급 | 조건 | 자동 보너스 (1회) |
|---|---|---|
| 🌱 SEEDLING | 0회 | — (시작 등급) |
| 🌿 SPROUT | 10회 | **+500P** |
| 🌳 TREE | 50회 | **+2,000P** |
| 🌲 FOREST | 200회 | **+5,000P** |
| 💎 DIAMOND | 1,000회 | **+20,000P** |

**핵심**: 등급 도달 시 1회만 보너스 (중복 적립 X). localStorage에 추적 기록.

## 🎯 새 포인트 적립 흐름 (단순/명확)

```
배출 (1회)
  ↓
등급 카드 자동 갱신
  ↓
[등급 도달 시] +500/+2,000/+5,000/+20,000P 자동 적립
  ↓
[챌린지 달성 시] +1,000/+2,000/+3,000P 자동 적립 (월 1회)
```

**제거된 자동 적립**:
- ❌ 배지 자동 클레임 (7개 동시 적립 방지)
- ❌ 동 단위 순위 (v1.2.6에서 보류)
- ❌ 1kg당 자동 적립 (v1.2.4에서 폐지)

## 📁 변경 파일

| 파일 | 변경 |
|---|---|
| `app.js` | renderHome 등급 갱신 + 배지 자동 클레임 비활성화 + 등급 도달 보너스 시스템 |
| `index.html` | body 끝 inline script (setEcoMode + bindTabs 강화) + 버전 표시 |
| `data-layer.js` | APP_VERSION 1.2.9 |
| `service-worker.js` | CACHE_VERSION 1.2.9 (캐시 무효화) |
| `CHANGELOG_v1.2.9.md` | 핫픽스 노트 |

## 📋 캐시 강제 갱신 안내

PWA 사용자는 새 버전 받으려면:
1. 브라우저 강제 새로고침: `Ctrl+Shift+R` (Win) / `Cmd+Shift+R` (Mac)
2. 또는 개발자 도구 → Application → Service Workers → "Update" / "Unregister"

## 🔮 v1.3.0 예정

- 배지 시스템 → 등급제로 완전 통합 (사용자 결정 후)
- 챌린지 라벨/로직 일치 (개인 베스트 정밀 로직)
- Re:Scan 결과 히스토리 + API 키 관리 UI
