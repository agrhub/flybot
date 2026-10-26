// The film's screen recordings, in the order of the film. session 'guest': Guest access in a headless Chrome;
// session 'owner': the owner's signed-in window (record-app.mjs browser). run(a) gets the actions of record-app.mjs.
// Shots run in real time; film.html picks the part of each take it shows and may speed it up.

const select = async (a, current, option) => {
    await a.click({ sel: '.el-select', text: current }, { after: 700 });
    await a.click({ sel: '.el-select-dropdown__item', text: option }, { after: 1500 });
};
const closeDialogs = (a) => a.js(`document.querySelectorAll('.el-notification').forEach(n => n.remove()); return true;`);


// Waits until an element's text stops changing for quietMs (an answer streaming in, a log filling up)
const settle = async (a, sel, quietMs = 4000, maxMs = 60000) => {
    let last = '', still = 0;
    for (let t = 0; t < maxMs && still * 500 < quietMs; t += 500) {
        await a.sleep(500);
        const now = await a.js(`return (document.querySelector(${JSON.stringify(sel)}) || {}).innerText || '';`);
        still = now === last ? still + 1 : 0;
        last = now;
    }
};
const settingsTab = (a, name) => a.click({ text: name, sel: '.el-menu-item, li, a', exact: true }, { after: 4000 });

export const SHOTS = [
    {
        // Sign-in page, the Guest access button, the dashboard with the guest and simulated-data banners
        name: 'guest-login', session: 'guest',
        async run(a) {
            await a.goto('/auth/login', 3500);
            await a.sleep(1200);
            await a.move({ text: 'Guest access', sel: 'button' }, 1100);
            await a.sleep(600);
            await a.click({ text: 'Guest access', sel: 'button' }, { after: 6000 });
            await a.move({ text: 'This view includes simulated demo data' }, 1200);
            await a.sleep(2500);
        }
    },
    {
        // Density card: the real traps, then one simulated farm and its sticky cards
        name: 'dashboard', session: 'guest',
        async run(a) {
            await a.goto('/dashboard', 6000);
            await a.move({ x: 1100, y: 700 }, 600);
            await a.scroll(900, { ms: 1800 });
            await a.sleep(1500);
            await a.move({ text: 'Bình Dương', sel: 'span, div' }, 900);
            await a.sleep(1200);
            await select(a, 'All farms', 'Cái Bè');
            await a.sleep(1200);
            await a.sleep(2000);
        }
    },
    {
        // Cameras: search, filters, columns
        name: 'cameras', session: 'guest',
        async run(a) {
            await a.goto('/cameras', 6000);
            await a.sleep(1000);
            await select(a, 'Real and simulated', 'Real cameras');
            await a.sleep(2200);
            await select(a, 'Real cameras', 'Simulated');
            await select(a, 'All trap kinds', 'Sticky');
            await a.sleep(1200);
            await a.click({ text: '4 cols', sel: '.el-segmented__item' }, { after: 1500 });
            await a.click({ text: '5 cols', sel: '.el-segmented__item' }, { after: 1800 });
            await a.click({ sel: 'input', text: 'Search cameras' }, { after: 300 });
            await a.type('Cái Bè', 110);
            await a.sleep(2500);
            await a.click({ text: '3 cols', sel: '.el-segmented__item' }, { after: 2200 });
        }
    },
    {
        // A simulated sticky trap: its latest photo with the OpenCV boxes and "Drawn: N"
        name: 'sticky-photo', session: 'guest',
        async run(a) {
            await a.goto('/cameras', 6000);
            await a.click({ sel: 'input', text: 'Search cameras' }, { after: 300 });
            await a.type('Showcase D', 90);
            await a.sleep(1500);
            await a.click({ text: 'Details', sel: 'a, button, span', exact: true }, { after: 5000 });
            await a.move({ text: 'Detection history of this camera' }, 800);
            await a.scroll(700, { ms: 1400 });
            await a.sleep(1200);
            await a.move({ text: 'Drawn:', sel: 'span, div' }, 900);
            await a.sleep(1500);
            await a.click({ sel: '.el-table__body .el-button' }, { after: 3500 });
            await a.move({ text: 'OpenCV yolo26n counted', sel: '.el-dialog *' }, 1200);
            await a.sleep(2500);
            await a.move({ x: 780, y: 400 }, 1200);
            await a.sleep(2500);
        }
    },
    {
        // Sentinel: a trace opened, perception -> decision -> action, the evidence pictures
        name: 'sentinel-trace', session: 'guest',
        async run(a) {
            await a.goto('/sentinel', 6000);
            await a.sleep(1500);
            await a.click({ text: 'Traces', sel: '.el-tabs__item, [role=tab], a, button', exact: true }, { after: 4000 });
            const row = await a.js(`const r = [...document.querySelectorAll('.el-table__row')].findIndex(r => /Sticky card/.test(r.innerText)); return r;`);
            await a.click({ sel: '.el-table__row .el-table__expand-icon', index: Math.max(0, row) }, { after: 3000 });
            await a.move({ text: 'Perception (OpenCV)' }, 900);
            await a.scroll(420, { ms: 2200 });
            await a.sleep(2200);
            await a.move({ text: 'Rules that applied' }, 1000);
            await a.sleep(1800);
            await a.move({ text: 'What the agent did' }, 1000);
            await a.sleep(1800);
            await a.scroll(520, { ms: 2200 });
            await a.sleep(3000);
        }
    },
    {
        // Approvals waiting for a person (the guest cannot decide)
        name: 'approvals', session: 'guest',
        async run(a) {
            await a.goto('/sentinel/approvals', 6000);
            await a.move({ x: 1000, y: 600 }, 800);
            await a.sleep(1500);
            await a.scroll(500, { ms: 1500 });
            await a.sleep(2000);
        }
    },
    {
        // The assistant answers from the counts
        name: 'assistant', session: 'guest',
        async run(a) {
            await a.goto('/dashboard', 6000);
            await a.click({ text: 'Assistant', sel: 'button' }, { after: 1800 });
            // Something over the top bar can take the mouse click: open the panel from the page then
            const open = await a.js(`return !!document.querySelector('#smart-trap-assistant-sidebar input')?.offsetParent;`);
            if (!open) {
                await a.js(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Assistant').click(); return true;`);
                await a.sleep(1500);
            }
            await a.click({ sel: 'input', text: 'Ask the FlyBot assistant' }, { after: 300 });
            await a.type('How many flies on the traps this week?', 55);
            await a.sleep(500);
            // The send button, then the answer: done once the panel's text stops changing for 4 s
            const send = await a.js(`const b = [...document.querySelectorAll('#smart-trap-assistant-sidebar form button')].pop(); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
            await a.move(send, 600);
            await a.js(`window.__filmRipple(${send.x}, ${send.y}); document.querySelector('#smart-trap-assistant-sidebar form').requestSubmit(); return true;`);
            let last = '', still = 0;
            for (let i = 0; i < 180 && still < 8; i++) {
                await a.sleep(500);
                const now = await a.js(`return document.getElementById('smart-trap-assistant-sidebar').innerText;`);
                // "The assistant is looking into it..." does not change either: wait for the answer itself
                still = now === last && !/looking into it/i.test(now) ? still + 1 : 0;
                last = now;
            }
            await a.js(`const b = document.querySelector('#smart-trap-assistant-sidebar .overflow-y-auto'); if (b) b.scrollTo({ top: b.scrollHeight, behavior: 'smooth' }); return true;`);
            await a.sleep(4000);
            await closeDialogs(a);
        }
    },
    {
        // Field map: the simulated network across Vietnam and the heat map
        name: 'map', session: 'guest',
        async run(a) {
            await a.goto('/map', 8000);
            await a.move({ x: 900, y: 600 }, 800);
            await a.sleep(1500);
            await a.click({ text: 'Heatmap', sel: 'span, label, div' }, { after: 2500 });
            await a.scroll(-600, { ms: 1500 });
            await a.sleep(2500);
        }
    },
    {
        // Reports
        name: 'reports', session: 'guest',
        async run(a) {
            await a.goto('/reports', 6000);
            await a.move({ x: 900, y: 500 }, 800);
            await a.sleep(1500);
            await a.click({ sel: '.el-card, .report-card, a[href*="/reports/"]', index: 0 }, { after: 1500 });
            // The figures of 114 traps take a few seconds: the film cuts that wait out (edit.js)
            await a.find({ text: 'Flies caught' }, { timeout: 45000 });
            await a.sleep(1200);
            // A report shared with the guest: its public link to pass on
            await a.move({ text: 'Copy the public link', sel: 'button' }, 900);
            await a.sleep(1800);
            await a.scroll(700, { ms: 2000 });
            await a.sleep(2000);
        }
    },
    {
        // The ESP32-S3 trap camera: live view at 480p (JPEG 640x480), then its remote log
        name: 'esp32-live', session: 'owner',
        async run(a) {
            await a.goto('/cameras', 6000);
            try {
                await select(a, 'All types', 'CamOS');
                await a.sleep(1500);
                await a.click({ text: 'Details', sel: 'a, button, span', exact: true }, { after: 4000 });
            } catch (err) {
                // The type filter did not open (a slow page): straight to the trap camera's page, whose serial comes
                // from the environment (never from this file)
                if (!process.env.FLYBOT_FILM_ESP32) throw err;
                await a.goto('/cameras/' + process.env.FLYBOT_FILM_ESP32, 6000);
            }
            try {
                await a.click({ sel: '.kvs-viewer__quality' }, { after: 900 });
                await a.click({ sel: '.el-dropdown-menu__item', text: '480p' }, { after: 1000 });
            } catch { /* a firmware without the 480p tier: the camera's own choice */ }
            // A camera on battery opens live at its next check-in (every 2 or 10 minutes by day): wait up to 12 minutes
            for (let i = 0; i < 1440; i++) {
                const playing = await a.js(`return [...document.querySelectorAll('video, canvas, img.kvs-viewer__jpeg')].some(v => (v.videoWidth || v.naturalWidth || 0) > 0);`);
                if (playing) break;
                await a.sleep(500);
            }
            await a.move({ x: 900, y: 520 }, 900);
            await a.sleep(9000);
        }
    },
    {
        name: 'camera-log', session: 'owner',
        async before(a) {
            await a.goto('/cameras', 6000);
            await select(a, 'All types', 'CamOS');
            await a.click({ text: 'Details', sel: 'a, button, span', exact: true }, { after: 5000 });
            // The log lives in the camera's settings dialog (its Camera log tab, #pane-log), next to the firmware
            await a.click({ sel: '[data-test="camos-settings-open"]' }, { after: 1500 });
            // The dialog loads the camera's settings first; a click that did not open it is repeated in the page
            for (let i = 0; i < 40; i++) {
                if (await a.js(`return !!document.querySelector('#tab-log');`)) break;
                if (i === 10) await a.js(`document.querySelector('[data-test="camos-settings-open"]').click(); return true;`);
                await a.sleep(500);
            }
            // After the dialog's opening animation: a click that lands on the overlay would close it
            await a.sleep(1200);
            await a.move({ sel: '#tab-log' }, 600);
            await a.js(`document.querySelector('#tab-log').click(); return true;`);
            await a.sleep(1500);
        },
        async run(a) {
            await a.sleep(1000);
            // Turned on already (it stays on 15 min)? Then only watch the lines come in
            const off = await a.js(`return [...document.querySelectorAll('#pane-log button')].some(b => b.innerText.trim() === 'Turn on');`);
            if (off) await a.click({ text: 'Turn on', sel: '#pane-log button' }, { after: 1500 });
            await a.js(`document.querySelector('#pane-log').id = '__film_log'; return true;`);
            await settle(a, '#__film_log', 6000, 40000);
            await a.sleep(6000);
        }
    },
    {
        // Admin: firmware releases per channel, the camera fleet
        name: 'firmware', session: 'owner',
        async run(a) {
            // Straight to the tab: the default tab is the profile form
            await a.goto('/settings?tab=adminFirmware', 6000);
            await a.move({ text: 'AIC-FREENOVE-S3CAM', sel: 'td *, td' }, 1000);
            await a.sleep(2500);
            await a.move({ text: 'Alpha:', sel: 'span, div, button' }, 900);
            await a.sleep(1500);
            await settingsTab(a, 'Camera fleet');
            await a.sleep(1500);
            await a.move({ text: 'ESP32-S3 trap', sel: 'td *, td' }, 1000);
            await a.sleep(2000);
            await a.move({ text: 'Release channel', sel: 'button' }, 900);
            await a.sleep(2500);
        }
    }
];
