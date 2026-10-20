// Runs inside the recorded app page (Page.addScriptToEvaluateOnNewDocument), before the app's own code.
//  - Privacy mask: every text node, input value, placeholder and title that matches a rule is rewritten
//    before it is painted (a MutationObserver on the whole document), so the recording never holds
//    the real value. window.__filmLeaks() lists what still matches the raw patterns (the recorder checks
//    it on every step and stops the take if anything leaks).
//  - A drawn cursor and click ripple: headless Chrome and screencasts show no mouse pointer.
// The rules come from record-app.mjs as window.__FILM_RULES = [{ find, flags, replace }].
(() => {
    const RULES = (window.__FILM_RULES || []).map(r => ({ re: new RegExp(r.find, r.flags || 'g'), replace: r.replace }));
    // Emails other than the demo ones are replaced too
    const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    const EMAIL_OK = new RegExp(window.__FILM_EMAIL_OK || '@(flybot\\.invalid|flybot\\.test|example\\.com)$', 'i');
    const maskText = (s) => {
        if (!s || typeof s !== 'string') return s;
        let out = s;
        for (const r of RULES) out = out.replace(r.re, r.replace);
        out = out.replace(EMAIL, (m) => EMAIL_OK.test(m) ? m : 'owner@example.com');
        return out;
    };
    const ATTRS = ['placeholder', 'title', 'alt', 'aria-label', 'value'];
    // Values the app writes into inputs (v-model) fire no mutation: mask them as they are set
    for (const proto of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        Object.defineProperty(proto, 'value', {
            configurable: true, enumerable: desc.enumerable,
            get() { return desc.get.call(this); },
            set(v) { desc.set.call(this, typeof v === 'string' ? maskText(v) : v); }
        });
    }
    const maskNode = (node) => {
        if (node.nodeType === 3) {
            const v = maskText(node.nodeValue);
            if (v !== node.nodeValue) node.nodeValue = v;
            return;
        }
        if (node.nodeType !== 1) return;
        for (const a of ATTRS) {
            if (node.hasAttribute && node.hasAttribute(a)) {
                const v = node.getAttribute(a), m = maskText(v);
                if (m !== v) node.setAttribute(a, m);
            }
        }
        if ((node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') && node.value) {
            const m = maskText(node.value);
            if (m !== node.value) node.value = m;
        }
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        let n = walker.nextNode();
        while (n) {
            if (n.nodeType === 3) { const v = maskText(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; }
            else {
                for (const a of ATTRS) if (n.hasAttribute(a)) { const v = n.getAttribute(a), m = maskText(v); if (m !== v) n.setAttribute(a, m); }
                if ((n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') && n.value) { const m = maskText(n.value); if (m !== n.value) n.value = m; }
            }
            n = walker.nextNode();
        }
    };
    const start = () => {
        maskNode(document.documentElement);
        new MutationObserver((list) => {
            for (const m of list) {
                if (m.type === 'characterData') maskNode(m.target);
                else if (m.type === 'attributes') maskNode(m.target);
                else m.addedNodes.forEach(maskNode);
            }
        }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
        // Inputs filled by the app (v-model) do not always fire a mutation
        setInterval(() => document.querySelectorAll('input, textarea').forEach(maskNode), 100);
    };
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);

    // A guest gets "read-only" error toasts from widgets that try to write (e.g. the dashboard's AI diagnosis):
    // the film leaves them out
    const QUIET = /read-only|read only/i;
    setInterval(() => document.querySelectorAll('.el-notification, .el-message').forEach(n => { if (QUIET.test(n.innerText || '')) n.remove(); }), 50);

    window.__filmLeaks = () => {
        const texts = [document.body ? document.body.innerText : ''];
        document.querySelectorAll('input, textarea').forEach(e => texts.push(e.value || ''));
        document.querySelectorAll('[title],[placeholder],[alt]').forEach(e => texts.push(e.title || '', e.placeholder || '', e.alt || ''));
        const all = texts.join('\n');
        const found = [];
        for (const r of RULES) { r.re.lastIndex = 0; if (r.re.test(all)) found.push(r.re.source); }
        for (const m of all.match(EMAIL) || []) if (!EMAIL_OK.test(m)) found.push('email');
        return found;
    };

    // The drawn cursor
    const cursor = () => {
        if (document.getElementById('__film_cursor') || !document.body) return;
        const c = document.createElement('div');
        c.id = '__film_cursor';
        c.style.cssText = 'position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:none';
        c.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M4 2 L4 22 L9.5 17 L13 25 L16.5 23.5 L13 15.5 L20.5 15.5 Z" fill="#111" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>';
        document.body.appendChild(c);
    };
    window.__filmCursor = (x, y) => {
        cursor();
        const c = document.getElementById('__film_cursor');
        if (c) c.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
    };
    window.__filmRipple = (x, y) => {
        if (!document.body) return;
        const r = document.createElement('div');
        r.style.cssText = `position:fixed;left:${x - 22}px;top:${y - 22}px;width:44px;height:44px;border-radius:50%;border:3px solid rgba(62,207,142,0.95);background:rgba(62,207,142,0.25);z-index:2147483646;pointer-events:none;transform:scale(0.3);opacity:1;transition:transform 450ms ease-out, opacity 450ms ease-out`;
        document.body.appendChild(r);
        requestAnimationFrame(() => { r.style.transform = 'scale(1.4)'; r.style.opacity = '0'; });
        setTimeout(() => r.remove(), 600);
    };
    // A highlight frame around an element, for the edit to point at
    window.__filmHighlight = (sel, on = true) => {
        document.querySelectorAll('.__film_hl').forEach(e => e.remove());
        if (!on) return;
        const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
        if (!el) return;
        const b = el.getBoundingClientRect();
        const h = document.createElement('div');
        h.className = '__film_hl';
        h.style.cssText = `position:fixed;left:${b.left - 6}px;top:${b.top - 6}px;width:${b.width + 12}px;height:${b.height + 12}px;border:3px solid #3ecf8e;border-radius:10px;box-shadow:0 0 0 4000px rgba(0,0,0,0.12);z-index:2147483645;pointer-events:none`;
        document.body.appendChild(h);
    };
})();
