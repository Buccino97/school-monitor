(async () => {
  if (window.top !== window) return;
  try {
    const { blockedUrls = [] } = await chrome.storage.local.get('blockedUrls');
    for (const dom of blockedUrls) {
      if (location.href.includes(dom) && !location.href.startsWith(chrome.runtime.getURL(''))) {
        window.location.replace(chrome.runtime.getURL('blocked.html?site=' + encodeURIComponent(dom)));
        return;
      }
    }
  } catch {}
  if (location.pathname === '/installa' || location.pathname === '/installa.html') {
    const collega = () => {
      const room = (document.documentElement.dataset.room || new URLSearchParams(location.search).get('room') || '').toUpperCase();
      if (!room) return;
      chrome.runtime.sendMessage({ target: 'background', type: 'set_config', serverUrl: location.origin, roomCode: room },
        () => { document.documentElement.setAttribute('sm-ready', '1'); });
    };
    collega();
    new MutationObserver(collega).observe(document.documentElement, { attributes: true, attributeFilter: ['data-room'] });
  }
})();
