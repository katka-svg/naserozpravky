/* Naše rozprávky · napojenie stránok z návrhu na platbu a API (Supabase Edge Function "api"). */
(function () {
  'use strict';
  var CFG = window.NR_CONFIG || {};
  var API = (CFG.api || '').replace(/\/$/, '');

  function req(method, path, body) {
    var opt = { method: method, headers: {} };
    if (CFG.anon) { opt.headers.apikey = CFG.anon; opt.headers.Authorization = 'Bearer ' + CFG.anon; }
    if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(API + '/' + path, opt).catch(function () {
      throw new Error('Spojenie so serverom zlyhalo. Skontrolujte internet a skúste to znova.');
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.chyba || 'Spojenie zlyhalo, skúste to, prosím, znova.');
        return j;
      });
    });
  }

  var stripeJs = null;
  function loadStripe() {
    if (window.Stripe) return Promise.resolve();
    if (!stripeJs) {
      stripeJs = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = 'https://js.stripe.com/v3/';
        s.onload = res;
        s.onerror = function () { stripeJs = null; rej(new Error('Platobnú bránu sa nepodarilo načítať. Skontrolujte pripojenie.')); };
        document.head.appendChild(s);
      });
    }
    return stripeJs;
  }
  var checkout = null;
  function mountCheckout(resp, el) {
    return loadStripe().then(function () {
      if (checkout) { try { checkout.destroy(); } catch (e) {} checkout = null; }
      var stripe = window.Stripe(resp.publishableKey);
      return stripe.initEmbeddedCheckout({ fetchClientSecret: function () { return Promise.resolve(resp.clientSecret); } });
    }).then(function (c) {
      checkout = c;
      c.mount(el);
      try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
    });
  }
  function unmountCheckout() {
    if (checkout) { try { checkout.destroy(); } catch (e) {} checkout = null; }
  }

  function norm(raw) {
    return String(raw || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '').toUpperCase();
  }

  var NR = window.NR = { codes: {}, checked: {} };

  // ---------------------------------------------------------------- objednávka
  NR.orderExtras = function (inst, v) {
    var st = inst.__nr || (inst.__nr = { busy: false, err: '', mounted: false, codeT: null });
    var s = inst.state || {};
    if (st.mounted && !v.s3) { unmountCheckout(); st.mounted = false; }
    // overenie kódu na serveri (poukazy)
    var key = norm(s.code);
    if (key.length >= 4 && !NR.checked[key] && !NR.codes[key]) {
      clearTimeout(st.codeT);
      st.codeT = setTimeout(function () {
        NR.checked[key] = true;
        req('POST', 'kod', { kod: key, verzia: s.version, darcek: !!s.gift, deti: (s.kids || []).length }).then(function (r) {
          if (r.zlava_eur > 0) NR.codes[key] = r.zlava_eur;
          inst.forceUpdate();
        }).catch(function () { NR.checked[key] = false; });
      }, 450);
    }
    return {
      payBusy: st.busy,
      payErr: st.err,
      hasPayErr: !!st.err,
      payShow: !st.mounted,
      payLabelNow: st.busy ? 'Pripravujem platbu…' : v.payLabel,
      pay: function () {
        if (st.busy) return;
        var f = s.f || {};
        var gift = !!s.gift;
        var err = '';
        if (!String(f.meno || '').trim()) err = 'Napíšte, prosím, meno a priezvisko.';
        else if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(f.email || '').trim())) err = 'Skontrolujte, prosím, e-mail.';
        else if (!f.suhlasVop || !f.suhlasOou || (!gift && !f.suhlasZacat)) err = 'Potvrďte, prosím, súhlasy vyššie.';
        if (err) { st.err = err; inst.forceUpdate(); return; }
        st.busy = true; st.err = ''; inst.forceUpdate();
        var deti = (s.kids || []).map(function (k) {
          var t = inst.formsOf(k);
          return { meno: inst.clean(k.name), rod: k.gender, tvary: t ? t.used : null };
        }).filter(function (d) { return d.meno && d.rod; });
        req('POST', 'objednavka', {
          verzia: s.version, darcek: gift, deti: deti, meno: f.meno, email: f.email,
          venovanie: f.venovanie || '', poznamka: f.poznamka || '', kod: s.code || '',
          suhlasy: { vop: !!f.suhlasVop, oou: !!f.suhlasOou, zacat: !!f.suhlasZacat }
        }).then(function (r) {
          try { localStorage.setItem('rozpravka-cislo', r.cislo); } catch (e) {}
          if (r.zaplatene) {
            location.href = '/dakujeme/?objednavka=' + encodeURIComponent(r.cislo) + '&session_id=' + encodeURIComponent(r.overenie || '');
            return null;
          }
          st.mounted = true;
          inst.forceUpdate();
          return mountCheckout(r, document.getElementById('platba-stripe'));
        }).catch(function (e) {
          st.err = (e && e.message) || 'Platbu sa nepodarilo spustiť.';
          st.mounted = false;
          unmountCheckout();
        }).then(function () { st.busy = false; inst.forceUpdate(); });
      }
    };
  };

  // ---------------------------------------------------------------- ďakovná stránka
  NR.thanksExtras = function (inst) {
    var st = inst.__nr || (inst.__nr = { busy: false, err: '', mounted: false, loaded: false });
    var q = new URLSearchParams(location.search);
    var cislo = q.get('objednavka') || '';
    return {
      accept: function () {
        if (st.busy) return;
        if (!cislo) { st.err = 'Číslo objednávky sa nenašlo, napíšte nám a doplatok pridáme ručne.'; inst.forceUpdate(); return; }
        st.busy = true; st.err = ''; inst.forceUpdate();
        req('POST', 'doplatok', { cislo: cislo, session_id: q.get('session_id') || '' }).then(function (r) {
          st.mounted = true; inst.forceUpdate();
          return mountCheckout(r, document.getElementById('platba-doplatok'));
        }).catch(function (e) { st.err = (e && e.message) || 'Doplatok sa nepodarilo spustiť.'; })
          .then(function () { st.busy = false; inst.forceUpdate(); });
      },
      acceptBusy: st.busy,
      doplatokErr: st.err,
      hasDoplatokErr: !!st.err,
    };
  };

  // ---------------------------------------------------------------- spustenie stránky
  NR.boot = function (page, props) {
    var inst = window.DCLite.mount({ props: props });
    var q = new URLSearchParams(location.search);
    if (page === 'objednavka') {
      var kod = q.get('kod');
      var patch = {};
      if (kod) { patch.code = kod.slice(0, 20); patch.codeOpen = true; }
      if (q.get('darcek') === '1') patch.gift = true;
      if (Object.keys(patch).length) inst.setState(patch);
    }
    if (page === 'dakujeme' && q.get('audio') === '1') inst.setState({ offer: 'accepted' });
    return inst;
  };
  NR.api = req;
})();
