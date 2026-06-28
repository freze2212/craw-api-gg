(function () {
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function resolveApiBase(board) {
    if (window.WC_API_BASE) return String(window.WC_API_BASE).replace(/\/$/, '');
    var fromData = board && board.getAttribute('data-wc-api');
    if (fromData) return fromData.replace(/\/$/, '');
    try {
      var h = location.hostname;
      if (h === 'localhost' || h === '127.0.0.1') return 'http://localhost:5290';
      if (h === 'hacksexy.online' || h === '160.22.161.170') return location.protocol + '//' + location.host;
    } catch (e) {}
    return 'https://hacksexy.online';
  }

  function cardHtml(m, betUrl) {
    return (
      '<div class="wc-match-card">'
      + '<div class="wc-card-left">'
      + '<div class="wc-group">' + esc(m.group) + '</div>'
      + '<div class="wc-team"><img src="' + esc(m.homeFlag) + '" alt="" loading="lazy" /><span>' + esc(m.home) + '</span></div>'
      + '<div class="wc-team"><img src="' + esc(m.awayFlag) + '" alt="" loading="lazy" /><span>' + esc(m.away) + '</span></div>'
      + '</div>'
      + '<div class="wc-card-right">'
      + '<div class="wc-datetime"><span class="d">' + esc(m.dateDisplay || m.date) + '</span><span class="t">' + esc(m.timeDisplay || m.time) + '</span></div>'
      + '<a class="wc-bet-btn" href="' + esc(betUrl) + '">Cược ngay</a>'
      + '</div></div>'
    );
  }

  function renderBoard(board, fixtureDays) {
    if (!board) return;
    if (!fixtureDays || !fixtureDays.length) {
      board.innerHTML = '<div class="wc-board-empty">Chưa có lịch thi đấu.</div>';
      return;
    }
    board.innerHTML = fixtureDays.map(function (day) {
      return (
        '<div class="wc-day-block">'
        + '<div class="wc-day-head">' + esc(day.title || ('VÒNG ĐẤU BẢNG - ' + day.date)) + '</div>'
        + '<div class="wc-match-grid">' + (day.matches || []).map(function (m) {
          return cardHtml(m, board.getAttribute('data-bet-url') || '/sports');
        }).join('') + '</div>'
        + '</div>'
      );
    }).join('');
  }

  function showError(board, api, msg) {
    if (!board) return;
    board.innerHTML = '<div class="wc-board-error">' + esc(msg || ('Không tải được API (' + api + ')')) + '</div>';
  }

  function loadBoard(board) {
    var api = resolveApiBase(board);
    fetch(api + '/api/v1/worldcup')
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
        showError(board, api, 'Không tải được lịch thi đấu. Kiểm tra API: ' + api + ' — ' + (err && err.message ? err.message : 'lỗi mạng'));
      });
  }

  function boot() {
    var boards = document.querySelectorAll('#wc-fixture-board, [data-wc-board]');
    if (!boards.length) return;
    boards.forEach(function (board) {
      loadBoard(board);
      setInterval(function () { loadBoard(board); }, 5 * 60 * 1000);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
