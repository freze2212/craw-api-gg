/** Parent page — resize iframe + forward scroll to host page (no inner scrollbar) */
(function () {
  if (window.__WC_IFRAME_PARENT) return;
  window.__WC_IFRAME_PARENT = true;

  function wcFrames() {
    return document.querySelectorAll('iframe[src*="hacksexy.online/schedule"]');
  }

  function scrollRoot() {
    return document.scrollingElement || document.documentElement || document.body;
  }

  function setFrameHeight(frame, height) {
    var px = Math.max(200, Math.ceil(Number(height) || 0) + 8);
    frame.height = px;
    frame.style.height = px + 'px';
    frame.style.maxHeight = 'none';
    frame.style.minHeight = '0';
    frame.setAttribute('scrolling', 'no');
  }

  function requestChildHeight(frame) {
    try {
      if (frame.contentWindow) {
        frame.contentWindow.postMessage({ type: 'wc-iframe-request-height' }, '*');
      }
    } catch (e) {}
  }

  /** Chuột/touch trên iframe → cuộn trang CMS bên ngoài */
  function enableScrollPassthrough(frame) {
    if (frame.__wcScrollPass) return;
    frame.__wcScrollPass = true;

    frame.addEventListener('wheel', function (e) {
      var root = scrollRoot();
      root.scrollTop += e.deltaY;
      if (e.deltaX) root.scrollLeft += e.deltaX;
      e.preventDefault();
    }, { passive: false });

    var touchY = 0;
    frame.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) touchY = e.touches[0].clientY;
    }, { passive: true });

    frame.addEventListener('touchmove', function (e) {
      if (e.touches.length !== 1) return;
      var dy = touchY - e.touches[0].clientY;
      touchY = e.touches[0].clientY;
      scrollRoot().scrollTop += dy;
    }, { passive: true });

    frame.addEventListener('load', function () {
      requestChildHeight(frame);
      setTimeout(function () { requestChildHeight(frame); }, 400);
      setTimeout(function () { requestChildHeight(frame); }, 1500);
    });
  }

  function prepFrame(frame) {
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('frameborder', '0');
    frame.style.border = '0';
    frame.style.display = 'block';
    frame.style.width = '100%';
    frame.style.overflow = 'visible';
    frame.style.verticalAlign = 'top';
    enableScrollPassthrough(frame);
  }

  wcFrames().forEach(prepFrame);

  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.type !== 'wc-iframe-resize' || !d.height) return;
    wcFrames().forEach(function (frame) {
      try {
        if (frame.contentWindow === e.source) setFrameHeight(frame, d.height);
      } catch (err) {}
    });
  });

  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(function () {
      wcFrames().forEach(prepFrame);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
