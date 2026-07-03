# Re:Bin 앱 출시 가이드 — 사용자가 다운받아 사용하기까지

> **PWA → 무료 호스팅 → 폰 설치 → 스토어 등록**까지 단계별 출시 절차
>
> 5/15 신청 마감 전 가능한 가장 빠른 경로 우선 안내

---

## 🎯 출시 옵션 3가지

| 방법 | 소요 시간 | 비용 | 사용자 경험 | 추천도 |
|------|----------|------|------------|--------|
| **① PWA 호스팅** (즉시 사용) | **30분** | **무료** | 폰 홈 화면 추가 → 앱처럼 사용 | ⭐⭐⭐⭐⭐ |
| **② Google Play 등록** | **1~2일** | $25 (1회) | 플레이스토어 다운로드 | ⭐⭐⭐⭐ |
| **③ Apple App Store 등록** | **1~2주** | $99/년 + Mac 필요 | 앱스토어 다운로드 | ⭐⭐⭐ (선택) |

---

# 🚀 옵션 ① PWA 호스팅 (가장 빠른 방법)

## 1단계 — GitHub 무료 호스팅

### 1.1 GitHub 가입 + 저장소 생성

1. **https://github.com** 접속 → 무료 가입
2. 우측 상단 **+ → New repository** 클릭
3. 이름: `rebin-app` (또는 원하는 이름)
4. **Public** 선택 (Pages 무료 호스팅용)
5. **Create repository** 클릭

### 1.2 코드 업로드

방법 A — GitHub Desktop 앱 (권장, 가장 쉬움):

```
1. https://desktop.github.com 다운로드 + 설치
2. File → Clone repository → 방금 만든 rebin-app 선택
3. 다운받은 rebin-app 폴더 안의 모든 파일을 복사
4. Commit summary 입력 → Commit to main
5. Push origin 클릭
```

방법 B — 명령줄:

```bash
cd rebin-app
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/[YOUR_USERNAME]/rebin-app.git
git push -u origin main
```

### 1.3 GitHub Pages 활성화 (HTTPS 자동)

1. GitHub 저장소 → **Settings** 탭
2. 왼쪽 메뉴 **Pages** 클릭
3. **Source**: `Deploy from a branch`
4. **Branch**: `main` / `/ (root)` → **Save**
5. 약 1-2분 후 상단에 **"Your site is live at https://[username].github.io/rebin-app/"** 표시

→ **이 URL이 바로 사용자가 접속할 주소**입니다. HTTPS 인증서 자동 발급, 영구 무료.

## 2단계 — 폰에서 앱처럼 설치

### Android (Chrome)

1. 폰 Chrome 브라우저로 위 URL 접속
2. 화면 하단에 자동으로 **"홈 화면에 Re:Bin 추가"** 배너 표시
3. **추가** 탭 → 홈 화면에 아이콘 생성
4. 아이콘 탭 시 **앱처럼 전체 화면**으로 작동 (브라우저 UI 없음)

### iPhone (Safari)

1. Safari로 URL 접속
2. 하단 **공유 버튼** (네모+화살표 아이콘) 탭
3. **홈 화면에 추가** 선택
4. **추가** 탭 → 홈 화면에 아이콘 생성

→ **이 시점부터 사용자는 "앱"을 사용하는 것과 동일한 경험**.

## 3단계 — 사용자에게 공유

QR 코드 생성:
1. https://www.qr-code-generator.com 접속
2. URL 입력 (예: `https://[username].github.io/rebin-app/`)
3. PNG 다운로드 → 영상/포스터/명함에 인쇄

**시연 영상이나 사업계획서에는 이 QR 코드를 넣으세요.**
→ 검토 위원이 폰으로 스캔 → 즉시 앱 체험 가능.

---

# 📱 옵션 ② Google Play Store 등록

## 사전 준비

- 옵션 ①의 PWA 호스팅 **완료 필수** (HTTPS URL 있어야 함)
- Google 계정
- 신용카드 (개발자 등록비 $25, 1회만)
- 5/15 마감이라면 등록은 마감 후에 진행해도 됨

## 1단계 — PWABuilder로 패키지 생성 (5분)

1. **https://www.pwabuilder.com** 접속
2. 입력란에 PWA URL (예: `https://[username].github.io/rebin-app/`) 입력
3. **Start →** 클릭
4. PWA 점검 점수 확인 (보통 90점 이상이면 OK)
5. **Package For Stores** 버튼 클릭
6. **Android** 선택
7. 옵션 입력:
   - **Package ID**: `kr.rebin.app` (또는 자유)
   - **App name**: `Re:Bin`
   - **Version**: `1.0.0`
   - **Display mode**: `standalone`
   - 나머지 기본값
8. **Generate Package** → ZIP 다운로드 (.aab 파일 포함)

이 ZIP 안에 **Android App Bundle (.aab)** 파일이 있습니다. 이게 플레이 스토어에 업로드할 파일입니다.

## 2단계 — Google Play Console 등록

1. **https://play.google.com/console** 접속
2. **Sign up** → Google 계정 로그인
3. 개발자 계약 동의 → **$25 결제** (1회, 영구)
4. **계정 정보** 입력 (회사명: 본인 이름 또는 향후 법인명)

## 3단계 — 새 앱 만들기

1. Console → **앱 만들기** 클릭
2. **앱 정보**:
   - **앱 이름**: Re:Bin
   - **기본 언어**: 한국어
   - **앱/게임**: 앱
   - **무료/유료**: 무료
3. **선언** 모두 동의 → **만들기**

## 4단계 — 필수 정보 입력

좌측 메뉴에서 다음 항목 모두 작성:

### 4.1 앱 콘텐츠
- **개인정보 처리방침** URL → GitHub Pages에 PRIVACY.md 추가 후 URL 입력
- **광고**: 없음
- **앱 액세스 권한**: 모든 기능이 제한 없이 사용 가능
- **콘텐츠 등급**: 설문 작성 → 자동 결정 (보통 전체 이용가)
- **타겟층**: 만 13세 이상
- **뉴스 앱**: 아니요
- **데이터 보안**: 위치/연락처 등 수집하지 않음 선언

### 4.2 스토어 등록정보 (Main Store Listing)

- **앱 이름**: `Re:Bin`
- **간단한 설명** (80자):
  > 측정에서 시작하는 정직한 종량제. IoT 기반 아파트 일반쓰레기 무게 측정 플랫폼.
- **자세한 설명** (4000자):
  ```
  Re:Bin은 IoT 스마트 쓰레기통과 연결된 PWA 앱입니다.

  ✨ 핵심 기능
  • 가구별 일반쓰레기 무게 자동 측정
  • 환경 임팩트 표시 (CO2 절감 + 나무 그루 효과)
  • 지역별 종량제봉투 가격 기반 비용 절감 계산
  • 230여 시군구 가격 데이터 자동 매칭
  • 에코포인트 적립 + 챌린지

  📊 검증된 데이터
  • CO2 환산: 한국대기환경학회지 (Tier 3 한국 실측, 0.5kg/kg)
  • 나무 흡수: 산림청 표준탄소흡수량 (소나무 30년생 6.6kg/년)
  • 종량제 가격: 공공데이터포털 표준 데이터

  🔒 개인정보 보호
  • 사용자 기기에만 데이터 저장 (파일럿 단계)
  • 외부 광고 없음, 제3자 제공 없음

  🌱 작동 방식
  1. 카드/폰 NFC로 인증
  2. 쓰레기통이 자동으로 무게 측정
  3. 클라우드 통해 앱 자동 갱신
  4. 누적 통계 + 환경 임팩트 확인
  ```
- **앱 아이콘**: `icon-512.png` (manifest.json 안에 있음)
- **그래픽 이미지**: 1024×500 배너 (별도 제작 필요 — Canva 사용)
- **스크린샷**: `screenshots/` 폴더의 PNG 파일들
- **카테고리**: 라이프스타일

### 4.3 개인정보 처리방침
GitHub 저장소에 `PRIVACY.md` 파일 추가:
```markdown
# Re:Bin 개인정보 처리방침

## 수집 항목
- 거주 지역 (시도/시군구)
- 아파트명, 동·호수
- 세대원 수
- RFID 카드 ID
- 배출 무게·시간

## 보관 위치
- 사용자 기기 (브라우저)
- 외부 서버 전송 없음 (파일럿 단계)

## 이용 목적
- 세대별 배출량 통계
- 환경 임팩트 계산

## 제3자 제공
- 없음

## 사용자 권리
- 언제든 설정 → 데이터 초기화로 모든 정보 삭제 가능

## 문의
- [본인 이메일]
```
→ GitHub Pages가 호스팅하므로 URL: `https://[username].github.io/rebin-app/PRIVACY.md`

## 5단계 — 앱 출시

1. **출시 → 프로덕션** 메뉴
2. **새 버전 만들기**
3. **App Bundle**: PWABuilder가 만든 `.aab` 파일 업로드
4. **출시 노트** 작성:
   ```
   v1.0.0 첫 출시
   - 5단계 회원가입 (지역 매칭)
   - 가구별 무게 측정·기록
   - 환경 임팩트 + 비용 절감 표시
   - 230여 시군구 종량제 가격 자동 매칭
   ```
5. **저장 → 출시 검토 시작**
6. Google 검토 (보통 1-3일)
7. **승인 → 플레이 스토어 게시**

---

# 🍎 옵션 ③ Apple App Store 등록 (선택)

## 필요 사항
- **Mac 컴퓨터** (Xcode 필수)
- **Apple Developer Program** 가입 ($99/년)
- iOS는 PWA 직접 등록 불가 → 네이티브 래퍼 필요

## 빠른 경로 — Capacitor 사용

```bash
# Mac에서 (Node.js 18+ 설치 필수)
npm install -g @capacitor/cli
npx cap init Re:Bin kr.rebin.app
npm install @capacitor/core @capacitor/ios

# rebin-app 폴더의 모든 파일을 webDir(www/)에 복사
cp -r rebin-app/* www/

# iOS 프로젝트 생성
npx cap add ios
npx cap sync

# Xcode 열기
npx cap open ios
```

Xcode에서:
1. Bundle Identifier: `kr.rebin.app`
2. Signing Team: 본인 Developer 계정
3. **Product → Archive** → **Distribute App** → App Store Connect 업로드

App Store Connect (https://appstoreconnect.apple.com):
1. 새 앱 등록
2. 메타데이터 (한국어/영어)
3. 스크린샷 업로드 (5.5", 6.7" 둘 다 필요)
4. 심사 제출 → 약 1-2주

---

# 📋 출시 전 최종 체크리스트

## 콘텐츠
- [x] 개인정보 처리방침 작성
- [x] 앱 아이콘 (192/512 + maskable)
- [x] 스플래시 스크린 (manifest 자동 생성)
- [x] 스크린샷 5장 (`screenshots/` 폴더)
- [x] 한국어 설명문
- [ ] 1024×500 그래픽 배너 (Canva로 제작)

## 기능
- [x] HTTPS 작동 (GitHub Pages 자동)
- [x] PWA installable (manifest 검증)
- [x] 오프라인 작동 (Service Worker)
- [x] 모든 메타 태그 (iOS/Android 호환)
- [x] 230여 시군구 가격 데이터
- [x] 5-step 회원가입
- [x] 4단계 IoT 시뮬레이션

## 법적 문서 (출시 후 필요 시)
- [ ] 개인정보 처리방침 URL
- [ ] 이용약관
- [ ] 데이터 보안 신고서 (Play Console)

---

# 💡 사업계획서 영상에 활용할 시나리오

## 검토 위원이 영상 보다가 "앱 한번 써볼까?" 할 때

```
1. 영상에 QR 코드 표시 (10초간)
2. 검토 위원이 폰 카메라로 스캔
3. https://rebin-app.github.io 자동 열림
4. 폰에서 "홈 화면에 추가" 안내 (자동)
5. 검토 위원이 직접 회원가입 → IoT 시뮬레이션 체험
6. 신청서 검토 시 "직접 써봤는데 이렇게 작동하더라" 인상 남김
```

이게 **다른 신청자보다 훨씬 강력한 차별화**입니다. 코드만 있는 게 아니라 **검토 위원이 손으로 직접 만져볼 수 있는 작동하는 앱**.

---

# ⚡ 가장 빠른 5/15 마감 대응 시나리오

**제출 D-7 (5월 8일)**:
1. GitHub 저장소 만들고 코드 업로드 (30분)
2. Pages 활성화 → URL 확보 (10분)
3. 폰에서 직접 설치 테스트 (10분)
4. **사업계획서에 URL + QR 코드 추가**

**제출 D-3 (5월 12일)**:
1. PWABuilder로 .aab 패키지 생성 (5분)
2. Play Console 가입 ($25) — 옵션
3. 영상 마지막에 "지금 다운받아 보세요" QR 표시

**제출 마감 (5/15)**:
- 신청서: PWA URL + QR 코드 모두 포함
- 영상: 검토 위원이 직접 체험 가능 시연

---

# 📞 이슈 해결

## "Pages 활성화했는데 URL 안 들어가요"
→ 5분 정도 기다리세요. GitHub가 빌드 중입니다.

## "iPhone에서 홈 화면 추가 안 보여요"
→ Safari 브라우저로 접속해야 합니다. Chrome iOS는 PWA 미지원.

## "PWABuilder에서 점수 낮아요"
→ manifest.json 검증: https://manifest-validator.appspot.com 사용

## "Play Console 검토 거절"
→ 가장 흔한 이유: 개인정보 처리방침 URL 누락. PRIVACY.md 추가 후 URL 등록.

---

**문서 작성**: 2026.5.6
**관련 파일**:
- `manifest.json` (스토어 메타데이터)
- `screenshots/` (스토어 등록용)
- `service-worker.js` (오프라인 지원)
