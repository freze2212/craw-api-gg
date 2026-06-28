(function () {
  var boardTimers = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

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
    return (
      '<div class="wc-match-card">'
      + '<div class="wc-card-left">'
      + '<div class="wc-group">' + esc(m.group) + '</div>'
      + '<div class="wc-team"><img src="' + esc(m.homeFlag) + '" alt="" loading="lazy" /><span>' + esc(m.home) + '</span></div>'
      + '<div class="wc-team"><img src="' + esc(m.awayFlag) + '" alt="" loading="lazy" /><span>' + esc(m.away) + '</span></div>'
      + '</div>'
      + '<div class="wc-card-right">'
      + '<div class="wc-datetime"><span class="d">' + esc(m.dateDisplay || m.date) + '</span><span class="t">' + esc(m.timeDisplay || m.time) + '</span></div>'
      + '</div></div>'
    );
  }

  function renderBoard(board, fixtureDays) {
    if (!board) return;
    if (!fixtureDays || !fixtureDays.length) {
      board.innerHTML = '<div class="wc-board-empty">Chưa có lịch thi đấu.</div>';
      board.setAttribute('data-wc-loaded', '1');
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
    board.setAttribute('data-wc-loaded', '1');
  }

  function showError(board, api, msg) {
    if (!board) return;
    board.innerHTML = '<div class="wc-board-error">' + esc(msg || ('Không tải được API (' + api + ')')) + '</div>';
    board.setAttribute('data-wc-loaded', 'error');
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
    loadBoard(board);
    var timer = setInterval(function () { loadBoard(board); }, 5 * 60 * 1000);
    if (boardTimers) boardTimers.set(board, timer);
  }

  function boot() {
    var boards = document.querySelectorAll('#wc-fixture-board, [data-wc-board]');
    if (!boards.length) return;
    boards.forEach(watchBoard);
  }

  window.__WC_BOARD_BOOTED = true;
  window.WCBoardLoader = { boot: boot, loadBoard: loadBoard };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
