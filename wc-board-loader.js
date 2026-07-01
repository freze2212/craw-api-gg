/** wc-board-loader v4 — no bet button + iframe auto-height */
(function () {
  var boardTimers = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var iframeResizeTimer = null;

  function inIframe() {
    try {
      return window.parent !== window;
    } catch (e) {
      return true;
    }
  }

  (function injectIframeEmbedCss() {
    if (!inIframe() || document.getElementById('wc-iframe-embed-css')) return;
    var s = document.createElement('style');
    s.id = 'wc-iframe-embed-css';
    s.textContent =
      'html,body{margin:0!important;padding:0!important;overflow:visible!important;'
      + 'height:auto!important;min-height:0!important;max-height:none!important;'
      + 'overscroll-behavior:none!important;-webkit-overflow-scrolling:auto!important;}';
    (document.head || document.documentElement).appendChild(s);
  })();

  function measurePageHeight() {
    var root = document.documentElement;
    var body = document.body;
    var nodes = document.querySelectorAll('.content-html, .wc-top-banner, .schedule-wrapper');
    var maxBottom = 0;
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      maxBottom = Math.max(maxBottom, r.bottom + window.scrollY);
    }
    return Math.max(
      maxBottom,
      root ? root.scrollHeight : 0,
      root ? root.offsetHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
    );
  }

  function notifyIframeHeight() {
    if (!inIframe()) return;
    try {
      window.parent.postMessage({ type: 'wc-iframe-resize', height: measurePageHeight() }, '*');
    } catch (e) {}
  }

  function scheduleIframeHeightNotify() {
    if (!inIframe()) return;
    if (iframeResizeTimer) clearTimeout(iframeResizeTimer);
    iframeResizeTimer = setTimeout(notifyIframeHeight, 40);
    setTimeout(notifyIframeHeight, 250);
    setTimeout(notifyIframeHeight, 900);
  }

  (function injectLayoutCss() {
    if (document.getElementById('wc-layout-css')) return;
    var s = document.createElement('style');
    s.id = 'wc-layout-css';
    s.textContent =
      '.wc-card-left{justify-content:center!important}'
      + '.wc-group{display:none!important}';
    (document.head || document.documentElement).appendChild(s);
  })();

  (function injectNoBetCss() {
    if (document.getElementById('wc-no-bet-css')) return;
    var s = document.createElement('style');
    s.id = 'wc-no-bet-css';
    s.textContent =
      '.wc-bet-btn,.wc-bet-btn:hover{display:none!important;visibility:hidden!important;'
      + 'height:0!important;width:0!important;padding:0!important;margin:0!important;'
      + 'overflow:hidden!important;pointer-events:none!important}';
    (document.head || document.documentElement).appendChild(s);
  })();

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function resolveApiBase(board) {
    var fromData = board && board.getAttribute('data-wc-api');
    if (fromData) return fromData.replace(/\/$/, '');

    var base = window.WC_API_BASE ? String(window.WC_API_BASE).replace(/\/$/, '') : '';
    if (base) {
      try {
        var h = location.hostname;
        if (/localhost|127\.0\.0\.1/.test(base) && h !== 'localhost' && h !== '127.0.0.1') base = '';
      } catch (e) {}
    }
    if (base) return base;

    try {
      var host = location.hostname;
      if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:5290';
      if (host === 'hacksexy.online' || host === '160.22.161.170') return location.origin;
    } catch (e) {}
    return 'https://hacksexy.online';
  }

  function cardHtml(m) {
    var finished = m.status === 'finished' || (m.homeScore != null && m.awayScore != null);
    var penLine = (m.penHome != null && m.penAway != null)
      ? '<span class="wc-pen-val">(' + esc(m.penHome) + ' - ' + esc(m.penAway) + ' pen)</span>'
      : '';
    var groupLine = '';
    var right = finished && m.homeScore != null && m.awayScore != null
      ? '<div class="wc-score"><span class="wc-score-val">' + esc(m.homeScore) + ' - ' + esc(m.awayScore) + '</span>'
        + penLine
        + '<span class="wc-score-lbl">FT</span></div>'
      : '<div class="wc-datetime"><span class="d">' + esc(m.dateDisplay || m.date) + '</span>'
        + '<span class="t">' + esc(m.timeDisplay || m.time) + '</span></div>';
    return (
      '<div class="wc-match-card' + (finished ? ' wc-finished' : '') + '">'
      + '<div class="wc-card-left">'
      + groupLine
      + '<div class="wc-team"><img src="' + esc(m.homeFlag) + '" alt="" loading="lazy" /><span>' + esc(m.home) + '</span></div>'
      + '<div class="wc-team"><img src="' + esc(m.awayFlag) + '" alt="" loading="lazy" /><span>' + esc(m.away) + '</span></div>'
      + '</div>'
      + '<div class="wc-card-right">' + right + '</div></div>'
    );
  }

  function stripBetButtons(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('.wc-bet-btn, a.wc-bet-btn').forEach(function (el) {
      el.remove();
    });
  }

  function renderBoard(board, fixtureDays) {
    if (!board) return;
    if (!fixtureDays || !fixtureDays.length) {
      board.innerHTML = '<div class="wc-board-empty">Chưa có lịch thi đấu.</div>';
      board.setAttribute('data-wc-loaded', '1');
      scheduleIframeHeightNotify();
      return;
    }
    board.innerHTML = fixtureDays.map(function (day) {
      return (
        '<div class="wc-day-block">'
        + '<div class="wc-day-head">' + esc(day.title || ('VÒNG ĐẤU BẢNG - ' + day.date)) + '</div>'
        + '<div class="wc-match-grid">' + (day.matches || []).map(function (m) {
          return cardHtml(m);
        }).join('') + '</div>'
        + '</div>'
      );
    }).join('');
    stripBetButtons(board);
    board.setAttribute('data-wc-loaded', '1');
    scheduleIframeHeightNotify();
  }

  function showError(board, api, msg) {
    if (!board) return;
    board.innerHTML = '<div class="wc-board-error">' + esc(msg || ('Không tải được API (' + api + ')')) + '</div>';
    board.setAttribute('data-wc-loaded', 'error');
    scheduleIframeHeightNotify();
  }

  function loadBoard(board) {
    var api = resolveApiBase(board);
    fetch(api + '/api/v1/worldcup', { mode: 'cors', credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var data = (j && j.data) ? j.data : {};
        if (data.fixtureDays && data.fixtureDays.length) {
          renderBoard(board, data.fixtureDays);
        } else if (data.fixtures && data.fixtures.length) {
          var byDate = {};
          data.fixtures.forEach(function (m) {
            var k = m.date || 'khác';
            if (!byDate[k]) byDate[k] = { date: k, title: 'VÒNG ĐẤU BẢNG - ' + k, matches: [] };
            byDate[k].matches.push(m);
          });
          renderBoard(board, Object.values(byDate));
        } else {
          renderBoard(board, []);
        }
      })
      .catch(function (err) {
        showError(board, api, 'Không tải được lịch thi đấu. API: ' + api + ' — ' + (err && err.message ? err.message : 'lỗi mạng'));
      });
  }

  function watchBoard(board) {
    if (board.getAttribute('data-wc-watching') === '1') return;
    board.setAttribute('data-wc-watching', '1');
    stripBetButtons(board);
    loadBoard(board);
    var timer = setInterval(function () { loadBoard(board); }, 5 * 60 * 1000);
    if (boardTimers) boardTimers.set(board, timer);
  }

  function boot() {
    var boards = document.querySelectorAll('#wc-fixture-board, [data-wc-board]');
    if (!boards.length) return;
    boards.forEach(watchBoard);
    document.querySelectorAll('.wc-bet-btn').forEach(function (el) { el.remove(); });
  }

  window.__WC_BOARD_BOOTED = true;
  window.WCBoardLoader = {
    boot: boot,
    loadBoard: loadBoard,
    notifyIframeHeight: notifyIframeHeight,
    version: '13-banner-simple',
  };

  if (inIframe()) {
    window.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'wc-iframe-request-height') scheduleIframeHeightNotify();
    });
    window.addEventListener('load', scheduleIframeHeightNotify);
    window.addEventListener('resize', scheduleIframeHeightNotify);
    document.querySelectorAll('img').forEach(function (img) {
      if (!img.complete) img.addEventListener('load', scheduleIframeHeightNotify, { once: true });
    });
    if (typeof ResizeObserver !== 'undefined') {
      try {
        new ResizeObserver(scheduleIframeHeightNotify).observe(document.documentElement);
        if (document.body) new ResizeObserver(scheduleIframeHeightNotify).observe(document.body);
      } catch (e) {}
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  scheduleIframeHeightNotify();
})();
