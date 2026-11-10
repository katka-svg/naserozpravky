/* Naše rozprávky · malý runtime pre stránky z návrhu na plátne.
   Šablóna je v <template id="dc-tpl">, logika je trieda Component (extends DCLogic) v window.__DCComponent.
   Podporuje {{výraz}} v texte aj atribútoch, <sc-if value="{{x}}">, <sc-for list="{{x}}" as="y">,
   udalosti onClick/onInput/onChange/... cez delegovanie a setState s prekreslením cez morphdom. */
(function () {
  'use strict';

  var BOOL_ATTRS = { checked: 1, disabled: 1, hidden: 1, open: 1, selected: 1, required: 1, readonly: 1, multiple: 1, autofocus: 1, muted: 1, autoplay: 1, loop: 1, controls: 1, novalidate: 1 };
  var DROP_ATTRS = { 'hint-placeholder-val': 1, 'hint-placeholder-count': 1 };
  var ONE = /^\s*\{\{([^}]*)\}\}\s*$/;
  var ANY = /\{\{([^}]*)\}\}/g;

  function DCLogic(props) {
    this.props = props || {};
    this.state = {};
  }
  DCLogic.prototype.setState = function (patch, cb) {
    var prev = Object.assign({}, this.state);
    var p = typeof patch === 'function' ? patch(this.state, this.props) : patch;
    if (p) Object.assign(this.state, p);
    if (this.__dc) this.__dc.schedule(prev, cb);
  };
  DCLogic.prototype.forceUpdate = function (cb) {
    if (this.__dc) this.__dc.schedule(Object.assign({}, this.state), cb);
  };
  window.DCLogic = DCLogic;

  function lookup(chain, expr) {
    expr = expr.trim();
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(expr)) return parseFloat(expr);
    var parts = expr.split('.');
    for (var i = chain.length - 1; i >= 0; i--) {
      var ctx = chain[i];
      if (ctx && typeof ctx === 'object' && Object.prototype.hasOwnProperty.call(ctx, parts[0])) {
        var v = ctx[parts[0]];
        for (var j = 1; j < parts.length; j++) v = (v != null && typeof v === 'object') ? v[parts[j]] : undefined;
        return v;
      }
    }
    return undefined;
  }

  function str(v) {
    if (v == null) return '';
    return String(v);
  }

  function subst(text, chain) {
    return text.replace(ANY, function (_, e) { return str(lookup(chain, e)); });
  }

  // Prekreslenie šablóny do nového DOM stromu.
  function build(node, chain, out, ctx) {
    if (node.nodeType === 3) {
      var t = node.nodeValue;
      out.appendChild(document.createTextNode(t.indexOf('{{') >= 0 ? subst(t, chain) : t));
      return;
    }
    if (node.nodeType === 8) return;
    if (node.nodeType !== 1) return;
    var tag = node.localName;
    if (tag === 'sc-if') {
      var m = ONE.exec(node.getAttribute('value') || '');
      if (m && lookup(chain, m[1])) buildKids(node, chain, out, ctx);
      return;
    }
    if (tag === 'sc-for') {
      var lm = ONE.exec(node.getAttribute('list') || '');
      var name = node.getAttribute('as') || 'item';
      var list = lm ? lookup(chain, lm[1]) : null;
      if (list && list.length) {
        for (var i = 0; i < list.length; i++) {
          var scope = {};
          scope[name] = list[i];
          buildKids(node, chain.concat([scope]), out, ctx);
        }
      }
      return;
    }
    var el = node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/1999/xhtml'
      ? document.createElementNS(node.namespaceURI, node.tagName)
      : document.createElement(tag);
    var attrs = node.attributes;
    for (var a = 0; a < attrs.length; a++) {
      var at = attrs[a];
      var an = at.name;
      if (DROP_ATTRS[an]) continue;
      var av = at.value;
      var one = ONE.exec(av);
      if (/^on[a-z]+$/i.test(an)) {
        // parser HTML mení onClick na onclick, preto bez ohľadu na veľkosť písmen
        var fn = one ? lookup(chain, one[1]) : null;
        if (typeof fn === 'function') {
          var id = 'h' + (++ctx.n);
          ctx.handlers[id] = fn;
          el.setAttribute('data-dc-' + an.slice(2).toLowerCase(), id);
        }
        continue;
      }
      if (one) {
        var v = lookup(chain, one[1]);
        if (BOOL_ATTRS[an.toLowerCase()]) {
          if (v === true || (v && v !== 'false')) el.setAttribute(an, '');
          continue;
        }
        if (typeof v === 'function') continue;
        if (v == null || v === false) {
          if (v === false && /^aria-|^data-/.test(an)) el.setAttribute(an, 'false');
          continue;
        }
        setAttr(el, an, str(v), at);
      } else if (av.indexOf('{{') >= 0) {
        setAttr(el, an, subst(av, chain), at);
      } else {
        setAttr(el, an, av, at);
      }
    }
    if (tag === 'template') {
      out.appendChild(el);
      return;
    }
    buildKids(node, chain, el, ctx);
    out.appendChild(el);
  }

  function setAttr(el, name, value, at) {
    if (at && at.namespaceURI) el.setAttributeNS(at.namespaceURI, name, value);
    else el.setAttribute(name, value);
  }

  function buildKids(node, chain, out, ctx) {
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) build(kids[i], chain, out, ctx);
  }

  function mount(opts) {
    var root = document.getElementById(opts.root || 'app');
    var tplEl = document.getElementById(opts.template || 'dc-tpl');
    var tpl = tplEl.content;
    var Component = window.__DCComponent;
    var inst = new Component(opts.props || {});
    var handlers = {};
    var pending = null;
    var mounted = false;

    function render() {
      var vals = inst.renderVals ? inst.renderVals() : {};
      var ctx = { n: 0, handlers: {} };
      var frag = document.createElement('div');
      buildKids(tpl, [vals], frag, ctx);
      handlers = ctx.handlers;
      window.morphdom(root, frag, {
        childrenOnly: true,
        onBeforeElUpdated: function (fromEl, toEl) {
          // prvok, do ktorého niečo vložil iný skript (napríklad platobná brána), nechávame tak
          if (fromEl.hasAttribute && fromEl.hasAttribute('data-dc-keep')) return false;
          // vstup bez value v šablóne je nekontrolovaný: necháme v ňom, čo človek napísal
          if (fromEl.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image)$/i.test(fromEl.type || '')
              && !toEl.hasAttribute('value')) {
            toEl.value = fromEl.value;
          }
          if (fromEl.tagName === 'DETAILS' && mounted) {
            if (fromEl.open) toEl.setAttribute('open', '');
            else toEl.removeAttribute('open');
          }
          if (fromEl.tagName === 'AUDIO' || fromEl.tagName === 'VIDEO') {
            if (fromEl.getAttribute('src') === toEl.getAttribute('src')) {
              // prehrávač nechávame tak, aby sa nezastavil
              for (var i = 0; i < toEl.attributes.length; i++) {
                var a = toEl.attributes[i];
                if (a.name !== 'src' && fromEl.getAttribute(a.name) !== a.value) fromEl.setAttribute(a.name, a.value);
              }
              return false;
            }
          }
          return true;
        }
      });
    }

    function schedule(prev, cb) {
      if (!pending) {
        pending = { prev: prev, cbs: [] };
        var run = function () {
          var p = pending;
          pending = null;
          render();
          if (inst.componentDidUpdate) inst.componentDidUpdate(inst.props, p.prev);
          p.cbs.forEach(function (f) { try { f(); } catch (e) { console.error(e); } });
        };
        if (window.queueMicrotask) queueMicrotask(run); else Promise.resolve().then(run);
      }
      if (cb) pending.cbs.push(cb);
    }

    inst.__dc = { schedule: schedule };

    function dispatch(e) {
      var type = e.type;
      var el = e.target;
      while (el && el !== root.parentNode) {
        if (el.nodeType === 1) {
          var id = el.getAttribute('data-dc-' + type);
          if (id && handlers[id]) {
            handlers[id].call(null, e);
            if (e.cancelBubble) break;
          }
        }
        if (el === root) break;
        el = el.parentNode;
      }
    }
    ['click', 'input', 'change', 'submit', 'keydown', 'keyup', 'focusin', 'focusout'].forEach(function (t) {
      root.addEventListener(t, dispatch);
    });

    render();
    mounted = true;
    if (inst.componentDidMount) inst.componentDidMount();
    window.__dcInstance = inst;
    return inst;
  }

  window.DCLite = { mount: mount };
})();
