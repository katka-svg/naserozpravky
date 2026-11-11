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
  var KOSIK = 'rozpravka-kosik';
  NR.orderExtras = function (inst, v) {
    var st = inst.__nr || (inst.__nr = { busy: false, err: '', mounted: false, codeT: null });
    var s = inst.state || {};
    if (st.mounted && !v.s3) { unmountCheckout(); st.mounted = false; }
    var cur = v.s3 ? 3 : v.s2 ? 2 : 1;
    if (st.ready) {
      // zapamätanie rozpracovanej objednávky (bez potvrdenia, to sa zaškrtáva vždy nanovo)
      try {
        var fs = Object.assign({}, s.f || {}); delete fs.suhlasZacat;
        localStorage.setItem(KOSIK, JSON.stringify({ t: Date.now(), step: cur, version: s.version, gift: !!s.gift, kids: s.kids, nextKid: s.nextKid, code: s.code || '', codeOpen: !!s.codeOpen, f: fs }));
      } catch (e) {}
      // šípka späť v prehliadači vracia o krok, nie preč z objednávky
      if (st.step !== cur) {
        if (!st.pop && st.step) { try { history.pushState({ nrStep: cur }, ''); } catch (e) {} window.scrollTo(0, 0); }
        st.pop = false; st.step = cur;
      }
    }
    if ((s.f || {}).suhlasZacat && st.zacatErr) { st.zacatErr = false; st.err = ''; }
    st.total = parseFloat(String(v.totalText || '0').replace(',', '.')) || 0; // suma na meranie nákupu
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
      zacatErr: !!st.zacatErr,
      zacatBorder: st.zacatErr ? '#B3261E' : 'transparent',
      zacatBg: st.zacatErr ? '#FBE9E7' : 'transparent',
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
        else if (!gift && !f.suhlasZacat) {
          err = 'Ešte chýba potvrdenie vyššie, označili sme ho červenou.'; st.zacatErr = true;
          setTimeout(function () { var b = document.getElementById('suhlasZacatBox'); if (b) { b.scrollIntoView({ behavior: 'smooth', block: 'center' }); var c = document.getElementById('suhlasZacat'); if (c) c.focus({ preventScroll: true }); } }, 60);
        }
        if (err) { st.err = err; inst.forceUpdate(); return; }
        st.busy = true; st.err = ''; inst.forceUpdate();
        var deti = (s.kids || []).map(function (k) {
          var t = inst.formsOf(k);
          return { meno: inst.clean(k.name), rod: k.gender, tvary: t ? t.used : null };
        }).filter(function (d) { return d.meno && d.rod; });
        req('POST', 'objednavka', {
          verzia: s.version, darcek: gift, deti: deti, meno: f.meno, email: f.email,
          venovanie: f.venovanie || '', poznamka: f.poznamka || '', kod: s.code || '',
          suhlasy: { vop: true, oou: true, zacat: !!f.suhlasZacat }
        }).then(function (r) {
          try { localStorage.setItem('rozpravka-cislo', r.cislo); localStorage.setItem('rozpravka-suma', String(st.total || 0)); } catch (e) {}
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
      var k = null;
      try { k = JSON.parse(localStorage.getItem(KOSIK) || 'null'); } catch (e) {}
      // rozpracovaná objednávka sa pamätá 7 dní; nový výber z úvodnej stránky má prednosť
      var vyb = {};
      try { vyb = JSON.parse(localStorage.getItem('rozpravka-vyber') || '{}') || {}; } catch (e) {}
      if (k && k.t && Date.now() - k.t < 7 * 864e5 && Array.isArray(k.kids) && k.kids.length) {
        patch = { step: Math.min(3, Math.max(1, k.step || 1)), version: k.version === 'pdf' ? 'pdf' : 'audio', gift: !!k.gift,
          kids: k.kids, nextKid: k.nextKid || k.kids.length + 1, code: String(k.code || '').slice(0, 20), codeOpen: !!k.codeOpen, f: k.f || {} };
        if (vyb.cas && vyb.cas > k.t) {
          // medzitým si na úvodnej stránke vybral znova: platí nový výber, ostatné údaje ostávajú
          patch.step = 1; patch.version = inst.state.version; patch.gift = inst.state.gift;
          var nove = String(vyb.meno || '').trim();
          var stare = k.kids.map(function (x) { return String(x.name || '').trim(); }).filter(Boolean).join(' a ');
          if (nove && nove !== stare) { delete patch.kids; delete patch.nextKid; }
        }
      }
      if (kod) { patch.code = kod.slice(0, 20); patch.codeOpen = true; }
      if (q.get('darcek') === '1') patch.gift = true;
      if (Object.keys(patch).length) inst.setState(patch);
      var st = inst.__nr || (inst.__nr = { busy: false, err: '', mounted: false, codeT: null });
      var ciel = patch.step || 1;
      try { history.replaceState({ nrStep: 1 }, ''); for (var i = 2; i <= ciel; i++) history.pushState({ nrStep: i }, ''); } catch (e) {}
      st.step = ciel; st.ready = true;
      window.addEventListener('popstate', function (e) {
        var n = e.state && e.state.nrStep;
        if (!n) return;
        st.pop = true; st.err = '';
        inst.setState({ step: n });
      });
      inst.forceUpdate();
    }
    if (page === 'dakujeme') { try { localStorage.removeItem(KOSIK); } catch (e) {} }
    if (page === 'dakujeme' && q.get('audio') === '1') inst.setState({ offer: 'accepted' });
    return inst;
  };
  NR.api = req;
})();
