/* North Bergen Constituent Chatbot - embeddable popup widget loader.
   Include on any page with a single script tag:
     <script src="https://YOUR-HOST/widget.js" defer></script>
   The panel loads embed.html from the same origin this script was
   loaded from, so the same file works on any host. The panel opens
   automatically shortly after page load; closing it collapses it to a
   bubble and is remembered for the rest of the browser session. */
(function () {
  'use strict';
  if (window.__nbchatWidgetLoaded) return;
  window.__nbchatWidgetLoaded = true;

  var SESSION_KEY = 'nbchat-closed';
  var AUTO_OPEN_MS = 1000;

  /* Derive the embed URL from this script's own address. */
  var base = '';
  try {
    var src = (document.currentScript && document.currentScript.src) || '';
    if (!src) {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        if (/\/widget\.js($|\?)/.test(scripts[i].src || '')) { src = scripts[i].src; break; }
      }
    }
    if (src) base = src.replace(/\/widget\.js($|\?.*$)/, '');
  } catch (e) {}
  var EMBED_URL = base + '/embed.html';

  var CHAT_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false"><path fill="currentColor" d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-9 9H7V9h4v2zm6 0h-4V9h4v2z"/></svg>';

  var CSS = [
    '.nbchat-panel{position:fixed;right:20px;bottom:20px;width:380px;max-width:calc(100vw - 24px);height:560px;max-height:calc(100vh - 40px);max-height:calc(100dvh - 40px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(40,8,18,.35),0 2px 8px rgba(40,8,18,.2);z-index:2147483000;display:flex;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;opacity:0;transform:translateY(16px);pointer-events:none;transition:opacity .28s ease,transform .28s ease}',
    '.nbchat-panel.nbchat-open{opacity:1;transform:translateY(0);pointer-events:auto}',
    '.nbchat-head{flex:0 0 auto;background:#6f1d2f;color:#fff;border-bottom:3px solid #c9a227;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px}',
    '.nbchat-title{font-family:Georgia,"Times New Roman",serif;font-size:.98rem;font-weight:700;letter-spacing:.02em;line-height:1.25}',
    '.nbchat-title small{display:block;font-family:inherit;font-size:.62rem;font-weight:400;letter-spacing:.14em;text-transform:uppercase;color:#f3e5bb}',
    '.nbchat-close{flex:0 0 auto;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.4);background:transparent;color:#fff;font-size:1.15rem;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}',
    '.nbchat-close:hover{background:rgba(255,255,255,.15)}',
    '.nbchat-close:focus-visible{outline:3px solid #c9a227;outline-offset:2px}',
    '.nbchat-framewrap{flex:1 1 auto;background:#fbf8f2}',
    '.nbchat-frame{width:100%;height:100%;border:0;display:block}',
    '.nbchat-bubble{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:none;align-items:center;gap:9px;background:#6f1d2f;color:#fff;border:2px solid #c9a227;border-radius:999px;padding:12px 18px 12px 14px;cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:.95rem;font-weight:600;box-shadow:0 8px 24px rgba(40,8,18,.35);opacity:0;transform:translateY(8px);transition:opacity .25s ease,transform .25s ease}',
    '.nbchat-bubble.nbchat-show{display:inline-flex;opacity:1;transform:translateY(0)}',
    '.nbchat-bubble:hover{background:#521423}',
    '.nbchat-bubble:focus-visible{outline:3px solid #c9a227;outline-offset:2px}',
    '@media (max-width:480px){.nbchat-panel{right:8px;left:8px;bottom:8px;width:auto;height:calc(100vh - 16px);height:calc(100dvh - 16px);max-height:none}.nbchat-bubble{right:12px;bottom:12px}}'
  ].join('\n');

  var panel = null, bubble = null, frame = null, isOpen = false;

  function sessionClosed() {
    try { return window.sessionStorage.getItem(SESSION_KEY) === '1'; } catch (e) { return false; }
  }
  function markSessionClosed() {
    try { window.sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) {}
  }

  function ensureFrame() {
    if (frame) return;
    frame = document.createElement('iframe');
    frame.className = 'nbchat-frame';
    frame.title = 'North Bergen Constituent Chatbot';
    frame.setAttribute('src', EMBED_URL);
    frame.setAttribute('allow', 'microphone');
    panel.querySelector('.nbchat-framewrap').appendChild(frame);
  }

  function openPanel() {
    ensureFrame();
    isOpen = true;
    panel.classList.add('nbchat-open');
    bubble.classList.remove('nbchat-show');
    panel.setAttribute('aria-hidden', 'false');
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove('nbchat-open');
    bubble.classList.add('nbchat-show');
    panel.setAttribute('aria-hidden', 'true');
    markSessionClosed();
  }

  function build() {
    if (panel) return;
    var style = document.createElement('style');
    style.id = 'nbchat-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    panel = document.createElement('div');
    panel.className = 'nbchat-panel';
    panel.id = 'nbchat-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'North Bergen Constituent Chatbot');
    panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML =
      '<div class="nbchat-head">' +
        '<div class="nbchat-title">North Bergen Constituent Chatbot<small>Township of North Bergen</small></div>' +
        '<button type="button" class="nbchat-close" id="nbchat-close" aria-label="Close chat">&times;</button>' +
      '</div>' +
      '<div class="nbchat-framewrap"></div>';
    document.body.appendChild(panel);

    bubble = document.createElement('button');
    bubble.type = 'button';
    bubble.className = 'nbchat-bubble nbchat-show';
    bubble.id = 'nbchat-bubble';
    bubble.setAttribute('aria-label', 'Open the North Bergen Constituent Chatbot');
    bubble.innerHTML = CHAT_SVG + '<span>Ask North Bergen</span>';
    document.body.appendChild(bubble);

    panel.querySelector('#nbchat-close').addEventListener('click', closePanel);
    bubble.addEventListener('click', openPanel);

    if (!sessionClosed()) {
      window.setTimeout(function () { if (!isOpen) openPanel(); }, AUTO_OPEN_MS);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
