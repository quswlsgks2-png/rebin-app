/**
 * Re:Bin UI Components v1.1.0
 * - 더 나은 애니메이션
 * - 모달 \n 줄바꿈 보존 (CSS pre-line)
 * - body scroll lock
 * - ESC로 모달 닫기
 */

const UI = (function () {
  'use strict';

  // ============================================================
  // DOM helpers
  // ============================================================
  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'className') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;  // 신뢰된 정적 콘텐츠만
      else if (k.startsWith('on') && typeof v === 'function') {
        e.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        e.setAttribute(k, v);
      }
    });
    if (typeof children === 'string') {
      e.textContent = children;
    } else if (Array.isArray(children)) {
      children.forEach(c => c && e.appendChild(c));
    } else if (children instanceof Node) {
      e.appendChild(children);
    }
    return e;
  }

  function $(id) { return document.getElementById(id); }
  function $$(sel, root = document) { return root.querySelectorAll(sel); }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  // ============================================================
  // Body scroll lock 관리
  // ============================================================
  let scrollLockCount = 0;
  function lockScroll() {
    if (scrollLockCount === 0) {
      document.body.style.overflow = 'hidden';
    }
    scrollLockCount++;
  }
  function unlockScroll() {
    scrollLockCount = Math.max(0, scrollLockCount - 1);
    if (scrollLockCount === 0) {
      document.body.style.overflow = '';
    }
  }

  // ============================================================
  // Toast
  // ============================================================
  let toastTimer;
  function toast(msg, type = 'info', duration = 2200) {
    let t = $('rebin-toast');
    if (!t) {
      t = el('div', { id: 'rebin-toast', className: 'rebin-toast', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'rebin-toast show toast-' + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), duration);
  }

  // ============================================================
  // Modal stack (ESC 처리)
  // ============================================================
  const modalStack = [];

  function escHandler(e) {
    if (e.key === 'Escape' && modalStack.length > 0) {
      const top = modalStack[modalStack.length - 1];
      if (top.dismissOnEsc !== false) top.close();
    }
  }
  document.addEventListener('keydown', escHandler);

  function showModal(opts = {}) {
    const overlay = el('div', { className: 'rebin-modal-overlay', role: 'presentation' });
    const card = el('div', {
      className: 'rebin-modal-card',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': opts.title ? 'rebin-modal-title' : null,
    });

    if (opts.title) {
      card.appendChild(el('div', {
        className: 'rebin-modal-title',
        id: 'rebin-modal-title'
      }, opts.title));
    }
    if (opts.body) {
      if (typeof opts.body === 'string') {
        card.appendChild(el('div', { className: 'rebin-modal-body' }, opts.body));
      } else {
        const wrap = el('div', { className: 'rebin-modal-body' });
        wrap.appendChild(opts.body);
        card.appendChild(wrap);
      }
    }

    if (opts.actions && opts.actions.length > 0) {
      const actions = el('div', { className: 'rebin-modal-actions' });
      opts.actions.forEach(a => {
        const btn = el('button', {
          className: 'rebin-modal-btn ' + (a.style || ''),
          type: 'button',
          onClick: async () => {
            if (a.onClick) {
              try {
                const result = await a.onClick();
                if (result === false) return;  // 닫지 않음
              } catch (e) {
                console.error('[Modal] action error', e);
                return;
              }
            }
            close();
          }
        }, a.label);
        actions.appendChild(btn);
      });
      card.appendChild(actions);
    }

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    lockScroll();
    requestAnimationFrame(() => overlay.classList.add('show'));

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      // 닫히는 중 stale 클릭 방지: 즉시 pointer-events 차단
      overlay.style.pointerEvents = 'none';
      overlay.classList.add('closing');
      overlay.classList.remove('show');
      setTimeout(() => {
        overlay.remove();
        unlockScroll();
      }, 280);
      const idx = modalStack.findIndex(m => m.close === close);
      if (idx >= 0) modalStack.splice(idx, 1);
    }

    if (opts.dismissOnBackdrop !== false) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });
    }

    modalStack.push({ close, dismissOnEsc: opts.dismissOnEsc !== false });
    return close;
  }

  function alert(msg, title = '알림') {
    return new Promise((resolve) => {
      showModal({
        title,
        body: msg,
        actions: [{ label: '확인', style: 'primary', onClick: resolve }],
      });
    });
  }

  function confirm(msg, opts = {}) {
    return new Promise((resolve) => {
      showModal({
        title: opts.title || '확인',
        body: msg,
        actions: [
          { label: opts.cancelLabel || '취소', onClick: () => resolve(false) },
          {
            label: opts.confirmLabel || '확인',
            style: opts.danger ? 'danger' : 'primary',
            onClick: () => resolve(true),
          },
        ],
      });
    });
  }

  function prompt(opts) {
    return new Promise((resolve) => {
      const input = el('input', {
        className: 'rebin-modal-input',
        type: opts.inputType || 'text',
        inputmode: opts.inputMode || 'text',
        placeholder: opts.placeholder || '',
        value: opts.value || '',
        autocomplete: 'off',
      });

      const body = el('div');
      if (opts.body) body.appendChild(el('div', {}, opts.body));
      body.appendChild(input);

      const close = showModal({
        title: opts.title || '입력',
        body,
        actions: [
          { label: '취소', onClick: () => resolve(null) },
          {
            label: '확인',
            style: 'primary',
            onClick: () => {
              const v = input.value;
              if (opts.validate) {
                try { opts.validate(v); }
                catch (e) { toast(e.message, 'error'); return false; }
              }
              resolve(v);
            },
          },
        ],
      });

      setTimeout(() => input.focus(), 100);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          // 확인 버튼 클릭
          const btns = document.querySelectorAll('.rebin-modal-btn.primary');
          const okBtn = btns[btns.length - 1];
          if (okBtn) okBtn.click();
        }
      });
    });
  }

  // ============================================================
  // Bottom Sheet
  // ============================================================
  function sheet(opts) {
    const overlay = el('div', { className: 'rebin-sheet-overlay', role: 'presentation' });
    const sheetEl = el('div', { className: 'rebin-sheet', role: 'dialog' });

    sheetEl.appendChild(el('div', { className: 'rebin-sheet-handle', 'aria-hidden': 'true' }));

    if (opts.title) {
      sheetEl.appendChild(el('div', { className: 'rebin-sheet-title' }, opts.title));
    }
    if (opts.body) {
      if (typeof opts.body === 'string') {
        sheetEl.appendChild(el('div', { className: 'rebin-sheet-body' }, opts.body));
      } else {
        sheetEl.appendChild(opts.body);
      }
    }

    overlay.appendChild(sheetEl);
    document.body.appendChild(overlay);
    lockScroll();
    requestAnimationFrame(() => overlay.classList.add('show'));

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      // 닫히는 중 stale 클릭 방지
      overlay.style.pointerEvents = 'none';
      overlay.classList.add('closing');
      overlay.classList.remove('show');
      setTimeout(() => {
        overlay.remove();
        unlockScroll();
      }, 280);
      const idx = modalStack.findIndex(m => m.close === close);
      if (idx >= 0) modalStack.splice(idx, 1);
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    modalStack.push({ close, dismissOnEsc: true });
    return close;
  }

  // ============================================================
  // Loading skeleton
  // ============================================================
  function showLoader(target) {
    target = typeof target === 'string' ? $(target) : target;
    if (!target) return () => {};
    const overlay = el('div', { className: 'rebin-loader-overlay' }, [
      el('div', { className: 'rebin-spinner' }),
    ]);
    const id = 'loader_' + (target.id || Math.random().toString(36).slice(2));
    overlay.id = id;
    target.style.position = target.style.position || 'relative';
    target.appendChild(overlay);
    return () => overlay.remove();
  }

  // ============================================================
  // Haptic feedback (지원되는 기기에서만)
  // ============================================================
  function haptic(pattern = 10) {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch {}
    }
  }

  return {
    el, $, $$, clear,
    toast, alert, confirm, prompt, sheet, showModal,
    showLoader, haptic,
  };
})();

window.UI = UI;

// v1.3.4: window.toast 직접 노출 (inline script + IIFE 외부 코드에서 사용)
window.toast = UI.toast;
window.haptic = UI.haptic;
