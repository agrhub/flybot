// Runs in every recorded page before its own scripts (record.mjs). The flasher gets a stand-in serial port, picked in
// an imitation of the browser's port chooser (a headless browser has no chooser and no board to talk to).
(() => {
    const LANG = '__LANG__';
    try { localStorage.setItem('camosLang', LANG); } catch (e) { /* no storage */ }
    if (!navigator.serial) return;
    const port = {
        readable: new ReadableStream({ start() {} }),
        writable: new WritableStream({ write() {} }),
        open: async () => {}, close: async () => {}, forget: async () => {},
        getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
        setSignals: async () => {}, getSignals: async () => ({}),
        addEventListener() {}, removeEventListener() {}
    };
    navigator.serial.requestPort = () => new Promise((resolve, reject) => {
        const box = document.createElement('div');
        box.id = 'portChooser';
        box.style.cssText = 'position:fixed;top:6px;left:70px;width:380px;background:#fff;color:#1f1f1f;border-radius:10px;'
            + 'box-shadow:0 4px 18px rgba(0,0,0,.28);font:14px system-ui,sans-serif;z-index:99999;padding:18px 18px 14px';
        box.innerHTML = `<div style="font-size:15px;margin-bottom:12px">${location.hostname === 'localhost' ? 'agrhub.github.io' : location.hostname} wants to connect to a serial port</div>
            <div id="pcItem" style="padding:10px 12px;border-radius:6px;cursor:pointer">USB-SERIAL CH340 (COM7)</div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
            <button id="pcOk" disabled style="padding:7px 16px;border-radius:16px;border:0;background:#dfe3e8;color:#888;font:inherit">Connect</button>
            <button id="pcNo" style="padding:7px 16px;border-radius:16px;border:1px solid #c4c7c5;background:#fff;color:#0b57d0;font:inherit">Cancel</button></div>`;
        document.body.appendChild(box);
        const ok = box.querySelector('#pcOk');
        box.querySelector('#pcItem').onclick = (e) => {
            e.currentTarget.style.background = '#d3e3fd';
            ok.disabled = false; ok.style.background = '#0b57d0'; ok.style.color = '#fff';
        };
        ok.onclick = () => { box.remove(); resolve(port); };
        box.querySelector('#pcNo').onclick = () => { box.remove(); reject(new DOMException('No port selected by the user.', 'NotFoundError')); };
    });
})();
