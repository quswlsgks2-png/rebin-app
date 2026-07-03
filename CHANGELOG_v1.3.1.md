# Re:Bin PWA v1.3.1 디버깅 강화

**릴리즈일**: 2026.05.09
**유형**: 작동 검증 + 자동 갱신 메커니즘

## 🎯 사용자 보고 → 디버깅 강화

### #1. 등급 누적 포인트 카운트 안 됨
**진짜 원인 추정**: 사용자 화면이 v1.3.0 코드를 못 받음 (캐시 문제)
**v1.3.1 조치**:
- `renderGradeCard`에 명시적 console.log 추가
- DOM 요소 미존재 시 명확한 경고 메시지
- 콘솔에서 작동 여부 확인 가능

### #2. 환경 임팩트 누적 버튼 안 눌림
**진짜 원인 추정**: 캐시 + setEcoMode 정의 충돌
**v1.3.1 조치**:
- `_renderEcoImpactReal`을 글로벌로 명시 노출 (inline script가 직접 호출 가능)
- 클릭 시 toast 피드백 추가 ("누적 모드로 변경 ✓")
- mode 인자를 `window._ecoMode`에 저장 후 fallback에서도 사용
- console.log로 작동 흐름 추적

## ✨ 신규 — service-worker 자동 reload

새 버전 감지 시 자동으로 페이지 reload (controllerchange 이벤트):
```javascript
navigator.serviceWorker.addEventListener('controllerchange', () => {
  window.location.reload();
});
```

→ 사용자가 강제 새로고침 안 해도 새 버전 자동 적용.

## 🛠 사용자 디버깅 가이드

### 작동 확인 방법

1. **개발자 도구 열기** (F12 또는 우클릭 → 검사)
2. **Console 탭** 선택
3. PWA 사용 시 다음 로그 확인:
   - `[Re:Bin v1.3.1] setEcoMode called: total` ← 누적 클릭 시
   - `[Re:Bin v1.3.1] renderEcoImpact mode: total`
   - `[eco] data: total {kg, co2, trees}`
   - `[Re:Bin v1.3.1] grade: SEEDLING / 0 P / 다음: 10000 P`

### 로그 안 보일 경우 (이전 버전 캐시 중)

1. **개발자 도구 → Application 탭**
2. **Service Workers → "Update" 또는 "Unregister"**
3. **Cache Storage → 모든 항목 삭제**
4. 페이지 새로고침 (자동 reload 작동)

또는 **시크릿/익명 모드**로 새로 접속 (캐시 X)

## 📁 변경 파일

| 파일 | 변경 |
|---|---|
| `app.js` | renderEcoImpact + renderGradeCard 디버깅 로그 + window._renderEcoImpactReal 노출 |
| `index.html` | inline script 강화 (toast + console.log + 자동 reload) + 버전 |
| `data-layer.js` | APP_VERSION 1.3.1 |
| `service-worker.js` | CACHE_VERSION 1.3.1 |
| `CHANGELOG_v1.3.1.md` | 이 파일 |
