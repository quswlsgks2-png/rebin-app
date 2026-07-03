# Re:Bin PWA v1.3.4 — 5가지 잠재 버그 일괄 수정 ⭐

## 🔴 발견된 진짜 버그들 (v1.2.7부터 잠재)

### Bug #1 (CRITICAL): 필드명 불일치 — `weight_kg` vs `weightKg`
- IndexedDB 저장: `weightKg` (camelCase)
- v1.2.7~v1.3.3 누적/등급 코드: `weight_kg` (snake_case) ← **항상 undefined**
- 결과: 모든 절감량 계산 = 0, 등급 카드 총kg = 0
- **이게 진짜 원인이었음** — 9,850P 적립해도 화면에 절감량 안 보였던 이유
- 수정: `e.weightKg`로 통일

### Bug #2 (CRITICAL): `window.toast` 노출 안 됨
- `toast`는 `ui.js`의 IIFE 안에서 정의되어 `window.UI.toast`로만 접근 가능
- inline script + 일부 app.js 코드가 `window.toast`를 직접 호출 → undefined
- 결과: 누적 버튼 클릭 시 피드백 toast 안 보임 → 사용자가 "안 눌린다" 인식
- 수정: `ui.js`에 `window.toast = UI.toast` 직접 노출 추가

### Bug #3 (Important): `weight_kg` Number 변환 누락
- IndexedDB에서 string으로 저장될 가능성
- `e.weight_kg || 0` → string "5.0" truthy → 문자열 연결 → NaN
- 수정: `Number(e.weightKg) || 0`으로 안전 변환

### Bug #4 (Important): monthlyTarget 안전성
- `goals.monthlyTarget`이 NaN, Infinity, 음수일 경우 처리 X
- 수정: `isFinite + > 0 && < 1000` 범위 검증

### Bug #5 (UX): 한도 초과 시 메시지 부재
- 절감량 0 + 데이터 있을 때 "측정 데이터가 쌓이면..." 잘못된 메시지
- 수정: 한도 초과 케이스 별도 메시지 ("한도 N kg 초과 ⚠️")

## ✨ 새 메시지 (모든 케이스 명확화)

### 이번 달 모드
```
[절감 있음]
📅 2026-05 절감
한도 40kg 중 33.4kg 배출 → 6.6kg 절감 (CO2 3.3kg, 나무 0.5그루)

[한도 초과]
📅 2026-05
한도 40kg 중 50.0kg 배출 — 한도 10.0kg 초과 ⚠️
```

### 누적 모드
```
[절감 있음]
📊 3개월 누적 절감
총 21.6kg 절감 → CO2 10.8kg, 나무 1.64그루 효과

[모든 월 한도 초과]
📊 3개월 누적
한도 초과 — 다음 달 40kg 이하로 줄이면 절감 시작 ⬇️

[데이터 없음]
측정 데이터가 쌓이면 임팩트를 보여드릴게요
```

## 📁 변경 파일

| 파일 | 변경 |
|---|---|
| `data-layer.js` | weight_kg → weightKg, Number 변환, monthlyTarget 안전성, APP_VERSION 1.3.4 |
| `app.js` | 메시지 분기 (절감/초과/없음) |
| `ui.js` | window.toast + window.haptic 직접 노출 |
| `service-worker.js` | CACHE_VERSION 1.3.4 |
| `index.html` | 버전 표시 v1.3.4 |

## 🎯 예상 결과 (사용자 데이터 9,850P + 33.4kg 시)

1. **등급 카드**: 누적 포인트 **9,850**, 총 kg **33.4** (이전: 0/0)
2. **이번 달 절감**: **6.6kg 절감** (CO2 3.3kg, 나무 0.5그루)
3. **누적 절감 (1개월)**: **6.6kg 절감**
4. **누적 버튼 클릭** → toast "누적 모드로 변경 ✓" 명확히 표시
