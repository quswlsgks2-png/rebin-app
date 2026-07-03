/**
 * Re:Bin 감축정원 (v2.4.0)
 * ============================================================
 * 감축등급을 게임화한 정원 페이지.
 *
 * 데이터 정합성 원칙 — 기존 앱과 절대 어긋나지 않도록:
 *  - 배출 데이터: RebinAPI.getEmissions() 단일 소스 (IndexedDB 동일)
 *  - 월 집계·베이스라인: data-layer의 getReductionGrade()와 동일 공식
 *      · 월 합산 = e.month(YYYY-MM)별 weightKg 합
 *      · 베이스라인 = 완료된(현재월 제외) 첫 3개월 평균
 *      · 진행 중인 달은 적립하지 않음 (월말 정산 — 백서 원칙과 동일)
 *  - 물방울 경제는 "파생값": 적립 총량은 매번 배출 이력에서 재계산(멱등).
 *      · 적립 = Σ(완료월) max(0, 베이스라인 − 월배출) × 10 × 스트릭배수
 *      · 스트릭배수(연속 감축 달): 2달+ ×1.2 / 4달+ ×1.5 / 8달+ ×2.0
 *    저장하는 것은 "사용량(spent)" 하나뿐 → 이력이 수정/삭제되어도
 *    적립이 자동 재계산되고 spent는 적립 이하로 클램프됨.
 *  - 성장(growth) = spent (부은 물이 곧 성장) → 단일 저장값으로 무결성 보장
 *  - GP 등급(data-layer GRADE_LADDER)은 그대로 유지 — 포인트 화면 등
 *    기존 참조에 영향 없음. 정원 6단계는 별도 표시 체계.
 */
(function () {
  'use strict';

  // ===== 공식 6단계 (자연·감축 등급 — 성장의 순서) =====
  const STAGES = [
    { kr: '씨앗', en: 'Seed',     art: '#gd-art-seed',   need: 0,    sky: '#DFF3E9', desc: '작은 실천의 시작' },
    { kr: '새싹', en: 'Sprout',   art: '#gd-art-sprout', need: 80,   sky: '#D8F1E4', desc: '습관이 자리 잡는 시기' },
    { kr: '나무', en: 'Tree',     art: '#gd-art-tree',   need: 240,  sky: '#CDEDDD', desc: '꾸준한 실천이 만드는 변화' },
    { kr: '숲',   en: 'Forest',   art: '#gd-art-pine',   need: 520,  sky: '#C2E8D6', desc: '더 큰 가치를 만드는 단계' },
    { kr: '산',   en: 'Mountain', art: '#gd-art-mtn',    need: 920,  sky: '#BCE4EC', desc: '영향력이 확장되는 단계' },
    { kr: '지구', en: 'Earth',    art: '#gd-art-earth',  need: 1500, sky: '#B4DEF2', desc: '지속가능한 미래의 완성' },
  ];
  const DROPS_PER_KG = 10;
  const POUR_UNIT = 10;
  const SAVE_EPS = 0.05;            // 부동소수 노이즈 컷 (kg)
  const STREAK_MULT = s => (s >= 8 ? 2.0 : s >= 4 ? 1.5 : s >= 2 ? 1.2 : 1.0);
  const LS_KEY = 'rebin_garden';    // { spent, seenStage, entries, exchanged }
  const EXCHANGE_RATE = 1;          // 💧1 = 1P (최고 등급 달성 후)

  // ===== 후원 챌린지 (등급 특전) =====
  // minStage: 응모 가능 최소 단계 index (0=씨앗 … 5=지구)
  // ticketCost: 응모권 1장 가격 (에코포인트) — 파일럿 예시값, 협약 시 확정
  const RAFFLES = [
    { id: 'ecobag',   emoji: '👜', item: '친환경 에코백 세트',   sponsor: '후원사 A (생활용품)', minStage: 1, ticketCost: 300 },
    { id: 'tumbler',  emoji: '🥤', item: '스테인리스 텀블러 2종', sponsor: '후원사 B (리빙)',     minStage: 2, ticketCost: 500 },
    { id: 'purifier', emoji: '🌬️', item: '공기청정기',           sponsor: '후원사 C (가전)',     minStage: 3, ticketCost: 1000 },
    { id: 'fridge',   emoji: '🧊', item: '냉장고',               sponsor: '후원사 D (가전)',     minStage: 4, ticketCost: 2000 },
  ];

  // ===== 저장 (사용량만) =====
  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          return { spent: Math.max(0, +p.spent || 0), seenStage: Math.max(0, +p.seenStage || 0), entries: (p.entries && typeof p.entries === 'object') ? p.entries : {}, exchanged: Math.max(0, +p.exchanged || 0) };
        }
      }
    } catch (e) { /* noop */ }
    return { spent: 0, seenStage: 0, entries: {}, exchanged: 0 };
  }
  function saveState(st) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(st)); } catch (e) { /* noop */ }
  }

  // ===== 경제 계산 — 배출 이력에서 매번 파생 (data-layer와 동일 공식) =====
  async function computeEconomy() {
    const API = window.RebinAPI;
    if (!API) return { status: 'no_api' };

    let all = [];
    try { all = await API.getEmissions(); } catch (e) { return { status: 'no_api' }; }

    const monthMap = {};
    (all || []).forEach(e => { monthMap[e.month] = (monthMap[e.month] || 0) + e.weightKg; });

    const cur = API.currentMonth();
    const pastMonths = Object.keys(monthMap).filter(m => m < cur).sort();
    const currentTotal = monthMap[cur] || 0;

    if (pastMonths.length === 0) {
      return {
        status: 'baseline_building',
        currentTotal: Math.round(currentTotal * 10) / 10,
      };
    }

    // 베이스라인 = 완료된 첫 3개월 평균 (getReductionGrade와 동일)
    const baselineMonths = pastMonths.slice(0, 3);
    const baseline = baselineMonths.reduce((s, m) => s + monthMap[m], 0) / baselineMonths.length;

    // 완료월 순회: 감축 kg → 물방울 적립 (+ 연속 감축 스트릭 배수)
    let streak = 0, earned = 0, totalSaved = 0;
    pastMonths.forEach(m => {
      const saved = Math.max(0, baseline - monthMap[m]);
      if (saved > SAVE_EPS) streak++; else streak = 0;
      const mult = STREAK_MULT(streak);
      earned += Math.round(saved * DROPS_PER_KG * mult);
      totalSaved += saved;
    });

    // 이번 달 예상 (표시 전용 — 적립은 월말 정산 후)
    const now = new Date();
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const monthProgress = dayOfMonth / daysInMonth;
    let projection = null;
    if (monthProgress >= 0.15) {
      const projectedKg = currentTotal / monthProgress;
      const projSaved = Math.max(0, baseline - projectedKg);
      const nextStreak = projSaved > SAVE_EPS ? streak + 1 : 0;
      projection = {
        projectedKg: Math.round(projectedKg * 10) / 10,
        drops: Math.round(projSaved * DROPS_PER_KG * STREAK_MULT(nextStreak)),
        willSave: projSaved > SAVE_EPS,
      };
    }

    return {
      status: 'active',
      baseline: Math.round(baseline * 10) / 10,
      monthsCounted: pastMonths.length,
      currentTotal: Math.round(currentTotal * 10) / 10,
      earned,
      streak,
      totalSaved: Math.round(totalSaved * 10) / 10,
      projection,
    };
  }

  // ===== DOM 헬퍼 =====
  const $ = id => document.getElementById(id);
  let reduced = false;
  try { reduced = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* noop */ }

  function stageIdx(g) {
    let i = 0;
    for (let k = STAGES.length - 1; k >= 0; k--) { if (g >= STAGES[k].need) { i = k; break; } }
    return i;
  }

  // ===== 이펙트 =====
  function spawnDrops(count) {
    if (reduced) return;
    const wrap = $('gd-scene-wrap');
    if (!wrap) return;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const cx = w / 2, groundY = h * 0.74;
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        const d = document.createElement('div');
        d.className = 'gd-drop';
        const x = cx + (Math.random() * 90 - 45);
        const y0 = h * 0.10 + Math.random() * 30;
        d.style.left = x + 'px'; d.style.top = y0 + 'px';
        d.style.setProperty('--fy', (groundY - y0) + 'px');
        wrap.appendChild(d);
        setTimeout(() => {
          const s = document.createElement('div');
          s.className = 'gd-splash';
          s.style.left = (x - 8) + 'px'; s.style.top = (groundY + 6) + 'px';
          wrap.appendChild(s);
          setTimeout(() => s.remove(), 520);
          d.remove();
        }, 720);
      }, i * 70);
    }
  }
  function floatText(txt, gold) {
    const wrap = $('gd-scene-wrap');
    if (!wrap) return;
    const f = document.createElement('div');
    f.className = 'gd-float-txt' + (gold ? ' gold' : '');
    f.textContent = txt;
    f.style.left = '50%';
    f.style.top = wrap.clientHeight * 0.32 + 'px';
    wrap.appendChild(f);
    setTimeout(() => f.remove(), 1150);
  }
  function leafConfetti() {
    if (reduced) return;
    const wrap = $('gd-scene-wrap');
    if (!wrap) return;
    const w = wrap.clientWidth;
    const ems = ['🍃', '🌿', '✨', '💧', '🍃'];
    for (let i = 0; i < 16; i++) {
      const c = document.createElement('div');
      c.className = 'gd-leaf-conf';
      c.textContent = ems[i % ems.length];
      c.style.left = (Math.random() * w) + 'px';
      c.style.top = '-10px';
      c.style.animationDelay = (Math.random() * 0.4) + 's';
      wrap.appendChild(c);
      setTimeout(() => c.remove(), 2200);
    }
  }

  // ===== 진화 모달 (동적 생성 — index.html 오염 최소화) =====
  let evoEl = null;
  const evoQueue = [];
  function ensureEvo() {
    if (evoEl) return evoEl;
    evoEl = document.createElement('div');
    evoEl.className = 'gd-evo';
    evoEl.setAttribute('role', 'dialog');
    evoEl.setAttribute('aria-modal', 'true');
    evoEl.innerHTML =
      '<div class="gd-evo-card">' +
      '<svg class="gd-evo-art" viewBox="0 0 100 100"><use id="gd-evo-use" href="#gd-art-sprout"/></svg>' +
      '<div class="gd-evo-t1">STAGE UP!</div>' +
      '<div class="gd-evo-name"><div class="gd-evo-num" id="gd-evo-num">2</div>' +
      '<div class="gd-evo-t2"><span id="gd-evo-kr">새싹</span><span class="en" id="gd-evo-en">Sprout</span></div></div>' +
      '<p class="gd-evo-d" id="gd-evo-d"></p>' +
      '<button class="gd-evo-btn" id="gd-evo-btn" type="button">계속 키우기</button></div>';
    document.body.appendChild(evoEl);
    evoEl.querySelector('#gd-evo-btn').addEventListener('click', () => {
      evoEl.classList.remove('show');
      if (evoQueue.length) setTimeout(showNextEvo, 250);
    });
    return evoEl;
  }
  function showNextEvo() {
    const idx = evoQueue.shift();
    if (idx === undefined) return;
    const st = STAGES[idx];
    const el = ensureEvo();
    el.querySelector('#gd-evo-use').setAttribute('href', st.art);
    el.querySelector('#gd-evo-num').textContent = idx + 1;
    el.querySelector('#gd-evo-kr').textContent = st.kr;
    el.querySelector('#gd-evo-en').textContent = st.en;
    el.querySelector('#gd-evo-d').textContent = st.desc;
    el.classList.add('show');
    leafConfetti();
  }

  // ===== 상태 & 렌더 =====
  let state = loadState();   // { spent, seenStage }
  let eco = null;            // 최신 경제 계산 결과

  function available() {
    if (!eco || eco.status !== 'active') return 0;
    return Math.max(0, eco.earned - state.spent - state.exchanged);
  }

  function renderUI() {
    if (!$('gd-scene-wrap')) return; // 페이지 미존재 방어

    // 사용량 클램프 — 상태별로 안전하게:
    //  · active: 이력 수정으로 적립이 줄면 spent를 적립 이하로 (진화 연출도 하향 동기화)
    //  · baseline_building: 데이터가 실제로 비었으면(앱 초기화 등) 정원 전체 리셋
    //  · no_api: 일시적 오류 — 아무것도 건드리지 않음 (진행도 보호)
    let earned = 0;
    if (eco && eco.status === 'active') {
      earned = eco.earned;
      if (state.spent > earned) {
        state.spent = earned;
        state.seenStage = stageIdx(state.spent);
        saveState(state);
      }
    } else if (eco && eco.status === 'baseline_building') {
      if (state.spent > 0 || state.exchanged > 0 || Object.keys(state.entries).length > 0) {
        state = { spent: 0, seenStage: 0, entries: {}, exchanged: 0 };
        saveState(state);
      }
    }

    const growth = state.spent;
    const idx = stageIdx(growth);
    const st = STAGES[idx];
    const next = STAGES[idx + 1] || null;
    const avail = available();

    // 헤더 배지
    $('gd-drops').textContent = avail;
    $('gd-streak').textContent = (eco && eco.status === 'active') ? eco.streak : 0;

    // 씬
    document.querySelectorAll('.gd-stage-layer').forEach(l => {
      l.classList.toggle('on', +l.dataset.stage === idx);
    });
    const sky = $('gd-sky');
    if (sky) sky.setAttribute('fill', st.sky);
    $('gd-si-num').textContent = idx + 1;
    $('gd-si-kr').textContent = st.kr;
    $('gd-si-en').textContent = st.en;
    $('gd-si-desc').textContent = st.desc;

    // 게이지
    let pct;
    if (next) {
      pct = ((growth - st.need) / (next.need - st.need)) * 100;
      $('gd-grow-next').textContent = `${next.kr}까지 💧${next.need - growth}`;
    } else {
      pct = 100;
      $('gd-grow-next').textContent = '최고 단계 · 지구 달성 🌍';
    }
    pct = Math.max(0, Math.min(100, pct));
    $('gd-bar-fill').style.width = pct + '%';
    $('gd-bar-box').setAttribute('aria-valuenow', Math.round(pct));

    // 물주기 버튼
    const btn = $('gd-btn-water');
    btn.disabled = avail <= 0 || !next;
    $('gd-water-sub').textContent = !next ? '(모든 단계 완료!)'
      : avail <= 0 ? '(다음 달 정산 후 물방울이 적립돼요)'
      : '(꾹 누르면 연속으로!)';

    // 최고 등급 달성 후: 물방울 → 포인트 교환
    const ex = $('gd-exchange');
    if (ex) {
      const atMax = !next;
      ex.hidden = !atMax;
      if (atMax) {
        $('gd-ex-amt').textContent = avail.toLocaleString();
        $('gd-ex-pts').textContent = (avail * EXCHANGE_RATE).toLocaleString();
        $('gd-ex-btn').disabled = avail <= 0;
      }
    }

    // 적립 현황 카드
    const note = $('gd-earn-note');
    const projLbl = $('gd-proj-lbl'), projVal = $('gd-proj-drops');
    if (!eco || eco.status === 'no_api') {
      $('gd-cur-kg').textContent = '—';
      $('gd-base-kg').textContent = '—';
      projVal.textContent = '—';
    } else if (eco.status === 'baseline_building') {
      $('gd-cur-kg').textContent = eco.currentTotal.toFixed(1) + ' kg';
      $('gd-base-kg').textContent = '측정 중';
      projLbl.textContent = '적립 시작';
      projVal.textContent = '첫 달 완료 후';
      note.textContent = '베이스라인 측정 중 — 첫 달이 완료되면 감축량에 따라 물방울이 적립됩니다';
    } else {
      $('gd-cur-kg').textContent = eco.currentTotal.toFixed(1) + ' kg';
      $('gd-base-kg').textContent = eco.baseline.toFixed(1) + ' kg';
      projLbl.textContent = '월말 예상 적립';
      if (eco.projection) {
        projVal.textContent = eco.projection.willSave ? `💧${eco.projection.drops}` : '💧0 (감축 없음)';
      } else {
        projVal.textContent = '집계 중';
      }
      note.textContent = '물방울은 완료된 달의 실제 감축량(베이스라인 대비)으로 자동 적립됩니다 · 감축 1kg = 💧10';
    }
    const sn = $('gd-streak-note');
    if (eco && eco.status === 'active' && eco.streak >= 2) {
      sn.hidden = false;
      $('gd-streak-note-txt').textContent = `${eco.streak}달 연속 감축 중 — 물방울 ×${STREAK_MULT(eco.streak)} 보너스!`;
    } else {
      sn.hidden = true;
    }

    // 로드맵
    const track = $('gd-rm-track');
    if (track && !track.dataset.built) {
      track.dataset.built = '1';
      STAGES.forEach((s, i) => {
        const n = document.createElement('div');
        n.className = 'gd-rm-node';
        n.innerHTML = `<div class="gd-rm-dot">${i + 1}</div><div class="gd-rm-name">${s.kr}<span class="en">${s.en}</span></div>`;
        track.appendChild(n);
      });
    }
    track.querySelectorAll('.gd-rm-node').forEach((n, i) => {
      n.classList.toggle('done', i < idx);
      n.classList.toggle('now', i === idx);
    });
    $('gd-rm-fill').style.width = (idx / (STAGES.length - 1)) * 84 + '%';

    // 통계 (베이스라인 대비 — 앱과 동일 환산계수)
    const saved = (eco && eco.status === 'active') ? eco.totalSaved : 0;
    const co2 = saved * 0.5;
    $('gd-st-saved').textContent = saved.toFixed(1) + 'kg';
    $('gd-st-co2').textContent = co2.toFixed(1) + 'kg';
    $('gd-st-tree').textContent = (co2 / 6.6).toFixed(2) + '그루';

    saveState(state);
    renderRaffles();
  }

  // ===== 후원 챌린지 — 등급 잠금 · 응모권 = 에코포인트 구매 =====
  let userPoints = 0;

  async function refreshPoints() {
    try {
      const p = await window.RebinAPI.getPoints();
      userPoints = (p && p.total) || 0;
    } catch (e) { userPoints = 0; }
  }

  function renderRaffles() {
    const list = $('gd-raffle-list');
    if (!list) return;
    const myStage = stageIdx(state.spent);
    const sig = myStage + '|' + userPoints + '|' + JSON.stringify(state.entries);
    if (list.dataset.sig === sig) return;   // 변화 없으면 재생성 생략 (홀드 물주기 깜빡임 방지)
    list.dataset.sig = sig;
    list.innerHTML = '';
    RAFFLES.forEach(r => {
      const locked = myStage < r.minStage;
      const short = userPoints < r.ticketCost;
      const mine = state.entries[r.id] || 0;
      const reqStage = STAGES[r.minStage];

      const card = document.createElement('div');
      card.className = 'gd-raffle' + (locked ? ' locked' : '');
      card.innerHTML =
        '<div class="gd-raffle-emoji">' + (locked ? '🔒' : r.emoji) + '</div>' +
        '<div class="gd-raffle-info">' +
          '<div class="gd-raffle-item">' + r.item + '</div>' +
          '<div class="gd-raffle-sponsor">' + r.sponsor + '</div>' +
          '<span class="gd-raffle-req">' + (locked ? '🔒 ' : '✓ ') + '「' + reqStage.kr + '」 등급부터</span>' +
        '</div>' +
        '<div class="gd-raffle-side">' +
          '<span class="gd-raffle-cost">응모권 ' + r.ticketCost.toLocaleString() + 'P</span>' +
          '<button class="gd-raffle-btn" type="button" data-raffle="' + r.id + '"' +
            ((locked || short) ? ' disabled' : '') + '>' +
            (locked ? '등급 잠금' : short ? '포인트 부족' : '응모하기') + '</button>' +
          (mine > 0 ? '<span class="gd-raffle-mine">내 응모권 ' + mine + '장</span>' : '') +
        '</div>';
      list.appendChild(card);
    });
  }

  async function buyTicket(id) {
    const r = RAFFLES.find(x => x.id === id);
    if (!r) return;
    const myStage = stageIdx(state.spent);
    if (myStage < r.minStage) return;
    await refreshPoints();
    if (userPoints < r.ticketCost) {
      if (window.toast) window.toast('에코포인트가 부족해요', 'info', 1800);
      renderRaffles();
      return;
    }
    const ok = confirm(
      '「' + r.item + '」 응모권 1장을 구매할까요?\n' +
      '차감: ' + r.ticketCost.toLocaleString() + 'P (보유 ' + userPoints.toLocaleString() + 'P)'
    );
    if (!ok) return;
    try {
      await window.RebinAPI.addPoints(-r.ticketCost, 'raffle_ticket');
    } catch (e) {
      if (window.toast) window.toast('포인트 차감에 실패했어요', 'info', 1800);
      return;
    }
    state.entries[r.id] = (state.entries[r.id] || 0) + 1;
    saveState(state);
    await refreshPoints();
    renderRaffles();
    if (window.toast) window.toast('🎟️ 「' + r.item + '」 응모 완료! (' + state.entries[r.id] + '장)', 'success', 2200);
  }

    // ===== 물방울 → 포인트 교환 (최고 등급 달성 후 · 1💧=1P) =====
  async function exchangeDrops() {
    if (stageIdx(state.spent) < STAGES.length - 1) return;  // 지구 달성 후에만
    const amt = available();
    if (amt <= 0) return;
    const pts = amt * EXCHANGE_RATE;
    const ok = confirm('남은 물방울 ' + amt.toLocaleString() + '💧를 ' + pts.toLocaleString() + 'P로 교환할까요?\n(교환한 물방울은 되돌릴 수 없어요)');
    if (!ok) return;
    try {
      await window.RebinAPI.addPoints(pts, 'garden_exchange');
    } catch (e) {
      if (window.toast) window.toast('포인트 적립에 실패했어요', 'info', 1800);
      return;
    }
    state.exchanged += amt;
    saveState(state);
    await refreshPoints();
    renderUI();
    if (window.toast) window.toast('💧' + amt.toLocaleString() + ' → ' + pts.toLocaleString() + 'P 교환 완료!', 'success', 2200);
  }

    // ===== 물주기 — 게이지 가득 시 자동 진화 · 초과분 이월 =====
  function pour() {
    const avail = available();
    if (avail <= 0) return false;
    if (stageIdx(state.spent) >= STAGES.length - 1) return false;
    const amt = Math.min(POUR_UNIT, avail);
    state.spent += amt;   // growth == spent, 경계에서 자르지 않음(이월)
    spawnDrops(Math.max(4, Math.min(10, amt)));
    floatText(`+${amt} 성장`);
    const newIdx = stageIdx(state.spent);
    while (state.seenStage < newIdx) {
      state.seenStage++;
      evoQueue.push(state.seenStage);
    }
    renderUI();
    if (evoQueue.length && (!evoEl || !evoEl.classList.contains('show'))) {
      stopHold();
      setTimeout(showNextEvo, reduced ? 0 : 620);
    }
    return true;
  }

  let holdT = null, holdIv = null;
  function startHold(e) {
    if (e && e.type === 'pointerdown') e.preventDefault();
    pour();
    holdT = setTimeout(() => {
      holdIv = setInterval(() => { if (!pour()) stopHold(); }, 340);
    }, 420);
  }
  function stopHold() {
    clearTimeout(holdT); clearInterval(holdIv);
    holdT = holdIv = null;
  }

  let bound = false;
  function bind() {
    if (bound) return;
    const btn = $('gd-btn-water');
    if (!btn) return;
    bound = true;
    btn.addEventListener('pointerdown', startHold);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, stopHold));
    btn.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pour(); }
    });
    const exBtn = $('gd-ex-btn');
    if (exBtn) exBtn.addEventListener('click', exchangeDrops);
    const list = $('gd-raffle-list');
    if (list) list.addEventListener('click', e => {
      const b = e.target.closest('[data-raffle]');
      if (b && !b.disabled) buyTicket(b.dataset.raffle);
    });
  }

  // ===== 공개 API =====
  window.RebinGarden = {
    async render() {
      bind();
      state = loadState();
      eco = await computeEconomy();
      await refreshPoints();
      // 이미 지나온 단계는 진화 연출 생략 (재방문 시)
      const idx = stageIdx(state.spent);
      if (state.seenStage < idx) { state.seenStage = idx; }
      renderUI();
    },
    // 디버그/검증용
    _computeEconomy: computeEconomy,
    _stages: STAGES,
  };
})();
