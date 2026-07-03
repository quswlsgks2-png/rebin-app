/**
 * Re:Bin Data Layer v1.2.6
 * 
 * 주요 수정 사항:
 * - 타임존 버그 수정 (로컬 기준 month 저장)
 * - _prevMonth / relMonths 월말 보정 (setDate(1) 우선)
 * - 단지 순위 1~totalUnits 범위 클램프
 * - 챌린지 보너스 외부 호출 가능 메서드 분리
 * - 폐기물 종류 단일화 (생활폐기물 전용)
 * - v1.2.4: 1kg당 자동 포인트 지급 폐지 → 배지/챌린지/동순위로만 적립
 * - import 시 테마/언어 보존
 * - crypto.randomUUID() 기반 ID
 * - 단지 평균 사용자 데이터 기반 동적 계산
 */

const RebinAPI = (function () {
  'use strict';

  const APP_VERSION = '2.6.0';
  const DB_NAME = 'rebin_db';
  const DB_VERSION = 1;
  const NS = 'rebin_';

  const KEYS = {
    USER: NS + 'user',
    POINTS: NS + 'points',
    SETTINGS: NS + 'settings',
    NOTIFICATIONS: NS + 'notifications',
    ONBOARDED: NS + 'onboarded',
    THEME: NS + 'theme',
    PILOT_BANNER: NS + 'pilot_banner_dismissed',
    INSTALL_DISMISS: NS + 'install_dismissed',
    BADGES: NS + 'badges',
    GOALS: NS + 'goals',
    APP_VERSION: NS + 'app_version',
    LANG: NS + 'lang',
    CONSENT: NS + 'consent',
    DEV_MODE: NS + 'dev_mode',
  };

  // Import에서 보존할 키 (사용자 환경 설정)
  // import 시 보존되는 키 (사용자 환경 설정 + PIPA 동의)
  const PRESERVE_ON_IMPORT = [
    KEYS.THEME, KEYS.LANG, KEYS.PILOT_BANNER, KEYS.INSTALL_DISMISS,
    KEYS.CONSENT,  // PIPA: 동의 기록은 사용자 본인 행위이므로 import 후 유지
  ];

  // 1kg당 자동 포인트 지급 제거 (v1.2.4) — 감량 행동에 보상하는 정책으로 전환
  // 포인트는 배지(일회성) + 챌린지(월간 감량) + 동 단위 순위로만 적립
  const POINTS_PER_KG = 0;
  const POINTS_BY_TYPE = { general: 0 };  // legacy compat

  // ============================================================
  // 백서 v2.0 — 감축 등급 (영구 사다리형)
  // 베이스라인(설치 후 첫 3개월 평균) 대비 매월 감축률로 GP(등급 점수)를
  // 적립·차감하여 누적 승급/강등. 등급명은 환경 이미지에 맞춰
  // SEEDLING~DIAMOND 자연 단계로 표현.
  //  - 승급 간격이 점증(3→5→7→10)하여 위로 갈수록 어려움
  //  - 감축 없는 달은 -1 GP로 강등될 수 있음
  // ============================================================
  const GRADE_LADDER = [
    { key: 'seedling', name: 'SEEDLING', emoji: '🌱', desc: '새싹 — 감축 여정 시작',     color: '#9DD9C7', minGP: 0,  point: [0, 0] },
    { key: 'sprout',   name: 'SPROUT',   emoji: '🌿', desc: '새싹 자람 — 감축 습관',     color: '#5DCAA5', minGP: 3,  point: [200, 500] },
    { key: 'tree',     name: 'TREE',     emoji: '🌳', desc: '나무 — 꾸준한 감축',        color: '#1D9E75', minGP: 8,  point: [500, 1500] },
    { key: 'forest',   name: 'FOREST',   emoji: '🌲', desc: '숲 — 환경 영웅',            color: '#0F6E56', minGP: 15, point: [1500, 3000] },
    { key: 'diamond',  name: 'DIAMOND',  emoji: '💎', desc: '다이아몬드 — 감축 레전드',   color: '#85B7EB', minGP: 25, point: [3000, 5000] },
  ];

  // 월 감축률 → 그 달의 GP 증감 (매월 정산)
  //  30%+ → +3 / 15~30% → +2 / 5~15% → +1 / 0~5% → 0(유지) / 감축없음 → -1(강등)
  function monthGP(reductionPct) {
    if (reductionPct >= 30) return 3;
    if (reductionPct >= 15) return 2;
    if (reductionPct >= 5)  return 1;
    if (reductionPct >= 0)  return 0;
    return -1;
  }

  // ============================================================
  // localStorage 안전 래퍼
  // ============================================================
  const Local = {
    get(key, fallback = null) {
      try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
      } catch (e) {
        return fallback;
      }
    },
    set(key, val) {
      try {
        localStorage.setItem(key, JSON.stringify(val));
        return true;
      } catch (e) {
        console.warn('[Local] set failed', e);
        return false;
      }
    },
    remove(key) {
      try { localStorage.removeItem(key); return true; }
      catch { return false; }
    },
    has(key) {
      try { return localStorage.getItem(key) !== null; }
      catch { return false; }
    },
  };

  // ============================================================
  // IndexedDB
  // ============================================================
  let dbInstance = null;
  let dbInitPromise = null;

  function openDB() {
    if (dbInstance) return Promise.resolve(dbInstance);
    if (dbInitPromise) return dbInitPromise;
    dbInitPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { dbInstance = req.result; resolve(dbInstance); };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('emissions')) {
          const store = db.createObjectStore('emissions', { keyPath: 'id' });
          store.createIndex('date', 'date', { unique: false });
          store.createIndex('month', 'month', { unique: false });
          store.createIndex('type', 'type', { unique: false });
        }
      };
    });
    return dbInitPromise;
  }

  async function dbAdd(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('emissions', 'readwrite');
      const req = tx.objectStore('emissions').add(record);
      req.onsuccess = () => resolve(record);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbAddBulk(records) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('emissions', 'readwrite');
      const store = tx.objectStore('emissions');
      tx.oncomplete = () => resolve(records.length);
      tx.onerror = () => reject(tx.error);
      records.forEach(r => store.add(r));
    });
  }

  async function dbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('emissions', 'readwrite');
      const req = tx.objectStore('emissions').delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetById(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('emissions', 'readonly');
      const req = tx.objectStore('emissions').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('emissions', 'readonly');
      const req = tx.objectStore('emissions').getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.date.localeCompare(a.date)));
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetByMonth(month) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('emissions', 'readonly');
      const idx = tx.objectStore('emissions').index('month');
      const req = idx.getAll(IDBKeyRange.only(month));
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.date.localeCompare(a.date)));
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetByMonthRange(monthFrom, monthTo) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('emissions', 'readonly');
      const idx = tx.objectStore('emissions').index('month');
      const req = idx.getAll(IDBKeyRange.bound(monthFrom, monthTo));
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.date.localeCompare(a.date)));
      req.onerror = () => reject(req.error);
    });
  }

  async function dbCount() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('emissions', 'readonly');
      const req = tx.objectStore('emissions').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbClear() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('emissions', 'readwrite');
      const req = tx.objectStore('emissions').clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ============================================================
  // 검증
  // ============================================================
  const Validate = {
    weight(kg) {
      const n = parseFloat(kg);
      if (isNaN(n)) throw new Error('무게가 올바르지 않습니다');
      if (n <= 0) throw new Error('무게는 0보다 커야 합니다');
      if (n < 0.05) throw new Error('무게는 최소 0.05kg 이상이어야 합니다');  // 반올림 후 0이 되는 입력 차단
      if (n > 50) throw new Error('단일 배출량은 50kg 이하여야 합니다');
      return Math.round(n * 100) / 100;
    },
    members(n) {
      const num = parseInt(n);
      if (isNaN(num) || num < 1 || num > 10) {
        throw new Error('세대원 수는 1~10명 사이여야 합니다');
      }
      return num;
    },
    type(t) {
      if (t && t !== 'general') console.warn('[Re:Bin] 일반쓰레기(생활폐기물)만 지원합니다');
      return 'general';
    },
    /**
     * 텍스트 필드 길이 검증 + sanitize.
     * 클라이언트 maxlength는 JS로 우회 가능하므로 API 레이어에서 enforce.
     */
    text(value, opts = {}) {
      const { min = 1, max = 50, name = '값' } = opts;
      if (value == null) throw new Error(`${name}이(가) 비어있습니다`);
      const trimmed = String(value).trim();
      if (trimmed.length < min) throw new Error(`${name}을(를) 입력해주세요`);
      if (trimmed.length > max) throw new Error(`${name}은(는) 최대 ${max}자까지 입력 가능합니다`);
      return trimmed;
    },
  };

  // ============================================================
  // 시간 헬퍼 — 모두 로컬 시간 기준
  // ============================================================
  function pad2(n) { return String(n).padStart(2, '0'); }

  function localYearMonth(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
  }

  function currentMonth() {
    return localYearMonth();
  }

  /**
   * 안전한 이전 N개월 계산 (월말 보정)
   * setDate(1)을 먼저 부르지 않으면 5/31 → setMonth(4) → 4/31 → 5/1로 되돌아감
   */
  function relativeMonth(monthsBack) {
    const d = new Date();
    d.setDate(1);  // 월말 보정 핵심
    d.setMonth(d.getMonth() - monthsBack);
    return localYearMonth(d);
  }

  function prevMonth() {
    return relativeMonth(1);
  }

  function genId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return 'e_' + crypto.randomUUID();
    }
    return 'e_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  // ============================================================
  // 마이그레이션
  // ============================================================
  function runMigrations() {
    const cur = Local.get(KEYS.APP_VERSION, '0.0.0');
    if (cur === APP_VERSION) return;

    // v0.x / v1.0.0 → v1.1.0
    // v1.0.0의 month 필드가 UTC 기준이었던 데이터를 로컬 기준으로 재계산
    if (cur.startsWith('0.') || cur === '1.0.0') {
      // 비동기지만 순서 중요하지 않음, 백그라운드에서 처리
      (async () => {
        try {
          const all = await dbGetAll();
          if (all.length === 0) return;
          const db = await openDB();
          const tx = db.transaction('emissions', 'readwrite');
          const store = tx.objectStore('emissions');
          all.forEach(record => {
            const correctMonth = localYearMonth(new Date(record.date));
            if (record.month !== correctMonth) {
              record.month = correctMonth;
              store.put(record);
            }
          });
        } catch (e) {
          console.warn('[Migration] month recompute failed', e);
        }
      })();

      // 이전 키 정리 (v0.x)
      if (cur.startsWith('0.')) {
        ['rebin_v1_user', 'rebin_v1_points', 'rebin_v1_onboarded', 'rebin_v1_notifications'].forEach(k => {
          const v = Local.get(k);
          if (v != null) {
            if (k.endsWith('user')) Local.set(KEYS.USER, v);
            else if (k.endsWith('points')) Local.set(KEYS.POINTS, v);
            else if (k.endsWith('onboarded')) Local.set(KEYS.ONBOARDED, v);
            else if (k.endsWith('notifications')) Local.set(KEYS.NOTIFICATIONS, v);
            Local.remove(k);
          }
        });
      }
    }

    Local.set(KEYS.APP_VERSION, APP_VERSION);
  }

  // ============================================================
  // PUBLIC API
  // ============================================================
  const API = {
    config: {
      mode: 'mock',
      apiBase: 'https://api.rebin.kr/v1',
      deviceId: null,
      version: APP_VERSION,
      stage: 'pilot',
    },

    KEYS,
    Local,
    Validate,

    // ===== 초기화 =====
    async init() {
      runMigrations();
      try { await openDB(); }
      catch (e) { console.warn('[init] IndexedDB 초기화 실패', e); }
      return true;
    },

    // ===== 시간 헬퍼 (외부 사용) =====
    currentMonth() { return currentMonth(); },
    relativeMonth(n) { return relativeMonth(n); },
    prevMonth() { return prevMonth(); },

    // ===== 온보딩 =====
    isOnboarded() { return Local.get(KEYS.ONBOARDED, false); },

    async completeOnboarding(info) {
      const members = Validate.members(info.members);

      // ★ Patch: 카드 타입에 따라 rfidId 결정
      let rfidId;
      if (info.cardType === 'physical_actual' && info.actualRfid) {
        rfidId = info.actualRfid.toUpperCase().replace(/[^0-9A-F]/g, '');
        if (rfidId.length < 8 || rfidId.length > 14) {
          throw new Error('PN532 RFID UID는 8-14자 hex여야 합니다');
        }
      } else {
        rfidId = 'U' + Date.now().toString(36).toUpperCase();
      }

      const validated = {
        rfidId,
        apartment: Validate.text(info.apartment, { name: '아파트명', max: 30 }),
        dong: Validate.text(info.dong, { name: '동', max: 6 }),
        ho: Validate.text(info.ho, { name: '호수', max: 6 }),
        members,
        baseLimit: 10 * members,
        region: info.region || null,
        cardType: info.cardType || 'mobile_nfc',
        cardRequestedAt: info.cardType === 'physical' ? new Date().toISOString() : null,
        actualRfidProvided: info.cardType === 'physical_actual',
        joinedAt: new Date().toISOString(),
      };
      Local.set(KEYS.USER, validated);
      Local.set(KEYS.ONBOARDED, true);
      Local.set(KEYS.POINTS, { total: 0, sources: {} });
      Local.set(KEYS.GOALS, { monthlyTarget: 20 });
      return validated;
    },

    // ===== 사용자 =====
    async getUser() { return Local.get(KEYS.USER); },

    async updateUser(patch) {
      const cur = await this.getUser();
      if (!cur) throw new Error('사용자 정보가 없습니다');
      const updated = { ...cur };
      // 각 필드 검증
      if (patch.apartment != null) updated.apartment = Validate.text(patch.apartment, { name: '아파트명', max: 30 });
      if (patch.dong != null) updated.dong = Validate.text(patch.dong, { name: '동', max: 6 });
      if (patch.ho != null) updated.ho = Validate.text(patch.ho, { name: '호수', max: 6 });
      if (patch.members != null) {
        updated.members = Validate.members(patch.members);
        updated.baseLimit = 10 * updated.members;
      }
      Local.set(KEYS.USER, updated);
      return updated;
    },

    // ===== 배출 기록 =====
    async getEmissions(filter = {}) {
      if (filter.month) return await dbGetByMonth(filter.month);
      if (filter.year) {
        return await dbGetByMonthRange(`${filter.year}-01`, `${filter.year}-12`);
      }
      return await dbGetAll();
    },

    async addEmission(weightKg, opts = {}) {
      const validated = Validate.weight(weightKg);
      const type = Validate.type(opts.type || 'general');
      const now = new Date();
      const record = {
        id: genId(),
        date: now.toISOString(),       // ISO (정렬·표시용)
        month: localYearMonth(now),    // ★ 로컬 YYYY-MM (조회용)
        weightKg: validated,
        type,
        source: opts.source || 'manual',
        deviceId: this.config.deviceId,
      };
      await dbAdd(record);

      // ✗ 1kg당 자동 포인트 지급 제거 (v1.2.4)
      // ✗ _checkBadges도 결과 화면에서 호출 (newlyEarned 정확히 받기 위해)
      // 챌린지 자동 적립 체크는 여기서 (결과 화면 표시 전)
      await this.tryClaimChallenge();
      // v1.2.5: 동 단위 순위 보너스도 자동 적립 (월 1회)
      await this.tryClaimDistrictBonus();

      return record;
    },

    /**
     * 일괄 등록 — 시뮬레이터/테스트용
     * 배지·챌린지 검사는 마지막에 한 번만
     */
    async addEmissionsBulk(records) {
      const prepared = records.map(r => ({
        id: genId(),
        date: r.date instanceof Date ? r.date.toISOString() : r.date,
        month: localYearMonth(new Date(r.date)),
        weightKg: Validate.weight(r.weightKg),
        type: Validate.type(r.type || 'general'),
        source: r.source || 'sim',
        deviceId: this.config.deviceId,
      }));
      await dbAddBulk(prepared);
      // ✗ v1.2.4: 1kg당 자동 포인트 지급 제거
      // 배지/챌린지/동순위 자동 검사로 보너스 포인트 적립
      await this._checkBadges();
      // 챌린지 자동 적립 — addEmission(개별)과 동일한 흐름
      await this.tryClaimChallenge();
      return prepared.length;
    },

    /**
     * 개별 배출 기록 삭제
     * v1.2.4: 자동 포인트 없으니 환수도 없음. 단, 배지/챌린지로 적립된 포인트는 유지.
     */
    async deleteEmission(id) {
      const record = await dbGetById(id);
      if (!record) throw new Error('해당 기록을 찾을 수 없습니다');
      await dbDelete(id);
      // ✗ v1.2.4: 자동 포인트 환수 로직 제거
      return { record, pointsRefunded: 0 };
    },

    async getMonthlyTotal(month = null) {
      if (!month) month = currentMonth();
      const list = await this.getEmissions({ month });
      return list.reduce((sum, e) => sum + e.weightKg, 0);
    },

    async getCount(month = null) {
      if (!month) month = currentMonth();
      const list = await this.getEmissions({ month });
      return list.length;
    },

    async getMonthlyChange() {
      const cur = await this.getMonthlyTotal(currentMonth());
      const prev = await this.getMonthlyTotal(prevMonth());
      if (prev === 0) return null;
      return Math.round(((cur - prev) / prev) * 100);
    },

    async getWeeklyBreakdown(month = null) {
      if (!month) month = currentMonth();
      const list = await this.getEmissions({ month });
      const weeks = [0, 0, 0, 0, 0];
      list.forEach(e => {
        const d = new Date(e.date);
        const wk = Math.min(4, Math.floor((d.getDate() - 1) / 7));
        weeks[wk] += e.weightKg;
      });
      return weeks.map(kg => Math.round(kg * 10) / 10);
    },

    async getHourlyPattern(monthsBack = 3) {
      const monthFrom = relativeMonth(monthsBack);
      const monthTo = currentMonth();
      const list = await dbGetByMonthRange(monthFrom, monthTo);
      const hours = new Array(24).fill(0);
      list.forEach(e => {
        const h = new Date(e.date).getHours();
        hours[h] += 1;
      });
      return hours;
    },

    async getYearReport(year = null) {
      if (!year) year = new Date().getFullYear();
      const list = await this.getEmissions({ year });
      const byMonth = new Array(12).fill(0);
      let total = 0;
      list.forEach(e => {
        // 로컬 month 기준 (e.month는 'YYYY-MM')
        const m = parseInt(e.month.slice(5, 7)) - 1;
        if (m >= 0 && m < 12) {
          byMonth[m] += e.weightKg;
          total += e.weightKg;
        }
      });
      return {
        year,
        total: Math.round(total * 10) / 10,
        count: list.length,
        byMonth: byMonth.map(kg => Math.round(kg * 10) / 10),
        avg: list.length > 0 ? Math.round((total / list.length) * 100) / 100 : 0,
      };
    },

    /**
     * 환경 임팩트 계산 — 한국 실측 기반 정직한 환산
     *
     * 환산비 (한국 정부 공식 인벤토리 방식):
     * - 일반쓰레기 1kg 소각 → CO2 약 0.5kg
     *   (한국대기환경학회지, 김병순 외 2010 — 한국 생활폐기물 소각시설 실측 Tier 3)
     *   ※ 환경부 국가 온실가스 인벤토리는 화석연료 기원 CO2만 포함
     *      (생물기원 — 음식물/종이/목재 — 은 자연순환으로 간주 미포함)
     *      → 일반쓰레기 중 플라스틱·고무·섬유 등의 화석탄소만 카운트
     * - 나무 1그루 연간 CO2 흡수량: 6.6kg
     *   (산림청 국립산림과학원 「주요 산림수종의 표준 탄소흡수량」 (2019)
     *    30년생 소나무 1그루 기준)
     *
     * 원칙:
     * 1. 일반쓰레기(general)만 baseLimit 비교에 사용
     *    (음식물은 별도 RFID 종량제, 재활용은 분리배출 무료)
     * 2. 월 진행률 30% 미만이면 "데이터 누적 중" 안내
     * 3. 한도 정확히 도달/초과 별도 메시지
     */
    async getCarbonImpact() {
      const user = await this.getUser();
      if (!user) return { hasData: false };

      const monthlyCount = await this.getCount();
      if (monthlyCount === 0) {
        return { hasData: false, status: 'empty', message: '측정 데이터가 쌓이면 임팩트를 보여드릴게요' };
      }

      // type별 분리
      const list = await this.getEmissions({ month: currentMonth() });
      const generalKg = list.filter(e => e.type === 'general').reduce((s, e) => s + e.weightKg, 0);
      const recycleKg = 0;  // 단일화: 재활용 미사용
      const foodKg = 0;  // 단일화: 음식물 미사용

      const baseLimit = user.baseLimit || 40;

      // 월 진행률 (참고용)
      const now = new Date();
      const dayOfMonth = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const monthProgress = dayOfMonth / daysInMonth;

      // P47: 누적된 실제 데이터 기반 — 항상 표시 (부풀리지 않음)
      // "한도까지 여유 X kg" = 진행률 무관 항상 정확한 정직한 정보
      const reducedKg = Math.max(0, baseLimit - generalKg);
      const co2Kg = reducedKg * 0.5;          // 한국 실측 Tier 3, 화석연료 기원
      const treeEquivalent = co2Kg / 6.6;     // 산림청 표준탄소흡수량, 30년생 소나무

      let status, message;
      if (generalKg === 0 && recycleKg === 0 && foodKg === 0) {
        // 수치 0 — early_empty (count는 있는데 무게 모두 0)
        status = 'empty';
        message = '측정 데이터가 쌓이면 임팩트를 보여드릴게요';
      } else if (generalKg < baseLimit) {
        status = 'reducing';
        // 월 초반: 누적값 + 여유, 후반: 한도 대비
        if (monthProgress < 0.3) {
          message = `월 ${dayOfMonth}일차 · 일반쓰레기 ${generalKg.toFixed(1)}kg 누적 (한도 ${baseLimit}kg)`;
        } else {
          message = `일반쓰레기 ${generalKg.toFixed(1)}kg / 한도 ${baseLimit}kg (여유 ${reducedKg.toFixed(1)}kg)`;
        }
      } else if (Math.abs(generalKg - baseLimit) < 0.5) {
        status = 'at_limit';
        message = `한도 ${baseLimit}kg에 도달 — 다음 달 더 줄여보세요`;
      } else {
        status = 'over_limit';
        const overKg = generalKg - baseLimit;
        message = `한도 ${baseLimit}kg 초과 (${overKg.toFixed(1)}kg)`;
      }

      // 비용 절감 계산 (지역 가격 기반, P45)
      let savingWon = 0;
      let savingNote = '';
      if (user.region && user.region.price20L && reducedKg > 0) {
        // window.RegionData 사용 가능
        if (typeof window !== 'undefined' && window.RegionData) {
          savingWon = window.RegionData.calcSaving(reducedKg, user.region.sido, user.region.sigungu);
          savingNote = `${user.region.sigungu} 20L ${user.region.price20L}원 기준`;
        }
      }

      return {
        hasData: true,
        status,
        confident: true,
        monthlyKg: Math.round(generalKg * 10) / 10,    // 일반쓰레기만
        recycleKg: Math.round(recycleKg * 10) / 10,
        foodKg: Math.round(foodKg * 10) / 10,
        baseLimitKg: baseLimit,
        reducedKg: Math.round(reducedKg * 10) / 10,
        co2Kg: Math.round(co2Kg * 10) / 10,
        treeEquivalent: Math.round(treeEquivalent * 10) / 10,
        savingWon,           // P45: 비용 절감 (원)
        savingNote,          // P45: "강남구 20L 490원 기준"
        message,
      };
    },

    // ===== 감축 등급 (백서 v2.0 — 영구 사다리형) =====
    /**
     * 감축 등급 산정 (누적 승급 / 강등)
     * - 베이스라인: 설치 후 첫 3개월(현재월 제외)의 월 배출 평균
     * - 완료된 각 달의 감축률 → monthGP() 로 GP 증감 → 누적 합산(0 이상)
     * - 누적 GP가 도달한 최고 티어가 현재 등급 (GP가 줄면 자동 강등)
     * - 진행 중인 이번 달은 추세를 월말로 투영해 "예상 GP 증감" 안내
     *
     * 정식 도입 전(파일럿) 단계에서는 등급·포인트를 "예상"으로만 표시하며
     * 자동 적립은 하지 않는다 (백서: 챌린지 참여 환원은 Phase 2부터).
     */
    GRADE_LADDER,

    async getReductionGrade() {
      const user = await this.getUser();
      if (!user) return { hasData: false };

      const all = await dbGetAll();
      const monthMap = {};
      all.forEach(e => { monthMap[e.month] = (monthMap[e.month] || 0) + e.weightKg; });

      const cur = currentMonth();
      const pastMonths = Object.keys(monthMap).filter(m => m < cur).sort();
      const currentTotal = monthMap[cur] || 0;

      // 베이스라인 미확보 — 완료된 달이 하나도 없음
      if (pastMonths.length === 0) {
        return {
          hasData: true,
          status: 'baseline_building',
          currentTotal: Math.round(currentTotal * 10) / 10,
          message: '베이스라인 측정 중 — 첫 달이 지나면 감축 등급이 시작됩니다',
        };
      }

      const baselineMonths = pastMonths.slice(0, 3);
      const baseline = baselineMonths.reduce((s, m) => s + monthMap[m], 0) / baselineMonths.length;

      // 완료된 각 달의 감축률 → GP 누적 합산 (0 미만으로는 내려가지 않음)
      const monthlyReduction = (kg) =>
        baseline > 0 ? Math.max(-200, Math.min(100, ((baseline - kg) / baseline) * 100)) : 0;
      let gp = 0;
      pastMonths.forEach(m => { gp += monthGP(monthlyReduction(monthMap[m])); });
      gp = Math.max(0, gp);

      // 누적 GP가 도달한 최고 등급
      let idx = 0;
      for (let i = GRADE_LADDER.length - 1; i >= 0; i--) {
        if (gp >= GRADE_LADDER[i].minGP) { idx = i; break; }
      }
      const grade = GRADE_LADDER[idx];
      const next = GRADE_LADDER[idx + 1] || null;
      const gpToNext = next ? next.minGP - gp : 0;
      const progressPct = next
        ? Math.max(0, Math.min(100, ((gp - grade.minGP) / (next.minGP - grade.minGP)) * 100))
        : 100;

      // 이번 달 진행 상황 — 월말 추세 투영으로 예상 GP 증감 산정
      const now = new Date();
      const dayOfMonth = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const monthProgress = dayOfMonth / daysInMonth;

      let thisMonth;
      if (monthProgress < 0.15) {
        thisMonth = { status: 'early', currentKg: Math.round(currentTotal * 10) / 10 };
      } else {
        const projected = currentTotal / monthProgress;
        const pct = monthlyReduction(projected);
        thisMonth = {
          status: 'projecting',
          currentKg: Math.round(currentTotal * 10) / 10,
          projectedKg: Math.round(projected * 10) / 10,
          reductionPct: Math.round(pct * 10) / 10,
          gpDelta: monthGP(pct),
        };
      }

      return {
        hasData: true,
        status: 'active',
        baseline: Math.round(baseline * 10) / 10,
        baselineMonthCount: baselineMonths.length,
        monthsCounted: pastMonths.length,
        gp,
        grade,
        next,
        gpToNext,
        progressPct: Math.round(progressPct * 10) / 10,
        isMax: idx === GRADE_LADDER.length - 1,
        thisMonth,
      };
    },

    // ===== 포인트 =====
    async getPoints() {
      return Local.get(KEYS.POINTS, { total: 0, sources: {} });
    },

    async addPoints(amount, source = 'misc') {
      const cur = await this.getPoints();
      cur.total = (cur.total || 0) + amount;
      cur.sources = cur.sources || {};
      cur.sources[source] = (cur.sources[source] || 0) + amount;
      Local.set(KEYS.POINTS, cur);
      return cur;
    },

    // ===== 챌린지 ===== (v1.2.5: 차등 보상 1,000/2,000/3,000P)
    /**
     * 차등 보너스 계산
     * - 30% 이상 감량 → 3,000P
     * - 20% 이상 감량 → 2,000P
     * - 10% 이상 감량 → 1,000P
     * - 미만 → 0P (적립 없음)
     */
    _challengeBonusFor(achievedPct) {
      if (achievedPct == null || achievedPct < 10) return 0;
      if (achievedPct >= 30) return 3000;
      if (achievedPct >= 20) return 2000;
      return 1000;
    },

    async getChallenge() {
      const change = await this.getMonthlyChange();
      const goals = Local.get(KEYS.GOALS, { monthlyTarget: 30 });
      const target = goals.monthlyTarget || 30;
      const today = new Date();
      const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      const daysLeft = Math.max(0, lastDay.getDate() - today.getDate());
      const month = currentMonth();
      const claimed = Local.get(NS + 'challenge_' + month + '_claimed', false);

      const achieved = change != null ? Math.max(0, -change) : null;
      const bonus = this._challengeBonusFor(achieved);

      // 다음 단계 정보 (UI에서 "조금만 더" 표시용)
      let nextTier = null;
      if (achieved == null) {
        nextTier = { pct: 10, bonus: 1000 };
      } else if (achieved < 10) {
        nextTier = { pct: 10, bonus: 1000 };
      } else if (achieved < 20) {
        nextTier = { pct: 20, bonus: 2000 };
      } else if (achieved < 30) {
        nextTier = { pct: 30, bonus: 3000 };
      }

      return {
        month,
        target,
        achieved,
        bonus,
        nextTier,                       // v1.2.5 추가
        tiers: [                        // v1.2.5 추가 — UI 표시용
          { pct: 10, bonus: 1000 },
          { pct: 20, bonus: 2000 },
          { pct: 30, bonus: 3000 },
        ],
        daysLeft,
        completed: bonus > 0,
        claimed,
      };
    },

    /**
     * 챌린지 보너스 자동 적립 — 외부에서 호출 가능
     * v1.2.5: 차등 보상 적용. 사용자가 더 높은 단계 달성 시 차액 추가 적립.
     */
    async tryClaimChallenge() {
      const ch = await this.getChallenge();
      if (!ch.completed) return { claimed: false };

      const month = ch.month;
      const claimedKey = NS + 'challenge_' + month + '_claimed_amount';
      const previouslyClaimed = Local.get(claimedKey, 0);  // 이번 달 이미 받은 금액

      const additionalBonus = ch.bonus - previouslyClaimed;
      if (additionalBonus <= 0) return { claimed: false };

      await this.addPoints(additionalBonus, 'challenge');
      Local.set(claimedKey, ch.bonus);
      Local.set(NS + 'challenge_' + month + '_claimed', true);
      return { claimed: true, bonus: additionalBonus, totalThisMonth: ch.bonus };
    },

    async setGoal(percent) {
      const goals = Local.get(KEYS.GOALS, {});
      goals.monthlyTarget = Math.max(5, Math.min(50, parseInt(percent) || 20));
      Local.set(KEYS.GOALS, goals);
      return goals;
    },

    async getGoals() {
      return Local.get(KEYS.GOALS, { monthlyTarget: 20 });
    },

    // ===== 단지 평균/순위 =====
    /**
     * Mock: 사용자 자신의 데이터 기반으로 합리적인 가짜 단지 평균 생성
     * - 첫 달 또는 데이터 없을 때: hasData: false
     * - 데이터 있을 때: 사용자 평균 + 약간의 차이 (사용자 디바이스마다 일관)
     * - v1.2.5: 1인당 무게(kg/인) 정규화 비교 추가
     */
    async getApartmentStats() {
      const total = await this.getMonthlyTotal();
      const cnt = await this.getCount();
      if (cnt === 0) return { hasData: false };

      const user = await this.getUser();
      const baseLimit = (user && user.baseLimit) || 40;
      const myMembers = (user && user.members) || 4;

      // 단지 평균 ≈ baseLimit의 60~75% (일반적인 사용 패턴)
      // 사용자 ID 기반 시드로 동일 사용자에게는 일관된 값 제공
      const seed = (user && user.rfidId) ? user.rfidId.length : 7;
      const ratio = 0.62 + (seed % 13) * 0.012;  // 0.62 ~ 0.77
      const avg = Math.round(baseLimit * ratio * 10) / 10;

      const totalUnits = 100;
      // 비율 기반 순위 (가구 총 무게 기준 — 기존 호환)
      const ratio2 = total / Math.max(avg, 0.1);
      let rank;
      if (ratio2 < 0.5) rank = Math.max(1, Math.floor(ratio2 * 30));
      else if (ratio2 < 1.0) rank = Math.floor(15 + ratio2 * 35);
      else rank = Math.min(totalUnits, Math.floor(50 + ratio2 * 25));
      rank = Math.max(1, Math.min(totalUnits, rank));

      // v1.2.5: 1인당 무게 정규화 비교
      // 단지 평균 가구 인원: 환경부 통계 기준 약 2.3인/세대 (수도권 평균)
      const aptAvgMembers = 2.3;
      const myPerPerson = total / myMembers;
      const aptPerPerson = avg / aptAvgMembers;
      const perPersonDiff = Math.round((aptPerPerson - myPerPerson) * 10) / 10;
      const perPersonBetter = myPerPerson < aptPerPerson;
      // 1인당 기준 단지 내 순위 재계산
      const ppRatio = myPerPerson / Math.max(aptPerPerson, 0.1);
      let ppRank;
      if (ppRatio < 0.5) ppRank = Math.max(1, Math.floor(ppRatio * 30));
      else if (ppRatio < 1.0) ppRank = Math.floor(15 + ppRatio * 35);
      else ppRank = Math.min(totalUnits, Math.floor(50 + ppRatio * 25));
      ppRank = Math.max(1, Math.min(totalUnits, ppRank));

      return {
        hasData: true,
        avgKg: avg,
        myKg: Math.round(total * 10) / 10,
        diff: Math.round((avg - total) * 10) / 10,
        better: total < avg,
        rank,
        totalUnits,
        // v1.2.5 — 1인당 무게 정규화
        myMembers,
        myPerPerson: Math.round(myPerPerson * 10) / 10,
        aptPerPerson: Math.round(aptPerPerson * 10) / 10,
        perPersonDiff,
        perPersonBetter,
        ppRank,
      };
    },

    /**
     * v1.2.5 신규 — 행정동 단위 순위 (1인당 무게 기준)
     * 환경부 폐기물통계조사 1인당 평균 9.9kg/월 기준 정규분포 시뮬레이션
     * - 상위 1%: +3,000P
     * - 상위 5%: +1,000P
     * - 상위 10%: +500P
     */
    async getDistrictRank() {
      const total = await this.getMonthlyTotal();
      const cnt = await this.getCount();
      if (cnt === 0) return { hasData: false };

      const user = await this.getUser();
      const myMembers = (user && user.members) || 4;
      const myPerPerson = total / myMembers;

      // 환경부 평균: 1인당 약 9.9kg/월 (제6차 폐기물통계조사 추정)
      // 표준편차: 약 3.0kg/월 가정
      const populationMean = 9.9;
      const populationStd = 3.0;

      // z-score 계산
      const z = (myPerPerson - populationMean) / populationStd;

      // percentile 계산 (정규분포 CDF 근사 — Abramowitz & Stegun)
      const percentile = this._normalCdf(z) * 100;
      // 적은 게 좋으니 percentile이 낮을수록 상위
      const topPercent = Math.round(percentile * 10) / 10;

      // 동 단위 보너스
      let dongBonus = 0;
      let tier = null;
      if (topPercent <= 1) { dongBonus = 3000; tier = '상위 1%'; }
      else if (topPercent <= 5) { dongBonus = 1000; tier = '상위 5%'; }
      else if (topPercent <= 10) { dongBonus = 500; tier = '상위 10%'; }

      // 가상 동 정보 (사용자 시드 기반)
      const dongNames = ['시민동', '환경동', '미래동', '녹색동', '평화동', '한강동', '서초동', '강남동'];
      const seed = (user && user.rfidId) ? user.rfidId.length : 7;
      const dongName = dongNames[seed % dongNames.length];
      const dongResidents = 5478;  // 평균 행정동 인구

      // 동 내 순위 (인구 × percentile/100)
      const dongRank = Math.max(1, Math.round(dongResidents * topPercent / 100));

      return {
        hasData: true,
        dongName,
        dongResidents,
        myPerPerson: Math.round(myPerPerson * 10) / 10,
        populationMean,
        topPercent,
        dongRank,
        dongBonus,
        tier,
        tiers: [
          { topPercent: 1, bonus: 3000 },
          { topPercent: 5, bonus: 1000 },
          { topPercent: 10, bonus: 500 },
        ],
      };
    },

    /**
     * 정규분포 누적분포함수 (CDF) 근사값
     * Abramowitz & Stegun 26.2.17
     */
    _normalCdf(z) {
      const t = 1 / (1 + 0.2316419 * Math.abs(z));
      const d = 0.3989423 * Math.exp(-z * z / 2);
      const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
      return z >= 0 ? 1 - p : p;
    },

    /**
     * v1.2.5 신규 — 동 단위 순위 보너스 자동 적립
     * 매월 1회만 적립 (월 변경 시 자동 리셋)
     */
    async tryClaimDistrictBonus() {
      const dr = await this.getDistrictRank();
      if (!dr.hasData || dr.dongBonus <= 0) return { claimed: false };

      const month = currentMonth();
      const claimedKey = NS + 'district_' + month + '_claimed';
      const previouslyClaimed = Local.get(claimedKey, 0);

      const additional = dr.dongBonus - previouslyClaimed;
      if (additional <= 0) return { claimed: false };

      await this.addPoints(additional, 'district');
      Local.set(claimedKey, dr.dongBonus);
      return { claimed: true, bonus: additional, tier: dr.tier };
    },

    // ===== 알림 =====
    async getNotificationSettings() {
      return Local.get(KEYS.NOTIFICATIONS, {
        pickup: true, weekly: true, challenge: true, push: false,
      });
    },

    async setNotification(key, value) {
      const cur = await this.getNotificationSettings();
      cur[key] = !!value;
      Local.set(KEYS.NOTIFICATIONS, cur);
      return cur;
    },

    // ===== 배지 ===== (v1.2.4: 획득 시 보너스 포인트 지급)
    async getBadges() {
      return Local.get(KEYS.BADGES, []);
    },

    async _checkBadges() {
      const earned = Local.get(KEYS.BADGES, []);
      const totalCount = await dbCount();
      const change = await this.getMonthlyChange();

      const checks = [
        { id: 'first',   name: '첫 배출',     emoji: '🌱', bonus: 50,    cond: totalCount >= 1 },
        { id: 'streak3', name: '3회 배출',    emoji: '🔄', bonus: 100,   cond: totalCount >= 3 },
        { id: 'streak10',name: '10회 배출',   emoji: '⚡', bonus: 200,   cond: totalCount >= 10 },
        { id: 'streak50',name: '50회 배출',   emoji: '🏅', bonus: 500,   cond: totalCount >= 50 },
        { id: 'reduce10',name: '10% 감량',    emoji: '📉', bonus: 1000,  cond: change != null && change <= -10 },
        { id: 'reduce20',name: '20% 감량',    emoji: '🏆', bonus: 2000,  cond: change != null && change <= -20 },
        { id: 'reduce30',name: '30% 감량',    emoji: '👑', bonus: 3000,  cond: change != null && change <= -30 },
      ];
      let added = false;
      const newOnes = [];
      let totalBonus = 0;
      checks.forEach(c => {
        if (c.cond && !earned.find(b => b.id === c.id)) {
          const badge = { id: c.id, name: c.name, emoji: c.emoji, bonus: c.bonus, earnedAt: new Date().toISOString() };
          earned.push(badge);
          newOnes.push(badge);
          totalBonus += c.bonus;
          added = true;
        }
      });
      if (added) {
        Local.set(KEYS.BADGES, earned);
        // v1.2.4: 새로 획득한 배지의 보너스 포인트 일괄 적립
        if (totalBonus > 0) {
          await this.addPoints(totalBonus, 'badge');
        }
      }
      return { all: earned, newlyEarned: newOnes };
    },

    getBadgeDefs() {
      return [
        { id: 'first',    name: '첫 배출',  emoji: '🌱', bonus: 50,   desc: '첫 번째 배출 기록' },
        { id: 'streak3',  name: '3회',     emoji: '🔄', bonus: 100,  desc: '3회 배출 달성' },
        { id: 'streak10', name: '10회',    emoji: '⚡', bonus: 200,  desc: '10회 배출 달성' },
        { id: 'streak50', name: '50회',    emoji: '🏅', bonus: 500,  desc: '50회 배출 달성' },
        { id: 'reduce10', name: '10% 감량', emoji: '📉', bonus: 1000, desc: '전월 대비 10% 감량' },
        { id: 'reduce20', name: '20% 감량', emoji: '🏆', bonus: 2000, desc: '전월 대비 20% 감량' },
        { id: 'reduce30', name: '30% 감량', emoji: '👑', bonus: 3000, desc: '전월 대비 30% 감량' },
      ];
    },

    // ===== 백업/복원 =====
    async exportData() {
      const all = await dbGetAll();
      return {
        version: APP_VERSION,
        exportedAt: new Date().toISOString(),
        user: await this.getUser(),
        emissions: all,
        points: await this.getPoints(),
        notifications: await this.getNotificationSettings(),
        goals: await this.getGoals(),
        badges: await this.getBadges(),
        consent: Local.get(KEYS.CONSENT),  // PIPA 동의 시점 기록 보존
      };
    },

    async importData(data) {
      // 구조 검증
      if (!data || typeof data !== 'object') {
        throw new Error('잘못된 백업 파일입니다');
      }
      if (!data.version || typeof data.version !== 'string') {
        throw new Error('백업 파일에 버전 정보가 없습니다');
      }
      // emissions가 있으면 반드시 배열이어야 함
      if (data.emissions != null && !Array.isArray(data.emissions)) {
        throw new Error('배출 기록 형식이 올바르지 않습니다');
      }
      // user는 객체여야 하고 필수 필드가 있어야 함
      if (data.user != null) {
        if (typeof data.user !== 'object') {
          throw new Error('사용자 정보 형식이 올바르지 않습니다');
        }
        if (!data.user.apartment || !data.user.dong || !data.user.ho) {
          throw new Error('사용자 정보가 불완전합니다');
        }
      }

      // 보존할 사용자 환경 설정 백업
      const preserved = {};
      PRESERVE_ON_IMPORT.forEach(k => {
        const v = Local.get(k);
        if (v != null) preserved[k] = v;
      });

      // 챌린지 클레임 키 보존? — 백업 데이터의 시점이 다를 수 있으므로 정리
      try {
        Object.keys(localStorage)
          .filter(k => k.startsWith('rebin_challenge_'))
          .forEach(k => localStorage.removeItem(k));
      } catch {}

      // 기존 데이터 삭제
      await dbClear();
      Object.values(KEYS).forEach(k => Local.remove(k));

      // 복원
      if (data.user) Local.set(KEYS.USER, data.user);
      if (data.points) Local.set(KEYS.POINTS, data.points);
      if (data.notifications) Local.set(KEYS.NOTIFICATIONS, data.notifications);
      if (data.goals) Local.set(KEYS.GOALS, data.goals);
      if (data.badges) Local.set(KEYS.BADGES, data.badges);
      // PIPA 동의 — 백업 시점에 이미 동의한 사용자이므로 복원
      if (data.consent) Local.set(KEYS.CONSENT, data.consent);
      Local.set(KEYS.ONBOARDED, true);
      Local.set(KEYS.APP_VERSION, APP_VERSION);

      // 환경 설정 복원 (preserved가 우선 — 사용자가 import 직전 설정한 값)
      Object.entries(preserved).forEach(([k, v]) => Local.set(k, v));

      // 배출 기록 — 검증 + month 재계산
      let importedCount = 0;
      let skipped = 0;
      if (Array.isArray(data.emissions) && data.emissions.length > 0) {
        const fixed = [];
        for (const e of data.emissions) {
          // 각 record 검증 (엄격)
          if (!e || typeof e !== 'object') { skipped++; continue; }
          if (!e.date) { skipped++; continue; }
          // date 유효성
          const d = new Date(e.date);
          if (isNaN(d.getTime())) { skipped++; continue; }
          // weightKg는 number이고 양수
          if (typeof e.weightKg !== 'number' || isNaN(e.weightKg) || e.weightKg <= 0 || e.weightKg > 100) {
            skipped++; continue;
          }
          // type 검증
          const validType = 'general';  // 단일화: 모든 type을 general로

          fixed.push({
            id: e.id || ('e_imp_' + (crypto.randomUUID?.() || Math.random().toString(36).slice(2))),
            date: d.toISOString(),
            month: localYearMonth(d),
            weightKg: Math.round(e.weightKg * 100) / 100,
            type: validType,
            source: e.source || 'import',
            deviceId: e.deviceId || null,
          });
        }
        if (fixed.length > 0) {
          await dbAddBulk(fixed);
          importedCount = fixed.length;
        }
      }
      return { success: true, emissionsImported: importedCount, skipped };
    },

    // ===== 데이터 초기화 =====
    async reset() {
      await dbClear();
      Object.values(KEYS).forEach(k => Local.remove(k));
      try {
        Object.keys(localStorage)
          .filter(k => k.startsWith('rebin_challenge_'))
          .forEach(k => localStorage.removeItem(k));
      } catch {}
      return true;
    },

    /**
     * 배출 기록만 삭제 — 사용자/포인트/배지/설정은 보존 (시뮬레이터용)
     */
    async clearEmissionsOnly() {
      await dbClear();
      try {
        Object.keys(localStorage)
          .filter(k => k.startsWith('rebin_challenge_'))
          .forEach(k => localStorage.removeItem(k));
      } catch {}
      return true;
    },

    /**
     * 오래된 배출 기록 자동 정리 (yearsOld년 이전 데이터 삭제)
     * 사용자가 명시적으로 호출 (자동 실행 X)
     */
    async archiveOldEmissions(yearsOld = 2) {
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - yearsOld);
      const cutoffMonth = localYearMonth(cutoff);

      const all = await dbGetAll();
      const old = all.filter(e => e.month < cutoffMonth);
      if (old.length === 0) return { deleted: 0, kept: all.length };

      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('emissions', 'readwrite');
        const store = tx.objectStore('emissions');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        old.forEach(e => store.delete(e.id));
      });
      return { deleted: old.length, kept: all.length - old.length };
    },

    // ===== 하드웨어 (정식 도입 시 활성화) =====
    onDeviceMeasurement(cb) {
      if (this.config.mode === 'mock') return () => {};
      // WebSocket 연결은 정식 출시 시 구현
    },
  };

  return API;
})();

window.RebinAPI = RebinAPI;

// ═══════════════════════════════════════════════════════
// v1.3.0 변경: 등급제 — 누적 포인트 기준 (사용자 결정)
// ═══════════════════════════════════════════════════════
(function extendAPI() {
  if (typeof RebinAPI === 'undefined') return;

  // 활동 레벨 정의 (5단계, 누적 포인트 기준) — 게이미피케이션
  // v2.0: 도달 가능한 현실적 임계값으로 재조정
  const GRADES = [
    { key: 'SEEDLING', emoji: '🌱', name: 'SEEDLING', desc: '새싹 — 첫 발걸음',     minPoints: 0,       color: '#9DD9C7' },
    { key: 'SPROUT',   emoji: '🌿', name: 'SPROUT',   desc: '새싹 자람 — 습관 형성', minPoints: 5000,    color: '#5DCAA5' },
    { key: 'TREE',     emoji: '🌳', name: 'TREE',     desc: '나무 — 안정 단계',      minPoints: 30000,   color: '#1D9E75' },
    { key: 'FOREST',   emoji: '🌲', name: 'FOREST',   desc: '숲 — 환경 영웅',        minPoints: 100000,  color: '#0F6E56' },
    { key: 'DIAMOND',  emoji: '💎', name: 'DIAMOND',  desc: '다이아몬드 — 레전드',   minPoints: 300000,  color: '#85B7EB' }
  ];

  RebinAPI.GRADES = GRADES;

  /**
   * 현재 등급 — 누적 포인트 기준 (v1.3.2: this 의존성 제거)
   */
  RebinAPI.getGrade = async function() {
    // v1.3.2: this 컨텍스트 문제 방지 — 직접 localStorage 접근
    let totalPoints = 0;
    try {
      // 우선 RebinAPI.getPoints() 시도
      if (typeof RebinAPI.getPoints === 'function') {
        const points = await RebinAPI.getPoints();
        totalPoints = (points && typeof points.total === 'number') ? points.total : 0;
      }
      // fallback: localStorage 직접 접근
      if (totalPoints === 0) {
        const raw = localStorage.getItem('rebin_points');
        if (raw) {
          const parsed = JSON.parse(raw);
          totalPoints = (parsed && typeof parsed.total === 'number') ? parsed.total : 0;
        }
      }
    } catch (e) {
      console.error('[grade] getPoints 실패:', e);
      totalPoints = 0;
    }

    console.log('[Re:Bin v1.3.2] getGrade — totalPoints:', totalPoints);

    // 참고용 — kg 합계 (UI 표시)
    let totalKg = 0;
    try {
      // v1.3.3: 올바른 함수명 (getAllEmissions → getEmissions)
      const allEm = await RebinAPI.getEmissions();
      totalKg = allEm.reduce((sum, e) => sum + (Number(e.weightKg) || 0), 0);
    } catch (e) {
      console.warn('[grade] getEmissions 실패:', e);
    }

    // 현재 등급 찾기 (역순 검색)
    let currentIdx = 0;
    for (let i = GRADES.length - 1; i >= 0; i--) {
      if (totalPoints >= GRADES[i].minPoints) {
        currentIdx = i;
        break;
      }
    }

    const current = GRADES[currentIdx];
    const next = GRADES[currentIdx + 1] || null;
    const pointsUntilNext = next ? Math.max(0, next.minPoints - totalPoints) : 0;
    const progress = next 
      ? Math.min(100, ((totalPoints - current.minPoints) / (next.minPoints - current.minPoints)) * 100)
      : 100;

    return {
      current,
      next,
      totalPoints,
      totalKg,
      pointsUntilNext,
      progress: Math.round(progress * 10) / 10,
      isMax: currentIdx === GRADES.length - 1
    };
  };

  /**
   * 누적 환경 임팩트 (v1.3.3 완전 재작성)
   * 환산 = (한도 - 실제 배출) × 0.5 = 절감 CO2 → /6.6 = 나무 그루
   * 
   * ✅ 이번 달: 이번 달 절감량만
   * ✅ 누적: 모든 월의 절감량 합계
   */
  RebinAPI.getCumulativeImpact = async function() {
    // v1.3.3: 올바른 함수명 (getAllEmissions → getEmissions)
    let allEm = [];
    try {
      allEm = await RebinAPI.getEmissions();
    } catch (e) {
      console.error('[eco] getEmissions 실패:', e);
      allEm = [];
    }

    // 가구별 월 한도 (v1.3.4: 안전 범위 검증 강화)
    let monthlyTarget = 40; // 4인 가구 기본
    try {
      const goals = await RebinAPI.getGoals();
      if (goals && typeof goals.monthlyTarget === 'number' && 
          isFinite(goals.monthlyTarget) && goals.monthlyTarget > 0 && goals.monthlyTarget < 1000) {
        monthlyTarget = goals.monthlyTarget;
      }
    } catch (e) {
      console.warn('[eco] getGoals 실패, 기본값 40kg 사용:', e);
    }

    // 월별 배출량 집계
    const monthMap = {};
    allEm.forEach(e => {
      const m = e.month;
      if (!m) return;
      monthMap[m] = (monthMap[m] || 0) + (Number(e.weightKg) || 0);
    });

    // 이번 달
    const currentM = currentMonth();
    const monthKg = monthMap[currentM] || 0;
    const monthSavedKg = Math.max(0, monthlyTarget - monthKg);

    // 누적 — 각 월의 절감량 합산 (한도 초과 월은 0으로 처리)
    let totalSavedKg = 0;
    Object.keys(monthMap).forEach(m => {
      const saved = Math.max(0, monthlyTarget - monthMap[m]);
      totalSavedKg += saved;
    });

    // CO2 & 나무 환산
    const calc = (savedKg) => ({
      saved: Math.round(savedKg * 10) / 10,        // 절감량 (kg)
      kg: Math.round(savedKg * 10) / 10,           // 호환성
      co2: Math.round(savedKg * 0.5 * 10) / 10,    // CO2 절감
      trees: Math.round((savedKg * 0.5 / 6.6) * 100) / 100  // 나무 그루
    });

    const monthCount = Object.keys(monthMap).length;

    console.log('[Re:Bin v1.3.3] impact — monthlyTarget:', monthlyTarget,
                'monthKg:', monthKg, 'monthSaved:', monthSavedKg,
                'totalSaved:', totalSavedKg, '개월수:', monthCount);

    return {
      month: { 
        ...calc(monthSavedKg), 
        actualKg: monthKg, 
        target: monthlyTarget, 
        label: currentM 
      },
      total: { 
        ...calc(totalSavedKg), 
        monthCount,
        monthlyTarget 
      }
    };
  };
})();
