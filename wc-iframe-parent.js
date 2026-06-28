/** Parent page — auto-resize hacksexy.online schedule iframes (no inner scroll, page scrolls normally) */
(function () {
  if (window.__WC_IFRAME_PARENT) return;
  window.__WC_IFRAME_PARENT = true;

  function wcFrames() {
    return document.querySelectorAll('iframe[src*="hacksexy.online/schedule"]');
  }

  function setFrameHeight(frame, height) {
    var px = Math.max(200, Math.ceil(Number(height) || 0) + 4);
    frame.height = px;
    frame.style.height = px + 'px';
    frame.style.minHeight = '0';
    frame.setAttribute('scrolling', 'no');
  }

  function prepFrame(frame) {
    frame.setAttribute('scrolling', 'no');
    frame.style.overflow = 'hidden';
    frame.style.border = frame.style.border || '0';
    frame.style.display = frame.style.display || 'block';
    frame.style.width = frame.style.width || '100%';
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

  new MutationObserver(function () {
    wcFrames().forEach(prepFrame);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
