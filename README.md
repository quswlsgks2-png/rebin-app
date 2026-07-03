# Re:Bin · 버리는 순간, 보입니다

> IoT 기반 폐기물 데이터·자원순환 인프라 — 봉투 너머의 시민 인프라

[![PWA](https://img.shields.io/badge/PWA-installable-2B8159)](https://web.dev/progressive-web-apps/)
[![Status](https://img.shields.io/badge/Status-Pilot-FFA500)]()

---

## 🚀 빠른 시작

### 사용자

폰에서 아래 URL 접속:

```
https://[your-username].github.io/rebin-app/
```

- **Android Chrome**: 하단 "홈 화면에 추가" 배너 → 탭
- **iPhone Safari**: 공유 → "홈 화면에 추가"

→ 앱처럼 전체 화면으로 작동합니다.

---

## 📋 주요 기능

- ✅ **5단계 회원가입** (지역 자동 매칭)
- ✅ **230여 시군구** 종량제봉투 가격 데이터베이스
- ✅ **감축 등급 사다리** — 누적 GP로 승급·강등하는 영구 5등급 (SEEDLING→DIAMOND)
- ✅ **4단계 자기강화 사이클** — 측정 → 자산화 → 환원 → 참여
- ✅ **환경 임팩트** — CO2 + 나무 + 비용 절감
- ✅ **에코포인트** + 챌린지 + 단지 공동 환원
- ✅ **Re:Scan AI** — 카메라 폐기물 분류
- ✅ **IoT 4단계 시뮬레이션** (LIVE 시연 모드)
- ✅ **PWA** — 오프라인 작동, 홈 화면 설치

## 🎯 4단계 작동 방식

```
1. 🪪 RFID/앱 인증 → 카드 또는 휴대폰 NFC
2. ⚖️ 투입 + 자동 측정 → 로드셀 ±50g 정확도
3. ☁️ 클라우드 전송 → NB-IoT 즉시 전송
4. 📱 앱 자동 갱신 → 배출량·감량률·포인트
```

---

## 📊 데이터 출처 (검증 완료)

| 환산 비율 | 값 | 출처 |
|-----------|-----|------|
| 일반쓰레기 → CO2 | 0.5 kg/kg | 한국대기환경학회지 (Tier 3 한국 실측) |
| 나무 1그루 흡수 | 6.6 kg/년 | 산림청 「표준 탄소흡수량」 (소나무 30년생) |
| 1인당 한도 | 10 kg/월 | 환경부 제6차 폐기물통계조사 |
| 종량제 가격 | 시군구별 | 공공데이터포털 (2026) |

---

## 🛠️ 기술 스택

- **Frontend**: HTML/CSS/JavaScript (Vanilla)
- **Storage**: IndexedDB + localStorage
- **PWA**: Service Worker + Manifest
- **Hardware**: ESP32-S3 + PN532 RFID + HX711 Load Cell + NB-IoT

상세: [HARDWARE_GUIDE.md](prototype/HARDWARE_GUIDE.md)

---

## 🚢 출시 가이드

전체 절차: [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)

### 빠른 요약

1. **GitHub 저장소** 생성 + 코드 업로드 (10분)
2. **GitHub Pages** 활성화 → HTTPS URL 자동 발급 (5분)
3. **폰에서 URL 접속** → 홈 화면 추가 → 앱처럼 사용 (즉시)
4. (선택) **PWABuilder.com** → Android `.aab` 생성 → Google Play 등록 ($25)

---

## 🌱 로드맵

- **2026**: 신청·준비 (현재)
- **2027**: 파일럿 1개 단지 (300세대)
- **2028**: 100개 단지 확장
- **2029+**: PAYT 본격화

---

**버전**: v2.1.0
**최종 빌드**: 2026.5.16
