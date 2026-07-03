/**
 * Re:Bin App Controller v1.1.0
 *
 * 주요 수정 사항:
 * #5  챌린지 보너스: home/points 진입 시 자동 적립 시도
 * #6  세대원/주소 변경 → 영향 받는 view 모두 재렌더
 * #7  hashchange 단일 진입점 (이중 렌더링 제거)
 * #8  푸시 토글 UX: 권한 거부 시 토스트, badge로 "서버 준비중" 표시
 * #9  emit setTimeout을 State.emit.timeouts에 저장 → view 떠날 때 cleanup
 * #10 시뮬레이터: addEmissionsBulk + showLoader
 * #11 rfid-area 키보드 접근 (Enter/Space)
 * #14 FOUC: <head> 인라인 스크립트 (별도 처리)
 * #15 splash: init 완료 시 .hide, 최소 600ms 유지
 * #16 친구 초대: rfidId 노출 없이 referral URL만
 * #18 세대원 변경 후 데이터 전체 재계산 트리거
 */

(function () {
  'use strict';

  const API = window.RebinAPI;
  const { $, el, toast, alert: uiAlert, confirm: uiConfirm, prompt: uiPrompt,
          sheet, showModal, showLoader, haptic } = window.UI;

  // =====================================================
  // STATE
  // =====================================================
  const State = {
    user: null,
    currentRoute: 'home',
    emit: { state: 'idle', type: 'general', timeouts: [], measuredKg: null },
    historyMonth: null,
    deferredInstallPrompt: null,
    splashAt: Date.now(),
    initialized: false,
  };

  const ROUTES = ['home', 'emit', 'history', 'points', 'garden', 'guide', 'settings'];
  const TYPE_NAMES = {
    general: { name: '일반쓰레기', emoji: '🗑️' },
  };

  // =====================================================
  // UTIL
  // =====================================================
  function fmtTime(date) {
    const d = new Date(date);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const yPrefix = sameYear ? '' : `${d.getFullYear()}/`;
    return `${yPrefix}${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }
  function fmtRelative(date) {
    const d = new Date(date);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    if (sameDay) return `오늘 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    if (d.toDateString() === yesterday.toDateString()) return `어제 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    return fmtTime(date);
  }
  function fmtMonthLabel(month) {
    // '2026-04' → '4월'
    return `${parseInt(month.slice(5))}월`;
  }
  function fmtMonthFull(month) {
    return `${month.slice(0,4)}년 ${parseInt(month.slice(5))}월`;
  }
  function clearEmitTimeouts() {
    State.emit.timeouts.forEach(t => clearTimeout(t));
    State.emit.timeouts = [];
  }
  function emitTimeout(fn, ms) {
    const id = setTimeout(() => {
      State.emit.timeouts = State.emit.timeouts.filter(t => t !== id);
      fn();
    }, ms);
    State.emit.timeouts.push(id);
    return id;
  }
  function greeting() {
    const h = new Date().getHours();
    if (h < 6) return '늦은 시간이네요 🌙';
    if (h < 12) return '좋은 아침입니다 ☀️';
    if (h < 18) return '오늘도 수고하세요 👋';
    return '편안한 저녁입니다 🌆';
  }

  // stale-cache 안전 헬퍼: 요소 없으면 silently skip
  function bindClick(id, handler) {
    const el = $(id);
    if (el) el.onclick = handler;
    else console.warn(`[bindClick] element not found: ${id} (cache may be stale)`);
  }

  // =====================================================
  // ROUTING
  // =====================================================
  function go(route) {
    if (!ROUTES.includes(route)) route = 'home';
    if (location.hash === '#' + route) {
      // 이미 그 route에 있으면 강제 재렌더
      handleHash();
    } else {
      location.hash = '#' + route;
      // hashchange 이벤트가 handleHash 호출
    }
  }

  function handleHash() {
    let route = (location.hash || '#home').slice(1);
    if (!ROUTES.includes(route)) route = 'home';

    // 이전 view cleanup
    if (State.currentRoute === 'emit' && route !== 'emit') {
      clearEmitTimeouts();
      resetEmitState();
    }

    // DOM 업데이트
    document.querySelectorAll('.view').forEach(v => {
      v.classList.toggle('on', v.id === 'v-' + route);
    });
    document.querySelectorAll('.bitem').forEach(b => {
      b.classList.toggle('on', b.dataset.route === route);
    });

    State.currentRoute = route;
    document.querySelector('.view.on')?.scrollTo?.(0, 0);

    // 렌더링
    const renderers = {
      home: renderHome,
      emit: renderEmit,
      history: renderHistory,
      points: renderPoints,
      guide: renderGuide,
      settings: renderSettings,
      garden: () => window.RebinGarden && window.RebinGarden.render(),
    };
    renderers[route]?.();
  }

  // =====================================================
  // HOME
  // =====================================================
  /**
   * v2.1: 내 감축 등급 카드 — 영구 사다리형 (누적 GP 승급/강등)
   */
  async function renderReductionGrade() {
    const name = $('rg-name');
    if (!name) return;  // stale cache 방어
    const emoji = $('rg-emoji'), desc = $('rg-desc'), card = $('rg-card');
    const pointWrap = $('rg-point'), pointVal = $('rg-point-val'), pointLbl = $('rg-point-lbl');
    const barWrap = $('rg-bar-wrap'), barFill = $('rg-bar-fill'), barText = $('rg-bar-text');
    const foot = $('rg-foot');

    let rg;
    try { rg = await API.getReductionGrade(); }
    catch (e) { console.warn('[rg] error', e); return; }

    // 베이스라인 미확보
    if (!rg || !rg.hasData || !rg.grade) {
      emoji.textContent = '🌱';
      name.textContent = '베이스라인 측정 중';
      desc.textContent = (rg && rg.message) || '데이터가 쌓이면 감축 등급이 시작됩니다';
      if (card) card.style.borderColor = '';
      pointWrap.hidden = true;
      barWrap.hidden = true;
      foot.textContent = '베이스라인 = 설치 후 첫 3개월 평균 배출량';
      return;
    }

    const g = rg.grade;
    emoji.textContent = g.emoji;
    name.textContent = `${g.name} 등급`;
    desc.textContent = g.desc;
    if (card) card.style.borderColor = g.color + '55';

    // 누적 GP 배지
    pointWrap.hidden = false;
    pointVal.textContent = rg.gp;
    if (pointLbl) pointLbl.textContent = '누적 GP';

    // 다음 등급까지 진행바
    barWrap.hidden = false;
    barFill.style.width = rg.progressPct + '%';
    barFill.style.background = g.color;
    if (rg.next) {
      barText.textContent = `${rg.next.emoji} ${rg.next.name} 등급까지 ${rg.gpToNext} GP`;
    } else {
      barText.textContent = '최고 등급 — DIAMOND 달성! 💎';
    }

    // 이번 달 진행 상황 → 예상 GP 증감
    const tm = rg.thisMonth || {};
    if (tm.status === 'early') {
      foot.textContent = `이번 달 집계 중 · ${tm.currentKg}kg 배출 — 월말 정산 시 GP 반영`;
    } else if (tm.gpDelta > 0) {
      foot.textContent = `이번 달 ${tm.reductionPct}% 감축 예상 → 월말 정산 시 +${tm.gpDelta} GP ⬆`;
    } else if (tm.gpDelta === 0) {
      foot.textContent = `이번 달 ${tm.reductionPct}% 감축 예상 → 정산 시 GP 유지`;
    } else {
      foot.textContent = `이번 달 베이스라인 초과 예상 → 정산 시 −1 GP (강등 주의) ⚠️`;
    }
  }

  async function renderHome() {
    // #5: 챌린지 보너스 자동 클레임 시도
    const claim = await API.tryClaimChallenge();
    if (claim.claimed) {
      toast(`🎉 챌린지 달성! +${claim.bonus}P 적립`, 'success', 3000);
      haptic([20, 50, 20]);
    }

    // v1.2.9: 등급 + 누적 환경 임팩트 자동 갱신 (배출 후 즉시 반영)
    if (typeof window.refreshGradeAndEco === 'function') {
      await window.refreshGradeAndEco();
    }

    // v2.0: 이번 달 감축 등급 카드 갱신
    await renderReductionGrade();

    const user = State.user;
    $('home-greet').textContent = greeting();
    $('home-apt').textContent = user ?
      `${user.apartment} ${user.dong}동 ${user.ho}호` : '—';

    // 병렬 fetch — 직렬보다 빠름 (특히 IndexedDB 트랜잭션 다수일 때)
    // v1.3.0: 동 단위 순위 호출 제거 (사용자 결정)
    const [total, change, points, stats, ch, weeks, all, hourly, carbon] = await Promise.all([
      API.getMonthlyTotal(),
      API.getMonthlyChange(),
      API.getPoints(),
      API.getApartmentStats(),
      API.getChallenge(),
      API.getWeeklyBreakdown(),
      API.getEmissions(),
      API.getHourlyPattern(3),
      API.getCarbonImpact(),
    ]);
    const district = null;  // 호환성 유지용
    const month = API.currentMonth();

    $('home-kg').textContent = total.toFixed(1);
    $('home-kg-base').textContent = user ?
      `기준 ${user.baseLimit}kg/월 (${user.members}인)` : '';
    $('home-pts').textContent = (points.total || 0).toLocaleString();
    $('home-month-lbl').textContent = fmtMonthLabel(month);

    // 트렌드 배지
    const trendEl = $('home-trend');
    if (change == null) {
      trendEl.className = 'hstat-badge neutral';
      trendEl.textContent = '데이터 수집 중';
    } else if (change <= -10) {
      trendEl.className = 'hstat-badge good';
      trendEl.textContent = `↓ ${Math.abs(change)}% 감소 👏`;
    } else if (change < 0) {
      trendEl.className = 'hstat-badge good';
      trendEl.textContent = `↓ ${Math.abs(change)}% 감소`;
    } else if (change === 0) {
      trendEl.className = 'hstat-badge neutral';
      trendEl.textContent = '전월과 동일';
    } else if (change <= 10) {
      trendEl.className = 'hstat-badge neutral';
      trendEl.textContent = `↑ ${change}% 증가`;
    } else {
      trendEl.className = 'hstat-badge bad';
      trendEl.textContent = `↑ ${change}% 증가`;
    }

    // 챌린지 배지 — v1.2.5: 차등 보상 정보 반영
    const chEl = $('home-challenge');
    if (ch.bonus >= 3000) {
      chEl.className = 'hstat-badge gold';
      chEl.textContent = '🏆 30% 달성 +3,000P';
    } else if (ch.bonus >= 2000) {
      chEl.className = 'hstat-badge gold';
      chEl.textContent = '🥈 20% 달성 +2,000P';
    } else if (ch.bonus >= 1000) {
      chEl.className = 'hstat-badge gold';
      chEl.textContent = '🥉 10% 달성 +1,000P';
    } else if (ch.achieved != null && ch.nextTier) {
      chEl.className = 'hstat-badge gold';
      chEl.textContent = `🎯 ${ch.achieved}% / ${ch.nextTier.pct}%`;
    } else {
      chEl.className = 'hstat-badge gold';
      chEl.textContent = '🎯 10% 감량 도전';
    }

    // 주차별 차트
    const max = Math.max(...weeks, 0.5);
    const today = new Date();
    const curWeek = Math.min(4, Math.floor((today.getDate() - 1) / 7));
    const chart = $('week-chart');
    chart.innerHTML = weeks.map((kg, i) => `
      <div class="mth-bar-row">
        <div class="mth-bar-lbl ${i === curWeek ? 'current' : ''}">${i+1}주</div>
        <div class="mth-bar-bg"><div class="mth-bar-fill ${i === curWeek ? 'current' : ''}" style="width:${(kg/max*100).toFixed(0)}%"></div></div>
        <div class="mth-bar-kg ${i === curWeek ? 'current' : ''}">${kg.toFixed(1)} kg</div>
      </div>
    `).join('');

    // 평균 비교 (클릭 시 의미 설명) — v1.2.5: 1인당 비교 + 동 순위 추가
    const avgEl = $('avg-line');
    if (stats.hasData) {
      const cls = stats.better ? 'good' : 'bad';
      const sign = stats.better ? '↓' : '↑';
      const goodIcon = stats.better ? '✓ ' : '⚠ ';  // 색약 대응: 텍스트 아이콘 추가

      // 1인당 무게 정규화 비교 (가구 인원 무관 공평)
      let perPersonHtml = '';
      if (stats.myPerPerson != null) {
        const ppCls = stats.perPersonBetter ? 'good' : 'bad';
        const ppSign = stats.perPersonBetter ? '↓' : '↑';
        const ppIcon = stats.perPersonBetter ? '✓ ' : '⚠ ';
        perPersonHtml = `<div class="avg-pp"><span class="avg-pp-lbl">1인당</span> 나 <b>${stats.myPerPerson}kg</b> · 단지평균 ${stats.aptPerPerson}kg <span class="${ppCls}">${ppIcon}${ppSign} ${Math.abs(stats.perPersonDiff)}kg ${stats.perPersonBetter ? '낮음' : '높음'}</span></div>`;
      }

      // v1.3.0: 동 단위 순위 완전 제거 (사용자 결정)
      // const districtHtml = ''; — 표시 안 함

      avgEl.innerHTML = `<span class="avg-dot"></span>단지 평균 <b>${stats.avgKg}kg</b> · <span class="${cls}">${goodIcon}${sign} ${Math.abs(stats.diff).toFixed(1)}kg ${stats.better ? '낮음' : '높음'}</span> · ${stats.rank}위/${stats.totalUnits}세대 <button class="avg-info-btn" type="button" aria-label="단지 평균 의미 보기" title="자세히 보기">ⓘ</button>${perPersonHtml}`;
    } else {
      avgEl.innerHTML = '<span class="avg-dot"></span>단지 데이터 수집 중 <button class="avg-info-btn" type="button" aria-label="단지 평균 의미 보기">ⓘ</button>';
    }
    // info 버튼 클릭 핸들러
    const infoBtn = avgEl.querySelector('.avg-info-btn');
    if (infoBtn) {
      infoBtn.onclick = (e) => {
        e.stopPropagation();
        showAvgInfoModal();
      };
    }

    // 시간대별 패턴 — grid 정렬로 막대와 라벨 정확히 매칭
    const hourlyMax = Math.max(...hourly, 1);
    const hourlyTotal = hourly.reduce((s, v) => s + v, 0);
    const hourlyChart = $('hourly-chart');
    hourlyChart.innerHTML = hourly.map((cnt, h) => {
      const isPeak = cnt === hourlyMax && cnt > 0;
      const hasData = cnt > 0;
      // 빈 시간대는 작게(2px), 데이터 있는 시간대는 비율로
      const heightPct = hasData ? (cnt / hourlyMax * 100).toFixed(0) : 0;
      return `
        <div class="hourly-bar">
          <div class="hourly-bar-fill ${isPeak ? 'peak' : ''} ${hasData ? 'has-data' : ''}"
               style="height:${heightPct}%"
               aria-label="${h}시 ${cnt}회"></div>
        </div>`;
    }).join('');

    // x축 라벨 — 24칸 grid에서 정확한 위치(0/6/12/18/23 칸)에만 텍스트
    let axisEl = $('hourly-axis');
    if (!axisEl) {
      axisEl = el('div', { id: 'hourly-axis', className: 'hourly-axis-row' });
      hourlyChart.parentElement.insertBefore(axisEl, hourlyChart.nextSibling);
    }
    const labelMap = { 0: '0시', 6: '6시', 12: '정오', 18: '18시', 23: '23시' };
    axisEl.innerHTML = Array.from({ length: 24 }, (_, h) =>
      `<span>${labelMap[h] || ''}</span>`
    ).join('');

    // 인사이트
    const insightEl = $('hourly-insight');
    if (hourlyTotal === 0) {
      insightEl.innerHTML = '<span>📊</span> 데이터가 쌓이면 패턴이 보여요';
    } else {
      const peakHour = hourly.indexOf(hourlyMax);
      const timeLabel = peakHour < 6 ? '새벽' : peakHour < 12 ? '오전' : peakHour < 18 ? '오후' : '저녁';
      const formatHour = (h) => `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}시`;
      insightEl.innerHTML =
        `<span>⏰</span> 주로 <b>${formatHour(peakHour)}</b>대에 배출 (${timeLabel}, 총 ${hourlyTotal}회)`;
    }

    // 환경 임팩트 카드 — status 기반 표시 (정직한 데이터)
    const ecoCo2El = $('eco-co2');
    const ecoTreeEl = $('eco-tree');
    const ecoMsgEl = $('eco-msg');
    if (!carbon.hasData || carbon.status === 'empty') {
      // 빈 상태 (데이터 없음 또는 모두 0)
      ecoCo2El.textContent = '—';
      ecoTreeEl.textContent = '—';
      ecoMsgEl.className = 'eco-msg';
      ecoMsgEl.textContent = carbon.message || '측정 데이터가 쌓이면 임팩트를 보여드릴게요';
    } else if (carbon.status === 'reducing') {
      // 한도 내 — 절감량 + 비용 절감 표시 (월 초반에도 누적값 정확)
      ecoCo2El.textContent = carbon.co2Kg.toFixed(1);
      ecoTreeEl.textContent = carbon.treeEquivalent.toFixed(1);
      ecoMsgEl.className = 'eco-msg';
      ecoMsgEl.innerHTML = `🌱 ${carbon.message}`;
    } else if (carbon.status === 'at_limit') {
      // 한도 정확히 도달
      ecoCo2El.textContent = '0';
      ecoTreeEl.textContent = '0';
      ecoMsgEl.className = 'eco-msg warn';
      ecoMsgEl.innerHTML = `⚠️ ${carbon.message}`;
    } else if (carbon.status === 'over_limit') {
      // 한도 초과
      ecoCo2El.textContent = '0';
      ecoTreeEl.textContent = '0';
      ecoMsgEl.className = 'eco-msg warn';
      ecoMsgEl.innerHTML = `⚠️ ${carbon.message}`;
    }

    // 최근 배출 피드
    const feed = $('home-feed');
    feed.innerHTML = '';
    if (all.length === 0) {
      const user = State.user;
      const baseLimit = user?.baseLimit || 40;
      // 환경부 제6차 폐기물통계조사: 1인당 일반쓰레기 약 0.33kg/일 → 9.9kg/월
      const potentialKg = (baseLimit * 0.2).toFixed(1);  // 20% 감량 가정
      const potentialCo2 = (potentialKg * 0.5).toFixed(1);  // 한국 실측 0.5kg/kg 환산
      feed.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-ico">🌱</div>
          <div class="empty-state-tit">아직 배출 기록이 없어요</div>
          <div class="empty-state-desc">"배출하기"에서 첫 기록을 시작하세요<br>
            <span style="display:inline-block;margin-top:8px;font-size:11.5px;color:var(--g500);font-weight:600">
              💡 단지 평균 대비 20%만 줄여도<br>월 ${potentialKg}kg · CO2 ${potentialCo2}kg 절감
            </span>
          </div>
        </div>`;
    } else {
      all.slice(0, 3).forEach(e => {
        const t = TYPE_NAMES[e.type] || TYPE_NAMES.general;
        const item = el('div', { className: 'feed-item' }, [
          el('div', { className: 'feed-ico' }, t.emoji),
          el('div', { className: 'feed-body' }, [
            el('div', { className: 'feed-time' }, fmtRelative(e.date)),
            el('div', { className: 'feed-title' }, t.name),
          ]),
          el('div', { className: 'feed-kg' }, `${e.weightKg.toFixed(1)} kg`),
        ]);
        feed.appendChild(item);
      });
    }
  }

  // =====================================================
  // EMIT
  // =====================================================
  function resetEmitState() {
    State.emit.state = 'idle';
    State.emit.measuredKg = null;
    $('rfid-area')?.classList.remove('done');
    const icon = $('rfid-area')?.querySelector('.rfid-icon');
    if (icon) icon.textContent = '📳';
    [1, 2, 3, 4].forEach(i => {
      const bub = $('s' + i);
      if (bub) {
        bub.className = 'step-bub';
        bub.textContent = String(i);
      }
    });
    if ($('d1')) $('d1').textContent = '카드를 태그하세요';
    if ($('d2')) $('d2').textContent = '카드 인증 후 자동 개방';
    if ($('d3')) $('d3').textContent = '로드셀 ±50g 정밀 계측';
    if ($('d4')) $('d4').textContent = 'NB-IoT · 서버 기록';
    if ($('emit-cta')) $('emit-cta').textContent = 'RFID 카드 또는 화면 터치';
    if ($('emit-sub')) $('emit-sub').textContent = '카드를 인식부에 가져다 대세요';
    const btn = $('emit-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'RFID 인증 후 사용 가능';
    }
    $('demo-section').hidden = true;
    $('emit-top').hidden = false;
    $('emit-main').hidden = false;
    $('emit-result').hidden = true;
  }

  function renderEmit() {
    resetEmitState();
    const t = TYPE_NAMES[State.emit.type] || TYPE_NAMES.general;
    $('emit-type-name').textContent = `${t.emoji} ${t.name}`;
  }

  function startEmitFlow() {
    if (State.emit.state !== 'idle') return;
    State.emit.state = 'authenticating';
    haptic(20);

    $('rfid-area').classList.add('done');
    $('rfid-area').querySelector('.rfid-icon').textContent = '✓';
    $('emit-cta').textContent = '인증 중...';
    $('emit-sub').textContent = 'RFID 카드 인식 완료';

    // Step 1 → done
    emitTimeout(() => {
      $('s1').className = 'step-bub done';
      $('s1').textContent = '✓';
      $('d1').textContent = '인증 완료';
      $('s2').className = 'step-bub active';
      $('emit-cta').textContent = '투입구가 열립니다';
    }, 700);

    // Step 2 → done, Step 3 active
    emitTimeout(() => {
      $('s2').className = 'step-bub done';
      $('s2').textContent = '✓';
      $('d2').textContent = '개방 완료 (5초)';
      $('s3').className = 'step-bub active';
      $('emit-cta').textContent = '쓰레기를 투입하세요';
      $('emit-sub').textContent = '무게가 자동으로 측정됩니다';
    }, 1800);

    // Step 3 → done, Step 4 active, demo section visible
    emitTimeout(() => {
      $('s3').className = 'step-bub done';
      $('s3').textContent = '✓';
      $('d3').textContent = '측정 완료';
      $('s4').className = 'step-bub active';
      $('emit-cta').textContent = '데이터 전송 중...';
      $('emit-sub').textContent = '서버 동기화';
      $('demo-section').hidden = false;
    }, 3000);

    // Step 4 → done, button enabled
    emitTimeout(() => {
      $('s4').className = 'step-bub done';
      $('s4').textContent = '✓';
      $('d4').textContent = '전송 완료';
      $('emit-cta').textContent = '✅ 모든 단계 완료';
      $('emit-sub').textContent = '아래 무게 확인 후 기록하세요';
      const btn = $('emit-btn');
      btn.disabled = false;
      btn.textContent = '기록하기';
      State.emit.state = 'ready';
      haptic([10, 30, 10]);
    }, 4000);
  }

  async function commitEmit() {
    if (State.emit.state !== 'ready') return;
    const wt = parseFloat($('wt-inp').value);
    try {
      const record = await API.addEmission(wt, { type: State.emit.type, source: 'app' });
      State.emit.measuredKg = record.weightKg;

      // 결과 화면 데이터 채우기
      const total = await API.getMonthlyTotal();
      const stats = await API.getApartmentStats();
      const accuracy = (Math.random() * 0.3 + 0.4).toFixed(1);

      // v1.2.9: 배지 자동 클레임 임시 비활성화 — 포인트 일괄 적립 방지
      // 사용자 결정 후 v1.3.0에서 등급제와 통합 예정
      // const { newlyEarned } = await API._checkBadges();
      const newlyEarned = [];
      const badgeBonus = 0;

      $('res-kg-big').textContent = `${record.weightKg.toFixed(1)} kg`;
      $('res-acc').textContent = `±${accuracy}% 정밀도`;
      $('res-kg').textContent = `${record.weightKg.toFixed(2)} kg`;
      $('res-tot').textContent = `${total.toFixed(1)} kg`;
      if (stats.hasData) {
        const sign = stats.better ? '↓' : '↑';
        $('res-apt').innerHTML = `${sign} ${Math.abs(stats.diff).toFixed(1)}kg <span class="${stats.better ? 'g' : 'r'}">${stats.better ? '낮음' : '높음'}</span>`;
      } else {
        $('res-apt').textContent = '데이터 누적 중';
      }
      // v1.2.9: 명확한 적립 표시 — 챌린지(월간 감량) 달성 시만 적립
      if (badgeBonus > 0) {
        $('res-pts').textContent = `+${badgeBonus.toLocaleString()} P`;
      } else {
        $('res-pts').textContent = '월간 감량 챌린지 달성 시 적립';
      }

      $('emit-top').hidden = true;
      $('emit-main').hidden = true;
      $('emit-result').hidden = false;
      State.emit.state = 'done';
      haptic([20, 50, 20]);

      // 새 배지 알림 — 위에서 이미 _checkBadges 호출했으므로 결과 재사용
      if (newlyEarned && newlyEarned.length > 0) {
        setTimeout(() => {
          const b = newlyEarned[0];
          const bonusText = b.bonus ? ` +${b.bonus.toLocaleString()}P` : '';
          toast(`${b.emoji} 배지 획득: ${b.name}${bonusText}`, 'success', 3000);
          if (newlyEarned.length > 1) {
            setTimeout(() => {
              toast(`+ 배지 ${newlyEarned.length - 1}개 추가 획득!`, 'success', 2500);
            }, 3500);
          }
        }, 1200);
      }
    } catch (e) {
      toast(e.message || '기록 실패', 'error');
    }
  }

  // =====================================================
  // HISTORY
  // =====================================================
  async function renderHistory() {
    if (!State.historyMonth) State.historyMonth = API.currentMonth();
    const month = State.historyMonth;

    // 월 칩 (최근 6개월, 현재월부터)
    const chips = $('mth-chips');
    chips.innerHTML = '';
    for (let i = 0; i < 6; i++) {
      const m = API.relativeMonth(i);
      const chip = el('button', {
        type: 'button',
        className: 'mchip ' + (m === month ? 'on' : ''),
        'data-month': m,
        onClick: () => {
          State.historyMonth = m;
          renderHistory();
        },
      }, fmtMonthFull(m));
      chips.appendChild(chip);
    }

    // 통계
    const list = await API.getEmissions({ month });
    const total = list.reduce((sum, e) => sum + e.weightKg, 0);
    $('hist-total').textContent = `${total.toFixed(1)} kg`;
    $('hist-cnt').textContent = `${list.length} 회`;

    // 전월 대비
    const prevMonth = (() => {
      const [y, m] = month.split('-').map(Number);
      const d = new Date(y, m - 1, 1);
      d.setMonth(d.getMonth() - 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();
    const prevTotal = await API.getMonthlyTotal(prevMonth);
    const changeEl = $('hist-change');
    if (prevTotal === 0) {
      changeEl.className = 'sgrid-val';
      changeEl.textContent = '—';
    } else {
      const pct = Math.round(((total - prevTotal) / prevTotal) * 100);
      changeEl.className = 'sgrid-val ' + (pct < 0 ? 'g' : pct > 0 ? 'r' : '');
      changeEl.textContent = (pct > 0 ? '+' : '') + pct + '%';
    }

    // 리스트
    const listEl = $('hist-list');
    listEl.innerHTML = '';
    if (list.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-ico">📭</div>
          <div class="empty-state-tit">${fmtMonthFull(month)} 배출 기록이 없습니다</div>
          <div class="empty-state-desc">다른 달을 선택하거나 배출하기에서 기록을 남기세요</div>
        </div>`;
      return;
    }
    list.forEach(e => {
      const t = TYPE_NAMES[e.type] || TYPE_NAMES.general;
      const li = el('div', {
        className: 'hist-li hist-li-clickable',
        role: 'button',
        tabindex: '0',
        'aria-label': `${fmtTime(e.date)} ${t.name} ${e.weightKg.toFixed(1)}kg, 탭하여 옵션 열기`,
        onClick: () => showHistoryItemActions(e),
      }, [
        el('div', { className: 'hist-ico' }, t.emoji),
        el('div', { className: 'hinfo' }, [
          el('div', { className: 'hdate' }, fmtTime(e.date)),
          el('div', { className: 'hname' }, t.name),
        ]),
        el('div', { className: 'hkg' }, `${e.weightKg.toFixed(1)} kg`),
      ]);
      // 키보드 접근
      li.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          showHistoryItemActions(e);
        }
      });
      listEl.appendChild(li);
    });
  }

  async function showHistoryItemActions(record) {
    const t = TYPE_NAMES[record.type] || TYPE_NAMES.general;
    const date = new Date(record.date);
    const detail = `${date.toLocaleString('ko-KR')}\n${t.emoji} ${t.name} · ${record.weightKg.toFixed(2)} kg`;
    showModal({
      title: '배출 기록',
      body: detail,
      actions: [
        { label: '닫기' },
        {
          label: '삭제',
          style: 'danger',
          onClick: async () => {
            const ok = await uiConfirm(
              '이 기록을 삭제하시겠습니까?\n이미 적립된 배지·챌린지 포인트는 유지됩니다.',
              { danger: true, confirmLabel: '삭제' }
            );
            if (!ok) return false;  // confirm 취소 → 모달 유지
            try {
              await API.deleteEmission(record.id);
              toast('기록이 삭제되었습니다', 'success');
              if (State.currentRoute === 'history') await renderHistory();
            } catch (e) {
              toast('삭제 실패: ' + e.message, 'error');
              return false;
            }
          },
        },
      ],
    });
  }

  // =====================================================
  // POINTS
  // =====================================================
  async function renderPoints() {
    // #5 챌린지 보너스 자동 클레임
    const claim = await API.tryClaimChallenge();
    if (claim.claimed) {
      toast(`🎉 챌린지 달성! +${claim.bonus.toLocaleString()}P 적립`, 'success', 3000);
    }
    // v1.2.6: 동 단위 순위 보너스 보류 (사용자 결정, v1.3.0+ 재검토)
    // const districtClaim = await API.tryClaimDistrictBonus();
    // if (districtClaim.claimed) {
    //   toast(`📍 동 단위 ${districtClaim.tier}! +${districtClaim.bonus.toLocaleString()}P 적립`, 'success', 3000);
    // }

    const points = await API.getPoints();
    $('pts-num').textContent = (points.total || 0).toLocaleString();

    const sources = points.sources || {};
    // v2.0: 포인트 출처 (배지 + 챌린지)
    $('pts-emission').textContent = `${(sources.badge || 0).toLocaleString()} P`;
    $('pts-carbon').textContent = '— P';
    $('pts-challenge').textContent = `${(sources.challenge || 0).toLocaleString()} P`;

    // v2.5: 정원 교환 / 응모권 내역 (발생한 경우에만 노출)
    const gEx = sources.garden_exchange || 0;
    const gRf = sources.raffle_ticket || 0;
    const gExRow = $('pts-garden-row'), gRfRow = $('pts-raffle-row');
    if (gExRow) { gExRow.hidden = gEx === 0; $('pts-garden').textContent = `+${gEx.toLocaleString()} P`; }
    if (gRfRow) { gRfRow.hidden = gRf === 0; $('pts-raffle').textContent = `${gRf.toLocaleString()} P`; }

    // v2.1: 현재 감축 등급 표시 (누적 GP)
    try {
      const rg = await API.getReductionGrade();
      const rgEl = $('pts-rg-current');
      if (rgEl) {
        if (rg && rg.hasData && rg.grade) {
          rgEl.textContent = `${rg.grade.emoji} ${rg.grade.name} · ${rg.gp}GP`;
          rgEl.style.color = rg.grade.color;
        } else {
          rgEl.textContent = '베이스라인 측정 중';
          rgEl.style.color = '';
        }
      }
    } catch (e) { console.warn('[points] reduction grade', e); }

    // 챌린지 정보 (v1.2.5: 차등 보상 표시)
    const ch = await API.getChallenge();
    if (ch.nextTier) {
      $('ch-target').textContent = `${ch.nextTier.pct}%`;
    } else {
      $('ch-target').textContent = '30%';
    }
    $('ch-achieved').textContent = ch.achieved != null ?
      `${ch.achieved.toFixed(0)}%` : '데이터 부족';

    // 차등 보상 표시 (10/20/30%)
    let bonusText;
    if (ch.bonus > 0) {
      bonusText = `+${ch.bonus.toLocaleString()} P`;
      if (ch.claimed) bonusText += ' (적립됨)';
      if (ch.nextTier) bonusText += ` · 다음 ${ch.nextTier.pct}% +${ch.nextTier.bonus.toLocaleString()}P`;
    } else if (ch.nextTier) {
      bonusText = `${ch.nextTier.pct}% 달성 시 +${ch.nextTier.bonus.toLocaleString()}P`;
    } else {
      bonusText = '+1,000P / +2,000P / +3,000P';
    }
    $('ch-bonus').textContent = bonusText;
    $('ch-days').textContent = `${ch.daysLeft}일 남음`;

    // 배지 (잠금 포함)
    const allDefs = API.getBadgeDefs();
    const earned = await API.getBadges();
    const earnedIds = new Set(earned.map(b => b.id));
    const grid = $('pts-badges');
    grid.innerHTML = '';
    allDefs.forEach(def => {
      const isEarned = earnedIds.has(def.id);
      const bonusText = def.bonus ? `\n보너스: +${def.bonus.toLocaleString()} P` : '';
      const b = el('button', {
        type: 'button',
        className: 'badge-item ' + (isEarned ? '' : 'locked'),
        'aria-label': `${def.name} ${isEarned ? '획득' : '미획득'} - ${def.desc}`,
        onClick: () => uiAlert(
          `${def.emoji} ${def.name}\n\n${def.desc}${bonusText}\n\n` +
          (isEarned ? `획득일: ${new Date(earned.find(b => b.id === def.id).earnedAt).toLocaleDateString()}` : '아직 획득 전'),
          '배지 정보'
        ),
      }, def.emoji);
      grid.appendChild(b);
    });
    $('badge-count').textContent = `${earned.length} / ${allDefs.length}`;
  }

  // =====================================================
  // GUIDE
  // =====================================================
  function renderGuide() {
    // 이미 정적 콘텐츠라 별도 렌더링 불필요
  }

  const GUIDE_DATA = {
    paper: {
      title: '📦 종이류',
      items: [
        ['신문지', '물기 제거 후 끈으로 묶어 배출'],
        ['책·노트', '비닐 코팅·스프링 제거'],
        ['종이팩', '내용물 비우고 헹군 후 압착'],
        ['상자', '테이프·송장 제거 후 펴서 배출'],
        ['전단지', '여러 장 모아서 배출'],
      ],
    },
    plastic: {
      title: '🧴 플라스틱',
      items: [
        ['페트병', '라벨·뚜껑 분리, 헹군 후 압착'],
        ['플라스틱 용기', '내용물 비우고 헹궈서 배출'],
        ['비닐류', '깨끗한 것만, 더러우면 종량제'],
        ['스티로폼', '깨끗한 것만, 음식 묻으면 종량제'],
      ],
    },
    glass: {
      title: '🍶 유리병',
      items: [
        ['빈 병', '내용물 비우고 헹궈서 배출'],
        ['소주·맥주병', '편의점·마트 보증금 환불 가능'],
        ['깨진 유리', '신문지에 싸서 종량제 봉투에'],
      ],
    },
    metal: {
      title: '🥫 캔·고철',
      items: [
        ['알루미늄 캔', '헹궈서 압착 후 배출'],
        ['철 캔', '내용물 비우고 라벨 제거'],
        ['프라이팬', '코팅 손상되면 고철로'],
        ['철사·옷걸이', '묶어서 배출'],
      ],
    },
  };

  function showCategoryGuide(cat) {
    const data = GUIDE_DATA[cat];
    if (!data) return;
    const body = el('div');
    data.items.forEach(([name, desc]) => {
      const row = el('div', { className: 'row' }, [
        el('span', { className: 'rl', style: 'font-weight:600;color:var(--t1)' }, name),
        el('span', { className: 'rv muted', style: 'text-align:right;font-weight:400;font-size:11.5px;max-width:60%' }, desc),
      ]);
      body.appendChild(row);
    });
    showModal({ title: data.title, body, actions: [{ label: '확인', style: 'primary' }] });
  }

  /**
   * 단지 평균 의미 설명 모달 — 사용자가 "왜 이 숫자가 의미있는지" 묻을 수 있어 추가
   */
  function showAvgInfoModal() {
    const body = el('div');
    body.innerHTML = `
      <div style="font-size:13px;line-height:1.7;color:var(--t2)">
        <p style="margin:0 0 10px"><b style="color:var(--t1)">단지 평균</b>은 동일 단지 다른 세대의 월간 배출량 평균입니다.</p>
        <p style="margin:0 0 10px">본인의 배출량이 단지 평균과 비교해 얼마나 낮은지/높은지 보여줍니다 — 같은 환경 다른 세대와의 비교로 본인 위치를 파악할 수 있어요.</p>
        <div style="background:var(--surface-2);padding:10px 12px;border-radius:8px;margin:12px 0">
          <div style="font-size:12px;color:var(--t1);font-weight:600;margin-bottom:4px">📍 현재 단계</div>
          <div style="font-size:11.5px;color:var(--t3)">파일럿 시뮬레이션 값입니다. 정식 도입 시 실제 단지 데이터와 연동됩니다.</div>
        </div>
        <p style="margin:0;font-size:11.5px;color:var(--t4)">개인정보 보호: 다른 세대의 개별 데이터는 표시되지 않으며, 평균값만 익명 집계됩니다.</p>
      </div>
    `;
    showModal({ title: 'ⓘ 단지 평균이란?', body, actions: [{ label: '확인', style: 'primary' }] });
  }

  // =====================================================
  // SETTINGS
  // =====================================================
  async function renderSettings() {
    const user = State.user;
    if (!user) return;
    $('set-apt').textContent = user.apartment;
    $('set-ho').textContent = `${user.dong}동 ${user.ho}호`;
    $('set-tag').textContent = `${user.members}인 가구 · 기준 ${user.baseLimit}kg/월`;
    $('set-members').textContent = `${user.members}인`;

    // 지역 정보 표시 (P45)
    const setRegionEl = $('set-region');
    if (setRegionEl) {
      if (user.region && user.region.sido && user.region.sigungu) {
        setRegionEl.textContent = `${user.region.sido.replace(/특별자치도|특별자치시|특별시|광역시|도/, '')} ${user.region.sigungu}`;
        setRegionEl.classList.remove('muted');
      } else {
        setRegionEl.textContent = '미설정';
        setRegionEl.classList.add('muted');
      }
    }

    // 카드 정보 표시 (P45)
    const setCardEl = $('set-card');
    if (setCardEl) {
      if (user.cardType === 'physical') {
        setCardEl.textContent = '실물카드';
      } else if (user.cardType === 'mobile_nfc') {
        setCardEl.textContent = '휴대폰 NFC';
      } else {
        setCardEl.textContent = '미설정';
        setCardEl.classList.add('muted');
      }
    }

    const noti = await API.getNotificationSettings();
    $('t-pickup').classList.toggle('on', !!noti.pickup);
    $('t-weekly').classList.toggle('on', !!noti.weekly);
    $('t-challenge').classList.toggle('on', !!noti.challenge);
    $('t-push').classList.toggle('on', !!noti.push);

    const themeRaw = API.Local.get(API.KEYS.THEME, 'auto');
    $('set-theme').textContent = { auto: '시스템', light: '라이트', dark: '다크' }[themeRaw] || '시스템';

    // 개발자/시연 모드 섹션 가시성 (stale cache 대응)
    const devMode = API.Local.get(API.KEYS.DEV_MODE, false);
    const devSec = $('set-dev-sec');
    if (devSec) devSec.hidden = !devMode;
  }

  // =====================================================
  // ACTIONS
  // =====================================================
  async function handleAction(action, btn) {
    switch (action) {
      case 'changeMembers': await changeMembers(); break;
      case 'changeAddress': await changeAddress(); break;
      case 'showRegion': await showRegion(); break;
      case 'manageCard': await manageCard(); break;
      case 'rfidPlaceholder':
        toast('정식 도입 시 RFID 카드 등록이 활성화됩니다', 'info', 3000);
        break;
      case 'discountInfant':
      case 'discountMulti':
      case 'discountWelfare':
        toast('감면 신청은 정식 출시 후 활성화됩니다', 'info');
        break;
      case 'chooseTheme': await chooseTheme(); break;
      case 'inviteFriend': await inviteFriend(); break;
      case 'exportData': await exportData(); break;
      case 'importData': await importData(); break;
      case 'contact': await contactUs(); break;
      case 'about': await aboutApp(); break;
      case 'archiveOld': await archiveOldData(); break;
      case 'resetData': await resetData(); break;
      // 시뮬레이터 (about에서 long-press / 5번 탭으로 진입)
      case 'sim': await openSimulator(); break;
      case 'toggleDevMode': await toggleDevMode(); break;
    }
  }

  // P45: 지역 정보 표시
  async function showRegion() {
    const user = State.user;
    if (!user || !user.region) {
      toast('회원가입 시 지역을 설정해주세요', 'info');
      return;
    }
    const r = user.region;
    const stats = window.RegionData ? window.RegionData.getNationalStats() : { avg: 580, min: 440, max: 840 };
    const body = el('div');
    body.innerHTML = `
      <div style="font-size:13px;line-height:1.7;color:var(--t2)">
        <div style="background:linear-gradient(135deg,#E8F5EE,#D6EDDF);border:1px solid #95C9AC;border-radius:12px;padding:14px 16px;margin-bottom:12px">
          <div style="font-size:11px;color:var(--t3);font-weight:600;margin-bottom:4px">📍 거주 지역</div>
          <div style="font-size:18px;font-weight:800;color:var(--g600);margin-bottom:10px">${r.sido} ${r.sigungu}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid rgba(0,0,0,0.08)">
            <span style="font-size:12px;color:var(--t2);font-weight:600">📦 20L 종량제봉투</span>
            <span style="font-size:16px;font-weight:800;color:var(--g600)">${r.price20L.toLocaleString()}원</span>
          </div>
        </div>
        <div style="font-size:12px;color:var(--t3);line-height:1.6">
          <b style="color:var(--t1)">📊 전국 비교</b><br>
          • 전국 평균: <b>${stats.avg}원</b><br>
          • 최저 (과천시): ${stats.min}원<br>
          • 최고 (의정부시): ${stats.max}원<br>
          • 우리 지역은 전국 ${r.price20L < stats.avg ? '평균보다 저렴' : r.price20L > stats.avg ? '평균보다 비쌈' : '평균 수준'}
        </div>
        <div style="font-size:10px;color:var(--t4);margin-top:12px;padding-top:8px;border-top:1px solid var(--border);line-height:1.5">
          출처 · 공공데이터포털 「전국종량제봉투가격표준데이터」 (2026년 기준)<br>
          정식 도입 시 공공데이터 API 자동 갱신
        </div>
      </div>
    `;
    showModal({ title: `📍 ${r.sigungu} 가격 정보`, body, primary: { label: '확인' } });
  }

  // P45: 카드 관리
  async function manageCard() {
    const user = State.user;
    if (!user) return;
    const cardLabel = user.cardType === 'physical' ? '🪪 Re:Bin 실물카드' : '📱 휴대폰 NFC 태그';
    const cardDesc = user.cardType === 'physical'
      ? '실물카드는 회원가입 시 자동 신청됩니다. 휴대폰이 없는 가족(어르신, 어린이)도 사용할 수 있습니다.'
      : '휴대폰을 스마트 쓰레기통에 가까이 대면 자동 인증됩니다. 즉시 사용 가능합니다.';
    const cardStatus = user.cardType === 'physical'
      ? (user.cardRequestedAt
          ? `📬 발급 신청일: ${new Date(user.cardRequestedAt).toLocaleDateString('ko-KR')}<br>📅 도착 예정: 신청 후 약 7일 이내`
          : '신청 정보 없음')
      : '✓ 활성 — 휴대폰 NFC 사용 가능';

    const body = el('div');
    body.innerHTML = `
      <div style="font-size:13px;line-height:1.7;color:var(--t2)">
        <div style="background:rgba(43,129,89,0.06);border:1px solid rgba(43,129,89,0.25);border-radius:12px;padding:14px 16px;margin-bottom:12px">
          <div style="font-size:11px;color:var(--t3);font-weight:600;margin-bottom:4px">현재 인증 수단</div>
          <div style="font-size:16px;font-weight:800;color:var(--t1);margin-bottom:6px">${cardLabel}</div>
          <div style="font-size:12px;color:var(--t2)">${cardDesc}</div>
        </div>
        <div style="font-size:12px;color:var(--t3);line-height:1.6;margin-bottom:10px">
          <b style="color:var(--t1)">📊 카드 정보</b><br>
          • RFID ID: <code style="background:var(--surface-2);padding:2px 6px;border-radius:4px;font-size:11px">${user.rfidId}</code><br>
          • 등록일: ${new Date(user.joinedAt).toLocaleDateString('ko-KR')}<br>
          • 상태: ${cardStatus}
        </div>
        <div style="font-size:11px;color:var(--t4);background:var(--surface-2);padding:10px 12px;border-radius:10px;line-height:1.5">
          💡 카드 변경은 정식 도입 후 활성화됩니다. 파일럿 단계에서는 RFID ID가 자동 발급되며, 데이터는 기기에만 저장됩니다.
        </div>
      </div>
    `;
    showModal({ title: '🪪 인증 카드 관리', body, primary: { label: '확인' } });
  }

  async function toggleDevMode() {
    const ok = await uiConfirm(
      '시연 모드를 끄시겠습니까?\n\n다시 활성화하려면 설정 → 버전을 5번 빠르게 탭하세요.',
      { confirmLabel: '끄기' }
    );
    if (!ok) return;
    API.Local.set(API.KEYS.DEV_MODE, false);
    toast('시연 모드가 비활성화되었습니다', 'success');
    await renderSettings();
  }

  async function changeMembers() {
    const user = State.user;
    const list = el('div', { className: 'sheet-list' });
    [1,2,3,4,5,6,7,8,9,10].forEach(n => {
      const item = el('button', {
        type: 'button',
        className: 'sheet-list-item ' + (user.members === n ? 'selected' : ''),
        onClick: async () => {
          close();
          if (user.members === n) return;
          // baseLimit 변동 안내
          const oldLimit = user.baseLimit;
          const newLimit = 10 * n;
          if (oldLimit !== newLimit) {
            const ok = await uiConfirm(
              `세대원이 ${user.members}인 → ${n}인으로 변경됩니다.\n\n` +
              `월 기준 배출량: ${oldLimit}kg → ${newLimit}kg\n` +
              `과거 기록은 그대로 유지되지만, 단지 평균 비교 등 통계는 새 기준으로 재계산됩니다.\n\n` +
              `계속하시겠습니까?`,
              { confirmLabel: '변경' }
            );
            if (!ok) return;
          }
          try {
            await API.updateUser({ members: n });
            State.user = await API.getUser();
            toast(`세대원 ${n}인 (기준 ${newLimit}kg/월)으로 변경됨`, 'success', 2500);
            // #6: 영향 받는 view 모두 갱신
            await renderSettings();
            if (State.currentRoute === 'home') await renderHome();
          } catch (e) {
            toast('변경 실패: ' + (e.message || ''), 'error', 3000);
          }
        },
      }, [
        el('div', { className: 'sli-name' }, `${n}인`),
        el('div', { className: 'sli-desc' }, `기준 배출량 ${10*n}kg/월`),
      ]);
      list.appendChild(item);
    });
    const close = sheet({ title: '세대원 수 변경', body: list });
  }

  async function changeAddress() {
    const user = State.user;

    // DOM API로 안전하게 입력 폼 구성 (innerHTML 사용 시 XSS 위험)
    const wrap = el('div');
    const stack = el('div', { style: 'display:flex;flex-direction:column;gap:10px;margin:8px 0' });
    const aptInput = el('input', {
      className: 'rebin-modal-input', id: 'ca-apt',
      placeholder: '아파트명', maxlength: '30', autocomplete: 'off',
    });
    aptInput.value = user.apartment;  // .value로 set → escape 자동 처리
    const row = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px' });
    const dongInput = el('input', {
      className: 'rebin-modal-input', id: 'ca-dong',
      placeholder: '동', inputmode: 'numeric', maxlength: '6', autocomplete: 'off',
    });
    dongInput.value = user.dong;
    const hoInput = el('input', {
      className: 'rebin-modal-input', id: 'ca-ho',
      placeholder: '호', inputmode: 'numeric', maxlength: '6', autocomplete: 'off',
    });
    hoInput.value = user.ho;
    row.appendChild(dongInput);
    row.appendChild(hoInput);
    stack.appendChild(aptInput);
    stack.appendChild(row);
    wrap.appendChild(stack);

    showModal({
      title: '주소 변경',
      body: wrap,
      actions: [
        { label: '취소' },
        {
          label: '저장',
          style: 'primary',
          onClick: async () => {
            const apt = aptInput.value.trim();
            const dong = dongInput.value.trim();
            const ho = hoInput.value.trim();
            if (!apt || !dong || !ho) {
              toast('모든 항목을 입력해주세요', 'error');
              return false;
            }
            try {
              await API.updateUser({ apartment: apt, dong, ho });
              State.user = await API.getUser();
              toast('주소가 변경되었습니다', 'success');
              await renderSettings();
              if (State.currentRoute === 'home') await renderHome();
            } catch (e) {
              toast('변경 실패: ' + (e.message || '알 수 없는 오류'), 'error', 3000);
              return false;  // 모달 유지 (사용자가 수정 가능하게)
            }
          },
        },
      ],
    });
  }

  async function chooseTheme() {
    const cur = API.Local.get(API.KEYS.THEME, 'auto');
    const list = el('div', { className: 'sheet-list' });
    const opts = [
      { val: 'auto',  name: '시스템 설정 따르기', desc: '기기 설정에 맞춰 자동 변경' },
      { val: 'light', name: '라이트 모드',       desc: '밝은 배경' },
      { val: 'dark',  name: '다크 모드',         desc: '어두운 배경' },
    ];
    opts.forEach(o => {
      const item = el('button', {
        type: 'button',
        className: 'sheet-list-item ' + (cur === o.val ? 'selected' : ''),
        onClick: () => {
          close();
          API.Local.set(API.KEYS.THEME, o.val);
          applyTheme(o.val);
          renderSettings();
          toast(`테마: ${o.name}`, 'success', 1500);
        },
      }, [
        el('div', { className: 'sli-name' }, o.name),
        el('div', { className: 'sli-desc' }, o.desc),
      ]);
      list.appendChild(item);
    });
    const close = sheet({ title: '테마 선택', body: list });
  }

  function applyTheme(theme) {
    const dark = theme === 'dark' ||
      (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  async function inviteFriend() {
    // #16: rfidId 노출 없이 referral URL만
    const url = location.origin + location.pathname + '?ref=invite';
    const body = el('div', { className: 'invite-body' });
    body.innerHTML = `
      <div style="font-size:13px;color:var(--t3);line-height:1.6;margin-bottom:14px">
        Re:Bin과 함께 환경을 지켜주세요!<br>
        <b>버리는 순간, 보입니다 🌱</b>
      </div>
      <div class="invite-url" id="inv-url">${url}</div>
      <div class="invite-hint">친구가 Re:Bin을 사용하면 둘 다 +50 P 적립</div>
    `;
    showModal({
      title: '🎁 친구 초대',
      body,
      actions: [
        { label: '닫기' },
        {
          label: navigator.share ? '공유하기' : 'URL 복사',
          style: 'primary',
          onClick: async () => {
            try {
              if (navigator.share) {
                await navigator.share({
                  title: 'Re:Bin',
                  text: '버리는 순간, 보입니다',
                  url,
                });
              } else {
                await navigator.clipboard.writeText(url);
                toast('URL이 복사되었습니다', 'success');
              }
            } catch (e) {
              if (e.name !== 'AbortError') {
                toast('공유에 실패했습니다', 'error');
              }
              return false;
            }
          },
        },
      ],
    });
  }

  async function exportData() {
    try {
      const data = await API.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      a.href = URL.createObjectURL(blob);
      a.download = `rebin-backup-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('백업 파일이 다운로드되었습니다', 'success');
    } catch (e) {
      toast('백업 실패: ' + e.message, 'error');
    }
  }

  async function importData() {
    const ok = await uiConfirm(
      '복원 시 현재 데이터가 모두 백업본으로 교체됩니다.\n계속하시겠습니까?\n\n* 테마/언어 설정은 유지됩니다',
      { danger: true, confirmLabel: '파일 선택' }
    );
    if (!ok) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const dispose = showLoader('app-main');
        try {
          const result = await API.importData(data);
          State.user = await API.getUser();
          const msg = result.emissionsImported > 0
            ? `복원 완료 (배출기록 ${result.emissionsImported}개)`
            : '복원 완료 (배출기록 없음)';
          toast(msg, 'success', 2500);
          go('home');
        } finally {
          dispose();
        }
      } catch (e) {
        toast('복원 실패: ' + (e.message || '잘못된 파일'), 'error', 3000);
      }
    });
    input.click();
  }

  async function contactUs() {
    await uiAlert(
      '📧 contact@rebin.kr\n📞 1599-0000\n\n파일럿 운영 시간: 평일 10:00~18:00\n\n* 정식 출시 후 1:1 채팅 지원 예정',
      '문의하기'
    );
  }

  let aboutTapCount = 0;
  let aboutTapResetTimer;
  let aboutShowTimer;
  async function aboutApp() {
    // 5번 빠르게 탭하면 시연 모드 활성화 (설정에 시뮬레이터 노출)
    aboutTapCount++;
    clearTimeout(aboutTapResetTimer);
    clearTimeout(aboutShowTimer);
    aboutTapResetTimer = setTimeout(() => { aboutTapCount = 0; }, 1800);

    if (aboutTapCount >= 5) {
      aboutTapCount = 0;
      const wasDev = API.Local.get(API.KEYS.DEV_MODE, false);
      if (!wasDev) {
        API.Local.set(API.KEYS.DEV_MODE, true);
        toast('🧪 시연 모드 활성화 — 설정에서 시뮬레이터 사용 가능', 'success', 3000);
        await renderSettings();
      } else {
        // 이미 활성화된 상태면 시뮬레이터 직접 열기
        await openSimulator();
      }
      return;
    }

    // 짧은 디바운스: 600ms 안에 추가 탭이 없을 때만 일반 정보 모달 표시
    aboutShowTimer = setTimeout(showAboutModal, 600);
  }

  async function showAboutModal() {
    await uiAlert(
      `Re:Bin v${API.config.version} (파일럿)\n\n` +
      `IoT 기반 폐기물 데이터·자원순환 인프라\n` +
      `버리는 순간, 보입니다 🌱\n\n` +
      `© 2026 Re:Bin · 대표 J.han\n` +
      `큐네스티 임팩트 트랙\n\n` +
      `* 5번 빠르게 탭하면 데모 도구가 열립니다`,
      '앱 정보'
    );
  }

  async function resetData() {
    const ok = await uiConfirm(
      '모든 배출 기록·포인트·세대 정보가 삭제됩니다.\n이 작업은 되돌릴 수 없습니다.\n\n계속하시겠습니까?',
      { danger: true, confirmLabel: '초기화' }
    );
    if (!ok) return;
    await API.reset();
    location.reload();
  }

  async function archiveOldData() {
    const list = el('div', { className: 'sheet-list' });
    let close;
    [
      { years: 1, label: '1년 이전 데이터 정리', desc: '12개월보다 오래된 기록 삭제' },
      { years: 2, label: '2년 이전 데이터 정리', desc: '권장 — 통계는 충분, 용량 확보' },
      { years: 3, label: '3년 이전 데이터 정리', desc: '장기 보관 후 정리' },
    ].forEach(opt => {
      const item = el('button', {
        type: 'button',
        className: 'sheet-list-item',
        onClick: async () => {
          if (close) close();
          const ok = await uiConfirm(
            `${opt.years}년 이전 배출 기록을 삭제합니다.\n` +
            `포인트와 배지는 유지됩니다.\n\n계속하시겠습니까?`,
            { danger: true, confirmLabel: '정리' }
          );
          if (!ok) return;
          try {
            const dispose = showLoader('app-main');
            const result = await API.archiveOldEmissions(opt.years);
            dispose();
            if (result.deleted === 0) {
              toast(`정리할 ${opt.years}년 이전 데이터가 없습니다`, 'info');
            } else {
              toast(`${result.deleted}개 정리됨 (${result.kept}개 유지)`, 'success', 2500);
            }
            if (State.currentRoute === 'history') await renderHistory();
            if (State.currentRoute === 'home') await renderHome();
          } catch (e) {
            toast('정리 실패: ' + e.message, 'error');
          }
        },
      }, [
        el('div', { className: 'sli-name' }, opt.label),
        el('div', { className: 'sli-desc' }, opt.desc),
      ]);
      list.appendChild(item);
    });
    close = sheet({ title: '📦 오래된 데이터 정리', body: list });
  }

  // =====================================================
  // SIMULATOR (개발/데모)
  // =====================================================
  async function openSimulator() {
    const wrap = el('div', { className: 'sim-wrap' });
    wrap.innerHTML = `
      <div class="sim-desc">데모/시연용 데이터 생성 도구</div>
    `;
    const buttons = [
      { label: '🔴 LIVE 측정 시뮬레이션 (IoT 시연)', fn: () => simulateLiveIoT(), highlight: true },
      { label: '📊 60일치 30개 기록 생성', fn: () => simulateData(30, 60) },
      { label: '📈 90일치 60개 기록 생성', fn: () => simulateData(60, 90) },
      { label: '🏆 챌린지 달성 시나리오 (감량 25%)', fn: () => simulateReduction() },
      { label: '🌱 정원 데모 (13개월 감축 스토리)', fn: () => simulateGardenStory() },
      { label: '🗑️ 모든 배출 기록 삭제', fn: () => clearOnlyEmissions() },
    ];
    buttons.forEach(b => {
      const btn = el('button', {
        type: 'button',
        className: 'sim-btn' + (b.highlight ? ' sim-btn-live' : ''),
        onClick: async () => { close(); await b.fn(); },
      }, b.label);
      wrap.appendChild(btn);
    });
    const close = sheet({ title: '🧪 시뮬레이터', body: wrap });
  }

  /**
   * P46: LIVE IoT 시뮬레이션 — 실제 IoT 흐름 시연
   *
   * 4단계 자동 시연:
   * 1. RFID/앱 인증 (사용자 카드 매칭)
   * 2. 투입 + 자동 측정 (로드셀)
   * 3. 클라우드 전송 (서버 동기화)
   * 4. 앱 자동 갱신 + 알림
   *
   * 5초마다 자동 측정. 사용자는 아무것도 하지 않음.
   */
  let liveSimRunning = false;
  let liveSimTimer = null;
  let liveSimCount = 0;

  async function simulateLiveIoT() {
    if (liveSimRunning) {
      stopLiveSim();
      return;
    }
    const user = State.user;
    if (!user) { toast('회원가입이 필요합니다', 'error'); return; }

    liveSimRunning = true;
    liveSimCount = 0;

    // 4단계 진행 상황 모달
    const stepsHtml = `
      <div class="iot-sim-wrap">
        <div class="iot-sim-step" data-step="1">
          <div class="iot-step-num">1</div>
          <div class="iot-step-body">
            <div class="iot-step-tit">RFID/앱 인증</div>
            <div class="iot-step-msg" id="iot-msg-1">대기 중...</div>
          </div>
          <div class="iot-step-status" id="iot-status-1">⚪</div>
        </div>
        <div class="iot-sim-step" data-step="2">
          <div class="iot-step-num">2</div>
          <div class="iot-step-body">
            <div class="iot-step-tit">투입 + 자동 측정</div>
            <div class="iot-step-msg" id="iot-msg-2">대기 중...</div>
          </div>
          <div class="iot-step-status" id="iot-status-2">⚪</div>
        </div>
        <div class="iot-sim-step" data-step="3">
          <div class="iot-step-num">3</div>
          <div class="iot-step-body">
            <div class="iot-step-tit">클라우드 전송</div>
            <div class="iot-step-msg" id="iot-msg-3">대기 중...</div>
          </div>
          <div class="iot-step-status" id="iot-status-3">⚪</div>
        </div>
        <div class="iot-sim-step" data-step="4">
          <div class="iot-step-num">4</div>
          <div class="iot-step-body">
            <div class="iot-step-tit">앱 자동 갱신</div>
            <div class="iot-step-msg" id="iot-msg-4">대기 중...</div>
          </div>
          <div class="iot-step-status" id="iot-status-4">⚪</div>
        </div>
        <div class="iot-sim-info">
          <div class="iot-sim-info-row">
            <span>총 측정</span>
            <b id="iot-count">0회</b>
          </div>
          <div class="iot-sim-info-row">
            <span>5초마다 자동 측정</span>
            <span class="iot-pulse">🔴 LIVE</span>
          </div>
        </div>
        <button class="sim-btn" id="iot-stop-btn" type="button" style="margin-top:12px;background:var(--red);color:white">⏸ 시뮬레이션 중단</button>
      </div>
    `;
    const wrap = el('div');
    wrap.innerHTML = stepsHtml;
    const close = sheet({ title: '🔴 LIVE IoT 시뮬레이션', body: wrap });

    $('iot-stop-btn').onclick = () => { stopLiveSim(); close(); };

    // 즉시 1회 시작 + 5초마다 반복
    runOneIotCycle(user);
    liveSimTimer = setInterval(() => {
      if (!liveSimRunning) { clearInterval(liveSimTimer); return; }
      runOneIotCycle(user);
    }, 5000);
  }

  function stopLiveSim() {
    liveSimRunning = false;
    if (liveSimTimer) { clearInterval(liveSimTimer); liveSimTimer = null; }
    toast(`LIVE 시뮬레이션 종료 (총 ${liveSimCount}회 측정)`, 'success');
  }

  async function runOneIotCycle(user) {
    if (!liveSimRunning) return;

    // 랜덤 무게 (1.5~6kg) + 80% 일반, 15% 음식물, 5% 재활용
    const r = Math.random();
    const type = 'general';  // 단일화: 항상 일반쓰레기
    const weight = (1.5 + Math.random() * 4.5).toFixed(1);
    const typeLabel = TYPE_NAMES[type].name;
    const typeEmoji = TYPE_NAMES[type].emoji;

    // === STEP 1: RFID 인증 ===
    setIotStep(1, 'in_progress', `RFID 카드 ${user.rfidId.slice(0, 6)}... 스캔 중`);
    await sleep(500);
    setIotStep(1, 'done', `✓ ${user.apartment} ${user.dong}동 ${user.ho}호 인증 완료`);

    // === STEP 2: 투입 + 측정 ===
    setIotStep(2, 'in_progress', `${typeEmoji} ${typeLabel} 투입 감지... 무게 측정 중`);
    await sleep(700);
    setIotStep(2, 'done', `✓ 로드셀 측정: ${weight}kg`);

    // === STEP 3: 클라우드 전송 ===
    setIotStep(3, 'in_progress', `NB-IoT 데이터 전송 중...`);
    await sleep(600);
    setIotStep(3, 'done', `✓ 서버 동기화 완료 (${new Date().toLocaleTimeString('ko-KR')})`);

    // === STEP 4: 앱 갱신 ===
    setIotStep(4, 'in_progress', `데이터 처리 중...`);
    await API.addEmission(parseFloat(weight), { type });
    liveSimCount++;
    if ($('iot-count')) $('iot-count').textContent = `${liveSimCount}회`;
    setIotStep(4, 'done', `✓ 누적 갱신 완료 (이번 측정: ${weight}kg)`);

    // 토스트로 사용자에게 알림
    toast(`🔔 ${typeLabel} ${weight}kg 측정 완료 (자동)`, 'success', 2500);

    // 홈 화면이면 자동 갱신
    if (State.currentRoute === 'home') {
      await renderHome();
    } else if (State.currentRoute === 'history') {
      await renderHistory();
    }

    // 1초 후 모든 스텝 리셋 (다음 사이클 준비)
    setTimeout(() => {
      if (!liveSimRunning) return;
      for (let i = 1; i <= 4; i++) setIotStep(i, 'idle', '대기 중...');
    }, 1500);
  }

  function setIotStep(n, state, msg) {
    const stepEl = document.querySelector(`.iot-sim-step[data-step="${n}"]`);
    const msgEl = $(`iot-msg-${n}`);
    const statusEl = $(`iot-status-${n}`);
    if (!stepEl || !msgEl || !statusEl) return;
    stepEl.classList.remove('idle', 'in_progress', 'done');
    stepEl.classList.add(state);
    msgEl.textContent = msg;
    statusEl.textContent = state === 'in_progress' ? '🟡' : state === 'done' ? '🟢' : '⚪';
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function simulateData(count, days) {
    const dispose = showLoader('app-main');
    try {
      const records = [];
      const now = Date.now();
      const types = ['general'];  // 단일화
      for (let i = 0; i < count; i++) {
        const dayOffset = Math.floor(Math.random() * days);
        const date = new Date(now - dayOffset * 86400000);
        date.setHours(8 + Math.floor(Math.random() * 14));
        date.setMinutes(Math.floor(Math.random() * 60));
        const wt = Math.round((0.5 + Math.random() * 4.5) * 100) / 100;
        const type = types[Math.floor(Math.random() * types.length)];
        records.push({ date, weightKg: wt, type, source: 'sim' });
      }
      const n = await API.addEmissionsBulk(records);
      toast(`${n}개의 데모 기록이 생성되었습니다`, 'success');
      // 현재 화면 재렌더
      handleHash();
    } catch (e) {
      toast('생성 실패: ' + e.message, 'error');
    } finally {
      dispose();
    }
  }

  /**
   * v2.5: 정원 데모 — 13개월 감축 스토리 시딩
   * 첫 3개월(베이스라인 ~월 30kg) 이후 점진 감축 → 정원 물방울·등급·스트릭이 살아있는 상태로.
   */
  async function simulateGardenStory() {
    const dispose = showLoader('app-main');
    try {
      const records = [];
      const now = new Date();
      // m개월 전의 '그 달 중순' 날짜들
      const monthlyKg = [30, 29, 31, 26, 24, 22, 21, 19, 18, 17, 16, 15, 14]; // 13개월 (오래된 → 최근)
      monthlyKg.forEach((totalKg, i) => {
        const monthsAgo = monthlyKg.length - i;   // 13 … 1
        const base = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
        const n = 10;                              // 월 10회 배출
        for (let k = 0; k < n; k++) {
          const d = new Date(base.getFullYear(), base.getMonth(), 2 + Math.floor(Math.random() * 25),
                             8 + Math.floor(Math.random() * 13), Math.floor(Math.random() * 60));
          const wt = Math.round((totalKg / n) * (0.8 + Math.random() * 0.4) * 100) / 100;
          records.push({ date: d, weightKg: wt, type: 'general', source: 'sim' });
        }
      });
      const n = await API.addEmissionsBulk(records);
      toast(`🌱 정원 데모 생성 완료 — ${n}개 기록 (13개월). 정원 탭에서 확인하세요!`, 'success', 3200);
      handleHash();
    } catch (e) {
      toast('생성 실패: ' + e.message, 'error');
    } finally {
      dispose();
    }
  }

  async function simulateReduction() {
    const dispose = showLoader('app-main');
    try {
      // 전월에 많이 (총 20kg), 이번달에 적게 (총 15kg, -25%) — 챌린지 달성 시나리오
      const records = [];
      const prev = API.relativeMonth(1);
      const cur = API.currentMonth();
      const [py, pm] = prev.split('-').map(Number);
      const [cy, cm] = cur.split('-').map(Number);

      // 전월 기록 (10개, 총 ~20kg)
      for (let i = 0; i < 10; i++) {
        const day = Math.floor(Math.random() * 28) + 1;
        const date = new Date(py, pm - 1, day, 9 + Math.floor(Math.random() * 12));
        records.push({ date, weightKg: 1.8 + Math.random() * 0.8, type: 'general' });
      }
      // 이번달 기록 (8개, 총 ~15kg)
      const today = new Date().getDate();
      for (let i = 0; i < 8; i++) {
        const day = Math.max(1, Math.floor(Math.random() * today));
        const date = new Date(cy, cm - 1, day, 9 + Math.floor(Math.random() * 12));
        records.push({ date, weightKg: 1.5 + Math.random() * 0.8, type: 'general' });
      }
      await API.addEmissionsBulk(records);
      // 챌린지 자동 적립
      const claim = await API.tryClaimChallenge();
      if (claim.claimed) {
        toast(`챌린지 달성! +${claim.bonus}P`, 'success');
      } else {
        toast('시나리오 데이터 생성 완료', 'success');
      }
      handleHash();
    } catch (e) {
      toast('생성 실패: ' + e.message, 'error');
    } finally {
      dispose();
    }
  }

  async function clearOnlyEmissions() {
    const ok = await uiConfirm('모든 배출 기록을 삭제합니다. 계속할까요?', { danger: true });
    if (!ok) return;
    try {
      await API.clearEmissionsOnly();
      toast('배출 기록이 삭제되었습니다', 'success');
      handleHash();
    } catch (e) {
      toast('삭제 실패: ' + (e.message || ''), 'error');
    }
  }

  // =====================================================
  // TOGGLE HANDLER
  // =====================================================
  async function handleToggle(key) {
    const noti = await API.getNotificationSettings();
    const newVal = !noti[key];

    // 푸시 토글: 권한 요청
    if (key === 'push' && newVal) {
      if (!('Notification' in window)) {
        toast('이 기기는 알림을 지원하지 않습니다', 'error');
        return;
      }
      // 권한 요청 (실제 subscribe는 서버 준비 시점에)
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        toast('알림 권한이 거부되었습니다', 'error');
        return;
      }
      toast('권한 승인됨 (서버 준비 중 — 정식 출시 시 활성화)', 'info', 3000);
    }

    await API.setNotification(key, newVal);
    $('t-' + key).classList.toggle('on', newVal);
    haptic(8);
  }

  // =====================================================
  // SHARE / TYPE PICKER
  // =====================================================
  async function shareApp() {
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Re:Bin',
          text: '버리는 순간, 보입니다 🌱',
          url: location.origin + location.pathname,
        });
      } else {
        await navigator.clipboard.writeText(location.origin + location.pathname);
        toast('URL이 복사되었습니다', 'success');
      }
    } catch (e) {
      if (e.name !== 'AbortError') toast('공유 실패', 'error');
    }
  }

  async function pickEmitType() {
    // 단일화: 종류 선택 시트 비활성화 (생활폐기물 전용)
    return;
    // ↓ 아래 코드는 도달하지 않음 (backward compat)
    const list = el('div', { className: 'sheet-list' });
    let close;
    Object.entries(TYPE_NAMES).forEach(([key, t]) => {
      const desc = '감량/배지/순위로 적립';
      const item = el('button', {
        type: 'button',
        className: 'sheet-list-item ' + (State.emit.type === key ? 'selected' : ''),
        onClick: () => {
          if (close) close();
          State.emit.type = key;
          $('emit-type-name').textContent = `${t.emoji} ${t.name}`;
        },
      }, [
        el('div', { className: 'sli-name' }, `${t.emoji} ${t.name}`),
        el('div', { className: 'sli-desc' }, desc),
      ]);
      list.appendChild(item);
    });
    close = sheet({ title: '배출 종류 선택', body: list });
  }

  async function showYearReport() {
    const dispose = showLoader('app-main');
    try {
      const r = await API.getYearReport();
      const max = Math.max(...r.byMonth, 0.5);
      const curMonth = new Date().getMonth();  // 0~11
      const wrap = el('div');

      // 통계 영역
      const stats = el('div', { className: 'yr-stats' });
      stats.innerHTML = `
        <div class="yr-stat"><div class="yr-stat-lbl">총 배출</div><div class="yr-stat-val">${r.total} kg</div></div>
        <div class="yr-stat"><div class="yr-stat-lbl">배출 횟수</div><div class="yr-stat-val">${r.count} 회</div></div>
        <div class="yr-stat"><div class="yr-stat-lbl">평균</div><div class="yr-stat-val">${r.avg} kg</div></div>
      `;
      wrap.appendChild(stats);

      if (r.count === 0) {
        const empty = el('div', { className: 'yr-empty' },
          `${r.year}년 배출 기록이 없습니다`);
        wrap.appendChild(empty);
      } else {
        const chart = el('div', { className: 'yr-chart' });
        r.byMonth.forEach((kg, i) => {
          const isCurrent = i === curMonth;
          const bar = el('div', {
            className: 'yr-bar' + (isCurrent ? ' current' : ''),
            'aria-label': `${i+1}월 ${kg.toFixed(1)}kg`,
          }, [
            el('div', { className: 'yr-bar-bg' }, [
              el('div', {
                className: 'yr-bar-fill',
                style: `height:${(kg/max*100).toFixed(0)}%`
              }),
            ]),
            el('div', { className: 'yr-bar-kg' }, kg > 0 ? kg.toFixed(1) : '·'),
            el('div', { className: 'yr-bar-lbl' }, `${i+1}월`),
          ]);
          chart.appendChild(bar);
        });
        wrap.appendChild(chart);
      }
      dispose();
      showModal({
        title: `📅 ${r.year}년 리포트`,
        body: wrap,
        actions: [{ label: '확인', style: 'primary' }],
      });
    } catch (e) {
      dispose();
      toast('리포트 생성 실패', 'error');
    }
  }

  async function setGoalDialog() {
    const cur = await API.getGoals();
    const list = el('div', { className: 'sheet-list' });
    [10, 15, 20, 25, 30].forEach(p => {
      const item = el('button', {
        type: 'button',
        className: 'sheet-list-item ' + (cur.monthlyTarget === p ? 'selected' : ''),
        onClick: async () => {
          close();
          await API.setGoal(p);
          toast(`목표가 ${p}% 감량으로 설정되었습니다`, 'success');
          if (State.currentRoute === 'points') await renderPoints();
          if (State.currentRoute === 'home') await renderHome();
        },
      }, [
        el('div', { className: 'sli-name' }, `${p}% 감량`),
        el('div', { className: 'sli-desc' },
          p <= 10 ? '쉬움 — 가볍게 시작' :
          p <= 20 ? '보통 — 권장 수준' :
          '어려움 — 챌린지 모드'),
      ]);
      list.appendChild(item);
    });
    const close = sheet({ title: '🎯 월간 목표 설정', body: list });
  }

  // =====================================================
  // ONBOARDING
  // =====================================================
  // ============== 5-STEP ONBOARDING WIZARD ==============
  function showOnboarding() {
    $('app-main').hidden = true;
    $('onboarding').classList.add('show');

    let currentStep = 1;
    const TOTAL_STEPS = 5;
    // 사용자가 입력한 데이터 임시 저장
    const wizardState = {
      sido: '',
      sigungu: '',
      price20L: 0,
      apartment: '',
      dong: '',
      ho: '',
      members: 4,
      cardType: 'mobile_nfc',  // 기본값
      consented: false,
    };

    // 스텝 표시 갱신
    function showStep(n) {
      // 모든 스텝 숨김
      for (let i = 1; i <= TOTAL_STEPS; i++) {
        $(`ob-step-${i}`).removeAttribute('data-active');
      }
      // 대상 스텝만 표시
      $(`ob-step-${n}`).setAttribute('data-active', 'true');
      // 도트 인디케이터 갱신
      document.querySelectorAll('.ob-step-dot').forEach(dot => {
        const step = parseInt(dot.dataset.step);
        dot.classList.remove('active', 'done');
        if (step < n) dot.classList.add('done');
        else if (step === n) dot.classList.add('active');
      });
      // 스크롤 최상단
      window.scrollTo({ top: 0, behavior: 'smooth' });
      currentStep = n;
    }

    // ===== STEP 1: 환영 =====
    $('ob-next-1').onclick = () => showStep(2);

    // ===== STEP 2: 지역 선택 =====
    const sidoSelect = $('ob-sido');
    const sigunguSelect = $('ob-sigungu');
    const regionInfo = $('ob-region-info');
    const next2Btn = $('ob-next-2');

    // 시도 옵션 채우기 (1회만)
    if (sidoSelect.options.length <= 1) {
      window.RegionData.getSidoList().forEach(sido => {
        const opt = document.createElement('option');
        opt.value = sido;
        opt.textContent = sido;
        sidoSelect.appendChild(opt);
      });
    }

    sidoSelect.onchange = () => {
      const sido = sidoSelect.value;
      sigunguSelect.innerHTML = '<option value="">선택해주세요</option>';
      sigunguSelect.disabled = !sido;
      regionInfo.hidden = true;
      next2Btn.disabled = true;
      if (sido) {
        window.RegionData.getSigunguList(sido).forEach(sg => {
          const opt = document.createElement('option');
          opt.value = sg;
          opt.textContent = sg;
          sigunguSelect.appendChild(opt);
        });
      }
    };

    sigunguSelect.onchange = () => {
      const sido = sidoSelect.value;
      const sigungu = sigunguSelect.value;
      if (sido && sigungu) {
        const price = window.RegionData.getPrice(sido, sigungu);
        const stats = window.RegionData.getNationalStats();
        wizardState.sido = sido;
        wizardState.sigungu = sigungu;
        wizardState.price20L = price;
        $('ob-ri-price').textContent = `${price.toLocaleString()}원`;
        $('ob-ri-avg').textContent = `${stats.avg.toLocaleString()}원 (${stats.min}~${stats.max}원)`;
        regionInfo.hidden = false;
        next2Btn.disabled = false;
      } else {
        regionInfo.hidden = true;
        next2Btn.disabled = true;
      }
    };

    $('ob-prev-2').onclick = () => showStep(1);
    next2Btn.onclick = () => showStep(3);

    // ===== STEP 3: 세대 정보 =====
    const aptInput = $('ob-apt');
    const dongInput = $('ob-dong');
    const hoInput = $('ob-ho');
    const membersInput = $('ob-members');
    const baselinePreview = $('ob-bp-kg');

    // 세대원 수 변경 → 한도 미리보기
    function updateBaselinePreview() {
      const members = parseInt(membersInput.value) || 4;
      baselinePreview.textContent = `${members * 10}kg`;
    }
    membersInput.onchange = updateBaselinePreview;
    updateBaselinePreview();

    $('ob-prev-3').onclick = () => showStep(2);
    $('ob-next-3').onclick = () => {
      const apt = aptInput.value.trim();
      const dong = dongInput.value.trim();
      const ho = hoInput.value.trim();
      if (!apt) { toast('아파트명을 입력해주세요', 'error'); aptInput.focus(); return; }
      if (!dong) { toast('동을 입력해주세요', 'error'); dongInput.focus(); return; }
      if (!ho) { toast('호수를 입력해주세요', 'error'); hoInput.focus(); return; }
      wizardState.apartment = apt;
      wizardState.dong = dong;
      wizardState.ho = ho;
      wizardState.members = parseInt(membersInput.value);
      showStep(4);
    };

    // ===== STEP 4: 동의 =====
    const consentCheckbox = $('ob-consent');
    const next4Btn = $('ob-next-4');
    consentCheckbox.onchange = () => {
      next4Btn.disabled = !consentCheckbox.checked;
      wizardState.consented = consentCheckbox.checked;
    };
    $('ob-terms-link').onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showTermsModal();
    };
    $('ob-prev-4').onclick = () => showStep(3);
    next4Btn.onclick = () => {
      if (!consentCheckbox.checked) {
        toast('개인정보 수집에 동의해주세요', 'error');
        return;
      }
      showStep(5);
    };

    // ===== STEP 5: 카드 발급 =====
    document.querySelectorAll('input[name="ob-card"]').forEach(radio => {
      radio.onchange = () => {
        wizardState.cardType = radio.value;
        const actualArea = $('ob-actual-rfid-area');
        if (actualArea) {
          actualArea.style.display = radio.value === 'physical_actual' ? 'block' : 'none';
        }
      };
    });
    $('ob-prev-5').onclick = () => showStep(4);

    $('ob-submit').onclick = async () => {
      try {
        // 유저 등록 (지역/카드 정보 포함)
        let actualRfid = null;
        if (wizardState.cardType === 'physical_actual') {
          const inp = $('ob-actual-rfid');
          actualRfid = inp ? inp.value.toUpperCase().replace(/[^0-9A-F]/g,'') : '';
          if (!actualRfid || actualRfid.length < 8 || actualRfid.length > 14) {
            toast('PN532 RFID UID는 8~14자 hex여야 합니다 (예: 04A52BC3D2)', 'error');
            return;
          }
        }
        await API.completeOnboarding({
          apartment: wizardState.apartment,
          dong: wizardState.dong,
          ho: wizardState.ho,
          members: wizardState.members,
          region: {
            sido: wizardState.sido,
            sigungu: wizardState.sigungu,
            price20L: wizardState.price20L,
          },
          cardType: wizardState.cardType,
          actualRfid: actualRfid,
        });
        // 서버에도 등록 (옵션 — 서버 미연결 시 graceful)
        try {
          const user = await API.getUser();
          if (window.RebinSync && window.RebinSync.serverUrl) {
            await fetch(window.RebinSync.serverUrl + '/api/v1/users', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                rfid_uid: user.rfidId, apartment: user.apartment,
                dong: user.dong, ho: user.ho, members: user.members,
              }),
            });
            window.RebinSync.connect(user.rfidId);
          }
        } catch (e) { console.warn('[Sync] Server offline:', e.message); }
        // 동의 시점 기록 (PIPA 요건)
        API.Local.set(API.KEYS.CONSENT, {
          agreed: true,
          agreedAt: new Date().toISOString(),
          version: '1.1.0',
        });
        State.user = await API.getUser();
        $('onboarding').classList.remove('show');
        $('app-main').hidden = false;
        // 카드 발급 후속 안내
        const cardMsg = wizardState.cardType === 'physical'
          ? `${wizardState.apartment}에 오신 것을 환영해요! 🌱\n실물카드는 7일 내 우편 발송됩니다`
          : `${wizardState.apartment}에 오신 것을 환영해요! 🌱\n휴대폰 NFC로 즉시 사용 가능합니다`;
        toast(cardMsg, 'success', 4500);
        go('home');
      } catch (e) {
        toast('등록 실패: ' + e.message, 'error');
      }
    };

    // 초기 진입 — Step 1
    showStep(1);
  }

  function showTermsModal() {
    const body = el('div');
    body.innerHTML = `
      <div style="font-size:12px;line-height:1.7;color:var(--t2)">
        <h4 style="margin:0 0 6px;font-size:13px;color:var(--t1)">📋 개인정보 처리 (요약)</h4>
        <p style="margin:0 0 14px">
          • <b>수집 항목</b>: 아파트명, 동, 호수, 세대원 수, RFID 카드 ID, 배출 무게·시간<br>
          • <b>보관 위치</b>: <b style="color:var(--g500)">사용자 기기 (IndexedDB / localStorage)</b><br>
          • <b>외부 전송</b>: <b style="color:var(--g500)">없음</b> (파일럿 단계 한정)<br>
          • <b>보관 기간</b>: 사용자가 직접 삭제할 때까지<br>
          • <b>삭제 방법</b>: 설정 → 데이터 초기화
        </p>
        <h4 style="margin:0 0 6px;font-size:13px;color:var(--t1)">⚖️ 이용약관 (요약)</h4>
        <p style="margin:0 0 14px">
          • 본 서비스는 <b>파일럿 단계</b>로 무게 측정·기록 기능만 제공됩니다.<br>
          • 정식 출시 전까지 실제 과금이 발생하지 않습니다.<br>
          • 데이터는 사용자 본인만 접근 가능합니다.<br>
          • 정식 도입 시 별도 동의 절차가 진행됩니다.
        </p>
        <h4 style="margin:0 0 6px;font-size:13px;color:var(--t1)">🔒 정식 출시 시 추가 사항</h4>
        <p style="margin:0 0 8px">
          • 서버 동기화 (선택 동의)<br>
          • 단지/지자체 익명화 통계 활용<br>
          • 탄소포인트제·슈퍼빈 등 외부 연동
        </p>
        <p style="margin:8px 0 0;font-size:11px;color:var(--t4);padding-top:10px;border-top:1px solid var(--border)">
          문의: contact@rebin.kr<br>
          © 2026 그린빈(GreenBin)
        </p>
      </div>
    `;
    showModal({
      title: '약관 및 개인정보 처리방침',
      body,
      actions: [{ label: '확인', style: 'primary' }],
    });
  }

  /**
   * 기존 사용자 (v1.0.0에서 업그레이드, consent 없음) 동의 마이그레이션 모달
   * - dismissOnBackdrop / dismissOnEsc 비활성화
   * - 체크박스 토글 시에만 "계속" 활성화
   * - 거부하면 앱 사용 차단
   */
  async function ensureLegacyConsent() {
    // 이미 동의했으면 skip (race 방어)
    const cur = API.Local.get(API.KEYS.CONSENT);
    if (cur && cur.agreed) return;

    const body = el('div');
    const intro = el('div', {
      style: 'font-size:13px;line-height:1.6;color:var(--t2);margin-bottom:14px',
    });
    intro.innerHTML = `
      Re:Bin v1.1.0부터 <b>개인정보 처리방침</b> 명시적 동의가 필요합니다.<br>
      기존 사용자도 한 번만 확인 부탁드립니다.
    `;
    body.appendChild(intro);

    const consentRow = el('label', {
      style: 'display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:10px;background:var(--surface-2);border-radius:8px',
    });
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.style.cssText = 'width:20px;height:20px;margin:0;flex-shrink:0;accent-color:var(--g500);';
    const label = el('span', {
      style: 'font-size:13px;color:var(--t1);line-height:1.5',
    });
    label.innerHTML = `
      <b>개인정보 처리방침 및 이용약관</b>에 동의합니다
      <button type="button" class="legacy-terms-link" style="display:inline-block;color:var(--g500);font-weight:600;font-size:12px;background:none;border:none;text-decoration:underline;padding:0 2px;margin-left:4px;cursor:pointer">자세히 보기</button>
    `;
    consentRow.appendChild(checkbox);
    consentRow.appendChild(label);
    body.appendChild(consentRow);

    showModal({
      title: '🔒 개인정보 처리 동의',
      body,
      dismissOnBackdrop: false,
      dismissOnEsc: false,
      actions: [
        {
          label: '계속',
          style: 'primary',
          onClick: () => {
            if (!checkbox.checked) {
              toast('약관 동의가 필요합니다', 'error');
              return false;
            }
            API.Local.set(API.KEYS.CONSENT, {
              agreed: true,
              agreedAt: new Date().toISOString(),
              version: '1.1.0',
              migration: true,  // 기존 사용자 마이그레이션 표시
            });
            toast('동의 처리되었습니다', 'success');
          },
        },
      ],
    });

    // 약관 보기 링크 (모달이 DOM에 추가된 후 바인딩)
    setTimeout(() => {
      const termsBtn = document.querySelector('.legacy-terms-link');
      if (termsBtn) {
        termsBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showTermsModal();
        });
      }
    }, 100);
  }

  // =====================================================
  // INSTALL PROMPT
  // =====================================================
  function setupInstallBanner() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      State.deferredInstallPrompt = e;
      const dismissed = API.Local.get(API.KEYS.INSTALL_DISMISS, false);
      if (!dismissed) {
        setTimeout(() => $('install-banner').classList.add('show'), 4000);
      }
    });

    // iOS Safari는 beforeinstallprompt를 지원하지 않음 → 별도 안내
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                         window.navigator.standalone === true;
    if (isIos && !isStandalone) {
      const dismissed = API.Local.get(API.KEYS.INSTALL_DISMISS, false);
      if (!dismissed) {
        setTimeout(() => {
          $('install-banner').classList.add('show');
          // iOS 안내 텍스트로 변경
          const tit = document.querySelector('#install-banner .install-tit');
          const desc = document.querySelector('#install-banner .install-desc');
          const btn = $('install-btn');
          if (tit) tit.textContent = '홈 화면에 추가';
          if (desc) desc.textContent = 'Safari 공유 → 홈 화면에 추가';
          if (btn) btn.textContent = '안내';
        }, 4000);
      }
    }

    $('install-btn').onclick = async () => {
      const e = State.deferredInstallPrompt;
      if (!e && isIos) {
        $('install-banner').classList.remove('show');
        await uiAlert(
          'iOS에서 Re:Bin을 앱처럼 사용하려면:\n\n' +
          '1. Safari 하단 공유 버튼 (□↑) 탭\n' +
          '2. "홈 화면에 추가" 선택\n' +
          '3. 추가 버튼 탭\n\n' +
          '홈 화면 아이콘으로 빠르게 접속할 수 있어요',
          '📲 홈 화면에 추가'
        );
        return;
      }
      $('install-banner').classList.remove('show');
      if (!e) return;
      e.prompt();
      const result = await e.userChoice;
      if (result.outcome === 'accepted') toast('설치되었습니다!', 'success');
      State.deferredInstallPrompt = null;
    };

    $('install-close').onclick = () => {
      $('install-banner').classList.remove('show');
      API.Local.set(API.KEYS.INSTALL_DISMISS, true);
    };
  }

  // =====================================================
  // EVENT BINDING
  // =====================================================
  function bindGlobalEvents() {
    // 라우팅 (data-route)
    document.body.addEventListener('click', (e) => {
      const routeBtn = e.target.closest('[data-route]');
      if (routeBtn) { go(routeBtn.dataset.route); return; }

      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) { handleAction(actionBtn.dataset.action, actionBtn); return; }

      const toggleBtn = e.target.closest('[data-toggle]');
      if (toggleBtn) { handleToggle(toggleBtn.dataset.toggle); return; }

      const catBtn = e.target.closest('[data-cat]');
      if (catBtn) { showCategoryGuide(catBtn.dataset.cat); return; }
    });

    // 헤더/홈
    bindClick('hdr-logo', () => go('home'));
    bindClick('btn-share', shareApp);
    bindClick('btn-history-more', () => go('history'));

    // 배출 화면
    bindClick('btn-type', pickEmitType);
    bindClick('btn-emit-cancel', () => go('home'));
    bindClick('btn-emit-confirm', () => go('home'));
    bindClick('btn-emit-again', () => resetEmitState());  // 신규 (stale cache 가능)
    bindClick('emit-btn', commitEmit);

    // RFID 영역 (클릭 + 키보드)
    const rfid = $('rfid-area');
    if (rfid) {
      rfid.addEventListener('click', startEmitFlow);
      rfid.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          startEmitFlow();
        }
      });
    }

    // History / Points 헤더 버튼
    bindClick('btn-year', showYearReport);
    bindClick('btn-goal', setGoalDialog);

    // Pilot banner close
    bindClick('pilot-close', () => {
      $('pilot-banner').style.display = 'none';
      API.Local.set(API.KEYS.PILOT_BANNER, true);
    });

    // Hash routing
    window.addEventListener('hashchange', handleHash);

    // 시스템 테마 변경 감지
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const theme = API.Local.get(API.KEYS.THEME, 'auto');
      if (theme === 'auto') applyTheme('auto');
    });

    // 페이지 visibility — 다시 보이면 챌린지 자동 적립 시도
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && State.initialized) {
        const claim = await API.tryClaimChallenge();
        if (claim.claimed) {
          toast(`🎉 챌린지 달성! +${claim.bonus}P 적립`, 'success', 3000);
          if (State.currentRoute === 'home') await renderHome();
          if (State.currentRoute === 'points') await renderPoints();
        }
      }
    });
  }

  // =====================================================
  // SERVICE WORKER
  // =====================================================
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js')
        .then(reg => console.log('[SW] registered', reg.scope))
        .catch(err => console.warn('[SW] register failed', err));
    });
  }

  // =====================================================
  // INIT
  // =====================================================
  async function init() {
    State.splashAt = Date.now();

    try {
      // 데이터 레이어 초기화
      await API.init();

      // 사용자 로드
      State.user = await API.getUser();

      // 파일럿 배너
      if (API.Local.get(API.KEYS.PILOT_BANNER, false)) {
        $('pilot-banner').style.display = 'none';
      }

      // 글로벌 이벤트 바인딩
      bindGlobalEvents();
      setupInstallBanner();
      registerSW();

      // 온보딩 vs 메인
      if (!API.isOnboarded() || !State.user) {
        hideSplash();
        showOnboarding();
      } else {
        // 온보딩 이미 완료된 경우: 메인 앱 표시
        $('app-main').hidden = false;
        // 초기 라우팅 (해시 없으면 home)
        if (!ROUTES.includes((location.hash || '#home').slice(1))) {
          location.hash = '#home';
        } else {
          handleHash();
        }
        hideSplash();

        // 기존 사용자 (v1.0.0 등에서 업그레이드) PIPA 동의 마이그레이션
        // onboarded=true인데 consent가 없으면 추가 동의 받음
        const consent = API.Local.get(API.KEYS.CONSENT);
        if (!consent || !consent.agreed) {
          // splash 사라진 후 모달 표시
          setTimeout(() => ensureLegacyConsent(), 800);
        }
      }
      State.initialized = true;
    } catch (e) {
      console.error('[init] 초기화 실패', e);
      // 어떤 경우에도 splash는 사라지게
      hideSplash();
      // 사용자에게 에러 알림
      setTimeout(() => {
        toast('앱 초기화 중 오류가 발생했습니다. 페이지를 새로고침해 주세요', 'error', 5000);
      }, 700);
    }
  }

  // splash가 절대 무한히 표시되지 않도록 안전장치 (10초 후 강제 제거)
  setTimeout(() => {
    const splash = document.getElementById('splash');
    if (splash) {
      console.warn('[init] splash 강제 제거 — init() 미완료');
      splash.classList.add('hide');
      setTimeout(() => splash.remove(), 500);
    }
  }, 10000);

  // #15: splash 최소 600ms 유지
  function hideSplash() {
    const elapsed = Date.now() - State.splashAt;
    const wait = Math.max(0, 600 - elapsed);
    setTimeout(() => {
      const splash = $('splash');
      if (splash) {
        splash.classList.add('hide');
        setTimeout(() => splash.remove(), 500);
      }
    }, wait);
  }

  // 부팅
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();


// ═══════════════════════════════════════════════════════
// v1.2.7 신규 UI: 등급 카드 + 누적 환경 임팩트 토글
// ═══════════════════════════════════════════════════════
(function() {
  'use strict';

  let _ecoMode = 'month'; // 'month' or 'total'

  // v2.0: 누적 포인트 등급 카드 제거 — 감축 등급(SEEDLING~DIAMOND)으로 일원화.
  // 감축 등급 렌더링은 app.js renderReductionGrade()가 담당한다.

  /**
   * 환경 임팩트 갱신 (월별 / 누적 토글) — v1.3.1 디버깅 강화
   */
  async function renderEcoImpact(mode) {
    if (!window.RebinAPI || !window.RebinAPI.getCumulativeImpact) {
      console.warn('[eco] RebinAPI.getCumulativeImpact 미정의');
      return;
    }
    // mode 우선순위: 인자 > window._ecoMode > _ecoMode
    _ecoMode = mode || window._ecoMode || _ecoMode;
    window._ecoMode = _ecoMode;
    console.log('[Re:Bin v1.3.4] renderEcoImpact mode:', _ecoMode);

    try {
      const impact = await window.RebinAPI.getCumulativeImpact();
      const data = (_ecoMode === 'total') ? impact.total : impact.month;
      console.log('[eco] data:', _ecoMode, data);

      const co2El = document.getElementById('eco-co2');
      const treeEl = document.getElementById('eco-tree');
      const msgEl = document.getElementById('eco-msg');

      if (co2El) co2El.textContent = data.co2 > 0 ? data.co2.toFixed(1) : '—';
      if (treeEl) treeEl.textContent = data.trees > 0 ? data.trees.toFixed(2) : '—';

      if (msgEl) {
        // v1.3.4: 데이터 유무 정확한 판단 (monthCount 또는 actualKg 기준)
        const hasData = (impact.total && impact.total.monthCount > 0) ||
                        (impact.month && impact.month.actualKg > 0);

        if (!hasData) {
          msgEl.textContent = '측정 데이터가 쌓이면 임팩트를 보여드릴게요';
        } else if (_ecoMode === 'total') {
          // v1.3.3: 누적 = 모든 월 절감량 합
          const months = impact.total.monthCount || 1;
          const target = impact.total.monthlyTarget || 40;
          if (data.saved > 0) {
            msgEl.innerHTML = `<strong>📊 ${months}개월 누적 절감</strong><br/>총 ${data.saved.toFixed(1)}kg 절감 → CO2 ${data.co2.toFixed(1)}kg, 나무 ${data.trees.toFixed(2)}그루 효과`;
          } else {
            // v1.3.4: 모든 월 한도 초과한 경우
            msgEl.innerHTML = `<strong>📊 ${months}개월 누적</strong><br/>한도 초과 — 다음 달 ${target}kg 이하로 줄이면 절감 시작 ⬇️`;
          }
        } else {
          // v1.3.3: 이번 달 = 이번 달만 절감량
          const monthLabel = data.label || '이번 달';
          const actualKgSafe = (typeof data.actualKg === 'number' ? data.actualKg : 0).toFixed(1);
          if (data.saved > 0) {
            msgEl.innerHTML = `<strong>📅 ${monthLabel} 절감</strong><br/>한도 ${data.target}kg 중 ${actualKgSafe}kg 배출 → <strong>${data.saved.toFixed(1)}kg 절감</strong> (CO2 ${data.co2.toFixed(1)}kg, 나무 ${data.trees.toFixed(2)}그루)`;
          } else {
            // v1.3.4: 이번 달 한도 초과
            msgEl.innerHTML = `<strong>📅 ${monthLabel}</strong><br/>한도 ${data.target}kg 중 ${actualKgSafe}kg 배출 — 한도 ${(Number(actualKgSafe) - data.target).toFixed(1)}kg 초과 ⚠️`;
          }
        }
      }

      // 탭 활성화 상태
      document.querySelectorAll('.eco-tab').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-eco-tab') === _ecoMode);
      });
    } catch (e) {
      console.error('[eco] error:', e);
    }
  }

  // v1.3.1: 글로벌 노출 (inline script가 직접 호출 가능)
  window._renderEcoImpactReal = renderEcoImpact;

  // 탭 클릭 핸들러 (이벤트 위임)
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.eco-tab');
    if (tab) {
      const mode = tab.getAttribute('data-eco-tab');
      if (mode) renderEcoImpact(mode);
    }
  });

  // 직접 바인딩 (DOM 로드 후) — fallback
  function bindEcoTabs() {
    document.querySelectorAll('.eco-tab').forEach(btn => {
      // 중복 바인딩 방지
      if (btn.dataset.ecoBound === '1') return;
      btn.dataset.ecoBound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const mode = btn.getAttribute('data-eco-tab');
        if (mode) renderEcoImpact(mode);
      });
    });
  }

  // 글로벌 노출 (HTML onclick에서 호출)
  window.setEcoMode = function(mode) {
    renderEcoImpact(mode);
  };

  // 홈 화면 진입 시 자동 갱신 (DOM 로드 후 + 데이터 변경 시)
  function refreshAll() {
    renderEcoImpact();
    bindEcoTabs();  // 매번 바인딩 시도 (중복 방지 처리됨)
  }

  // 1초마다 또는 데이터 변경 이벤트 시 (대신 DOM ready 후 한 번 + visibility 변경 시)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(refreshAll, 500));
  } else {
    setTimeout(refreshAll, 500);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAll();
  });

  // 글로벌 노출 (다른 곳에서 갱신 시)
  window.refreshGradeAndEco = refreshAll;
})();

// ═══════════════════════════════════════════════════════
// v1.3.0 변경: 등급 도달 시 자동 보너스 비활성화
// 사용자 결정: "등급별당 포인트 나중에 생각할게 일단 이런식으로 가자"
// ═══════════════════════════════════════════════════════
(function() {
  'use strict';

  // 등급 도달 시 보너스 — 모두 0 (사용자 결정 후 v1.3.x에서 결정)
  const GRADE_BONUSES = {
    'SEEDLING': 0,
    'SPROUT':   0,
    'TREE':     0,
    'FOREST':   0,
    'DIAMOND':  0
  };

  // 보너스 비활성화 — 빈 함수
  async function checkGradeBonus() {
    // v1.3.0: 비활성화. 사용자 결정 후 활성화 예정.
    return;
  }

  window.checkGradeBonus = checkGradeBonus;
})();
