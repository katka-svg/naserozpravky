/* Meranie reklamy (Meta Pixel) až po súhlase. Bez ID pixela v config.json sa nič nenačíta a lišta sa neukáže. */
(function () {
  var C = window.NR_CONFIG || {};
  var ID = String(C.pixel || '').replace(/\D/g, '');
  if (!ID) return;
  var KEY = 'nr-suhlas-meranie';
  function stav() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function uloz(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  function pixel() {
    if (window.fbq) return;
    var n = window.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!window._fbq) window._fbq = n;
    n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
    var t = document.createElement('script'); t.async = true; t.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(t);
    window.fbq('init', ID);
    window.fbq('track', 'PageView');
    var p = location.pathname;
    if (/^\/objednavka\//.test(p)) window.fbq('track', 'InitiateCheckout');
    if (/^\/dakujeme\//.test(p)) {
      // nákup len raz na objednávku a len po návrate z platby
      var q = new URLSearchParams(location.search), cislo = q.get('objednavka') || '';
      var uz = null, suma = 0;
      try { uz = localStorage.getItem('nr-nakup-' + cislo); suma = Number(localStorage.getItem('rozpravka-suma') || 0); } catch (e) {}
      if (cislo && q.get('session_id') && !q.get('audio') && !uz) {
        window.fbq('track', 'Purchase', { value: suma, currency: 'EUR' }, { eventID: cislo });
        try { localStorage.setItem('nr-nakup-' + cislo, '1'); } catch (e) {}
      }
    }
  }

  var lista = null;
  function ukaz() {
    if (lista) return;
    lista = document.createElement('div');
    lista.setAttribute('role', 'dialog');
    lista.setAttribute('aria-label', 'Súhlas s meraním');
    lista.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-width:560px;margin:0 auto;background:#fff;color:#2A2D3E;border:1.8px solid #45454D;border-radius:22px 10px 20px 12px / 12px 20px 10px 22px;box-shadow:0 10px 30px rgba(30,42,94,.25);padding:16px;font:15px/1.45 "DM Sans",Arial,sans-serif';
    lista.innerHTML = '<p style="margin:0 0 12px">Aby sme vedeli, či naša reklama funguje, radi by sme merali návštevy a objednávky cez Meta Pixel. Web funguje aj bez toho. <a href="/ochrana-osobnych-udajov/" style="color:#2A2D3E">Viac o ochrane údajov</a></p>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
      '<button type="button" data-v="nie" style="flex:1 1 150px;min-height:48px;border:1.8px solid #45454D;border-radius:999px;background:#fff;color:#2A2D3E;font:inherit;font-weight:700;cursor:pointer">Len nevyhnutné</button>' +
      '<button type="button" data-v="ano" style="flex:1 1 150px;min-height:48px;border:1.8px solid #45454D;border-radius:999px;background:#fff;color:#2A2D3E;font:inherit;font-weight:700;cursor:pointer">Povoliť</button></div>';
    lista.addEventListener('click', function (e) {
      var v = e.target && e.target.getAttribute && e.target.getAttribute('data-v');
      if (!v) return;
      var predtym = stav();
      uloz(v);
      lista.remove(); lista = null;
      if (v === 'ano') pixel();
      else if (predtym === 'ano') location.reload(); // po odvolaní súhlasu sa pixel už nenačíta
    });
    document.body.appendChild(lista);
  }

  function start() {
    var s = stav();
    if (s === 'ano') pixel(); else if (s !== 'nie') ukaz();
    // odkaz na zmenu voľby na konci stránky
    var a = document.createElement('p');
    a.style.cssText = 'margin:0;padding:10px 16px 18px;text-align:center;font:14px "DM Sans",Arial,sans-serif;background:#F0EADD';
    a.innerHTML = '<button type="button" style="border:none;background:none;padding:6px;font:inherit;color:#3E4258;text-decoration:underline;cursor:pointer">Nastavenia cookies</button>';
    a.firstChild.onclick = ukaz;
    document.body.appendChild(a);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
