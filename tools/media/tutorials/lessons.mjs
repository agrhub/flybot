// The CamOS tutorial videos: what each one shows, its clicks and its captions in both languages (record.mjs).
// r.t(en, vi) picks the take's language. Every value on screen comes from the mock camera (serial ESP000000000001,
// verify code ABC123) or is made up here; the pictures are drawings.

import fs from 'node:fs';

const DISCLAIMER = ['Screens from a mock camera with made-up values; the pictures are drawings.',
    'Màn hình từ camera giả lập với dữ liệu mẫu; hình ảnh là hình vẽ minh họa.'];
const REPO_LINK = 'github.com/agrhub/camos-esp32-trap';

async function opening(r, n, title, foot = DISCLAIMER) {
    await r.scene({ kind: 'card', title: r.t(...title), sub: r.t(`CamOS trap camera · video ${n} of 5`, `Camera bẫy CamOS · video ${n}/5`), foot: r.t(...foot) });
    await r.hold(3.5);
}
async function closing(r, title, guide, bullets = []) {
    await r.scene({ kind: 'card', title: r.t(...title), bullets: bullets.map(b => r.t(...b)), foot: `${REPO_LINK} · ${guide}` });
    await r.hold(bullets.length ? 2.5 + bullets.length * 1.6 : 3.5);
}

// The flasher's install, played: there is no board behind the stand-in serial port
const STUB_INSTALL = `const d = document.querySelector('ewt-install-dialog');
    d._confirmInstall = () => { d._installConfirmed = true; d._installState = { state: 'preparing', message: 'Preparing installation', details: undefined }; };
    return true;`;
const installState = (state) => `document.querySelector('ewt-install-dialog')._installState = ${JSON.stringify(state)}; return true;`;

export const LESSONS = [
    {
        name: 'flash',
        title: ['Flash a new board', 'Nạp firmware cho board mới'],
        async run(r) {
            const t = r.t;
            await opening(r, 1, ['Flash a new board', 'Nạp firmware cho board mới']);
            await r.scene({ kind: 'card', title: t('Before you start', 'Chuẩn bị'), bullets: [
                t('Freenove ESP32-S3 CAM, or an ESP32-S3 N16R8 CAM with an OV5640', 'Board Freenove ESP32-S3 CAM, hoặc ESP32-S3 N16R8 CAM với camera OV5640'),
                t('A USB-C data cable (many charger cables carry power only)', 'Cáp USB-C truyền được dữ liệu (nhiều cáp sạc chỉ có nguồn)'),
                t('The board\'s USB-C port marked CH340', 'Cổng USB-C có ghi CH340 trên board'),
                t('Chrome or Edge on a computer (not a phone)', 'Chrome hoặc Edge trên máy tính (không dùng điện thoại)')
            ] });
            await r.hold(8);

            await r.scene({ kind: 'desktop', url: r.local('/flash/'), address: 'agrhub.github.io/camos-esp32-trap/flash/' });
            r.say(t('Open agrhub.github.io/camos-esp32-trap/flash/ in Chrome or Edge.', 'Mở agrhub.github.io/camos-esp32-trap/flash/ bằng Chrome hoặc Edge.'));
            await r.hold(3.5);
            r.say(t('Plug the board into the computer through the CH340 port.', 'Cắm board vào máy tính qua cổng CH340.'));
            await r.hold(3);
            r.say(t('Under “Choose the board”, click Install next to the Freenove board.', 'Ở mục “Chọn board”, bấm “Nạp firmware” cạnh board Freenove.'));
            await r.highlight({ sel: '.board' });
            await r.hold(1.5);
            await r.click({ sel: 'esp-web-install-button button' }, { after: 0.8 });
            await r.highlight(null);
            r.say(t('The browser lists the serial ports: pick USB-SERIAL CH340 (COMx) and click Connect.', 'Trình duyệt hiện các cổng serial: chọn USB-SERIAL CH340 (COMx) và bấm Connect.'));
            await r.hold(1.5);
            await r.click({ sel: '#pcItem' }, { after: 0.6 });
            await r.click({ sel: '#pcOk' }, { after: 0.5 });
            await r.until(`return !!document.querySelector('ewt-install-dialog')?.shadowRoot?.textContent.includes('Logs')`);
            await r.js(STUB_INSTALL);
            r.say(t('Choose “Install CamOS trap camera”.', 'Chọn “Install CamOS trap camera”.'));
            await r.hold(1);
            await r.click({ sel: 'ew-list-item', text: 'Install CamOS' }, { after: 1 });
            r.say(t('A new board: tick “Erase device”, then click Next.', 'Board mới: đánh dấu “Erase device” rồi bấm Next.'));
            await r.hold(1);
            await r.click({ sel: 'label', text: 'Erase device' }, { after: 0.6 });
            await r.click({ sel: 'ew-text-button', text: 'Next', exact: true }, { after: 1 });
            r.say(t('Confirm with Install.', 'Xác nhận bằng Install.'));
            await r.hold(1);
            await r.click({ sel: 'ew-text-button', text: 'Install', exact: true }, { after: 0.6 });
            r.say(t('The page erases the board and writes the firmware. It takes about a minute: keep the board plugged in.', 'Trang web xóa bộ nhớ board và ghi firmware, mất khoảng một phút: đừng rút cáp.'));
            await r.js(installState({ state: 'erasing', message: 'Erasing device', details: undefined }));
            await r.hold(2);
            for (let pct = 0; pct <= 100; pct += 5) {
                await r.js(installState({ state: 'writing', message: `Writing progress: ${pct}%`, details: { bytesTotal: 3145728, bytesWritten: Math.round(31457.28 * pct), percentage: pct } }));
                await r.hold(0.3);
            }
            await r.js(installState({ state: 'finished', message: 'All done!', details: undefined }));
            r.say(t('Done. Close the dialog, then press RST on the board (or plug it in again).', 'Xong. Đóng hộp thoại, rồi bấm nút RST trên board (hoặc cắm lại cáp).'));
            await r.hold(4);
            r.say(t('A camera that already works: use the Update buttons instead. They keep its settings and its FlyBot registration.', 'Camera đang chạy: dùng các nút cập nhật bên dưới. Chúng giữ cài đặt và đăng ký FlyBot của camera.'));
            await r.js(`document.querySelector('ewt-install-dialog').remove(); document.body.style.overflow = ''; return true;`);
            await r.capture();
            await r.highlight({ sel: '.note', text: 'Freenove' });
            await r.hold(5);
            await r.highlight(null);

            await closing(r, ['After flashing', 'Sau khi nạp'], 'docs/FLASHING.md', [
                ['LED breathing blue: the setup Wi-Fi CAM-xxxx is open (video 2)', 'Đèn LED xanh dương nhấp nháy chậm: Wi-Fi cài đặt CAM-xxxx đã mở (video 2)'],
                ['With a 4G SIM in a wired module, the camera goes online by itself', 'Có SIM 4G trong module 4G đã nối dây: camera tự kết nối mạng'],
                ['No port listed? Try another cable or USB socket', 'Không thấy cổng? Thử cáp khác hoặc cổng USB khác'],
                ['Still nothing: hold BOOT, press and release RST, release BOOT, then Install again', 'Vẫn không được: giữ BOOT, bấm và nhả RST, nhả BOOT, rồi bấm nạp lại']
            ]);
        }
    },
    {
        name: 'wifi',
        title: ['Wi-Fi setup on a phone', 'Cài đặt Wi-Fi bằng điện thoại'],
        async run(r) {
            const t = r.t;
            await opening(r, 2, ['Wi-Fi setup on a phone', 'Cài đặt Wi-Fi bằng điện thoại']);

            await r.scene({ kind: 'phone', url: r.local(`/props/phone-wifi.html?lang=${r.lang}`), settle: 800 });
            r.say(t('The LED breathes blue: the camera has opened its own Wi-Fi, CAM-xxxx (the last 4 characters of its serial).', 'Đèn LED xanh dương nhấp nháy chậm: camera đã mở Wi-Fi riêng CAM-xxxx (4 ký tự cuối của serial).'));
            await r.hold(4.5);
            r.say(t('On your phone, open the Wi-Fi settings and tap CAM-xxxx.', 'Trên điện thoại, mở cài đặt Wi-Fi và chạm vào CAM-xxxx.'));
            await r.hold(1);
            await r.click({ sel: '.net', text: 'CAM-0001' }, { after: 0.8 });
            r.say(t('Its password is camos1234.', 'Mật khẩu là camos1234.'));
            await r.click({ sel: '#pw' }, { after: 0.3 });
            await r.type('camos1234');
            await r.hold(0.6);
            await r.click({ sel: '#join' }, { after: 1.5 });
            r.say(t('Your phone may warn that this Wi-Fi has no Internet: stay connected. The setup page opens by itself.', 'Điện thoại có thể báo Wi-Fi này không có Internet: cứ giữ kết nối. Trang cài đặt sẽ tự mở.'));
            await r.hold(4.5);

            await r.scene({ kind: 'phone', url: r.mock(`/portal?unclaimed=1&lang=${r.lang}`) });
            // The mock joins in 3 s; a real join takes longer: count a few more seconds first
            await r.js(`const f = window.fetch; let n = 0;
                window.fetch = (u, o) => String(u).includes('/api/connect') && !(o && o.method === 'POST') && ++n <= 6
                    ? Promise.resolve(new Response(JSON.stringify({ state: 'joining', ssid: 'Orchard-AP', elapsedS: n }), { headers: { 'Content-Type': 'application/json' } }))
                    : f(u, o);
                return true;`);
            r.say(t('If it does not open, type http://192.168.4.1 in the browser.', 'Nếu trang không tự mở, gõ http://192.168.4.1 vào trình duyệt.'));
            await r.hold(3.5);
            r.say(t('A new camera shows its claim QR code, serial and verify code: claim it in FlyBot now or later (video 5).', 'Camera mới hiện mã QR, serial và mã xác minh để nhận camera trên FlyBot, ngay hoặc để sau (video 5).'));
            await r.highlight({ sel: '#claimBox' });
            await r.hold(5);
            await r.highlight(null);
            r.say(t('The list shows the networks the camera hears, strongest first. It needs a 2.4 GHz network.', 'Danh sách hiện các mạng camera bắt được, mạnh nhất ở trên. Camera cần mạng 2,4 GHz.'));
            await r.scroll(260, { sec: 0.8, x: 195, y: 600 });
            await r.highlight({ sel: '#nets' });
            await r.hold(4.5);
            await r.highlight(null);
            r.say(t('Tap your network and type its password.', 'Chạm vào mạng của bạn và nhập mật khẩu.'));
            await r.click({ sel: '.net', text: 'Orchard-AP' }, { after: 0.6 });
            await r.click({ sel: '#password' }, { after: 0.3 });
            await r.type('example-pass');
            r.say(t('“Show” reveals what you typed.', '“Hiện” để xem lại mật khẩu đã nhập.'));
            await r.click({ sel: '#pwToggle' }, { after: 1.5 });
            r.say(t('Tap Connect.', 'Chạm Kết nối.'));
            await r.click({ sel: '#connect' }, { after: 0.3 });
            r.say(t('The camera tries your network while the page counts the seconds. If your phone drops CAM-xxxx meanwhile, join it again.', 'Camera thử kết nối mạng của bạn, trang đếm từng giây. Nếu điện thoại rời CAM-xxxx, hãy kết nối lại vào CAM-xxxx.'));
            await r.until(`return document.getElementById('localNext').innerText.includes('flybot-000001') && !document.querySelector('#tConnectingText .spin')`, 30);
            r.say(t('Connected! Note the local name: http://flybot-000001.local/ opens the web console (video 3).', 'Đã kết nối! Ghi lại tên cục bộ: http://flybot-000001.local/ mở trang quản trị web (video 3).'));
            await r.highlight({ sel: '#localNext' });
            await r.hold(5);
            await r.highlight(null);
            r.say(t('The camera restarts onto your Wi-Fi and CAM-xxxx disappears. LED: yellow blinks, then a green blip every 5 s = online.', 'Camera khởi động lại vào Wi-Fi của bạn và CAM-xxxx biến mất. Đèn LED nháy vàng, rồi chớp xanh lá mỗi 5 giây = đã kết nối.'));
            await r.hold(5);

            await r.scene({ kind: 'phone', url: r.mock(`/portal?lang=${r.lang}`) });
            await r.js(`const f = window.fetch; let n = 0;
                window.fetch = (u, o) => String(u).includes('/api/connect') && !(o && o.method === 'POST') && ++n >= 3
                    ? Promise.resolve(new Response(JSON.stringify({ state: 'failed', reason: 'auth', ssid: 'Orchard-AP' }), { headers: { 'Content-Type': 'application/json' } }))
                    : f(u, o);
                return true;`);
            r.say(t('Wrong password? The page says so and empties the field: type it again.', 'Sai mật khẩu? Trang báo lỗi và xóa ô mật khẩu: nhập lại.'));
            await r.click({ sel: '.net', text: 'Orchard-AP' }, { after: 0.4 });
            await r.click({ sel: '#password' }, { after: 0.3 });
            await r.type('wrong-pass', { cps: 16 });
            await r.click({ sel: '#connect' }, { after: 0.3 });
            await r.until(`return !document.getElementById('errBox').classList.contains('hidden')`, 20);
            await r.find({ sel: '#errBox' });
            await r.highlight({ sel: '#errBox' });
            await r.hold(4);
            r.say(t('Other reasons it names: network not found (move the camera closer) or no address within 30 s (check the router).', 'Lý do khác: không tìm thấy mạng (đưa camera lại gần) hoặc không nhận được địa chỉ trong 30 giây (kiểm tra router).'));
            await r.hold(5);
            await r.highlight(null);
            r.say(t('Advanced settings, under the Wi-Fi card: 4G, schedule, power, timezone. Most cameras need nothing here.', 'Cài đặt nâng cao, dưới thẻ Wi-Fi: 4G, lịch chụp, nguồn, múi giờ. Hầu hết camera không cần chỉnh gì ở đây.'));
            await r.click({ sel: '#tAdvanced' }, { after: 0.8 });
            await r.scroll(420, { sec: 1.2 });
            await r.hold(3.5);

            await closing(r, ['Wi-Fi setup, in short', 'Tóm tắt cài đặt Wi-Fi'], 'docs/PORTAL.md', [
                ['A 4G SIM needs no setup page: the camera goes online by itself', 'SIM 4G không cần trang cài đặt: camera tự kết nối mạng'],
                ['Open the setup page again: hold BOOT 3 s, release when the LED turns blue', 'Mở lại trang cài đặt: giữ BOOT 3 giây, nhả khi đèn LED chuyển xanh dương'],
                ['Factory reset: hold BOOT 10 s, until the LED turns red', 'Khôi phục cài đặt gốc: giữ BOOT 10 giây, đến khi đèn LED chuyển đỏ']
            ]);
        }
    },
    {
        name: 'console',
        title: ['The camera\'s web console', 'Trang quản trị web của camera'],
        async run(r) {
            const t = r.t;
            const host = 'flybot-000001.local';
            await opening(r, 3, ['The camera\'s web console', 'Trang quản trị web của camera']);

            await r.scene({ kind: 'desktop', url: r.mock(`/?gate=1&lang=${r.lang}`), address: `${host}/` });
            r.say(t('On the same Wi-Fi as the camera, open http://flybot-000001.local/ (or the camera\'s IP address).', 'Trên cùng mạng Wi-Fi với camera, mở http://flybot-000001.local/ (hoặc địa chỉ IP của camera).'));
            await r.hold(4.5);
            r.say(t('The first visit activates the camera: choose the admin password and type it twice. The user name is always admin.', 'Lần đầu truy cập sẽ kích hoạt camera: đặt mật khẩu quản trị và nhập hai lần. Tên đăng nhập luôn là admin.'));
            await r.click({ sel: '#gPass' }, { after: 0.3 });
            await r.type('Orchard2026', { cps: 14 });
            await r.click({ sel: '#gPass2' }, { after: 0.3 });
            await r.type('Orchard2026', { cps: 14 });
            await r.click({ sel: '#gateBtn' }, { after: 0.6 });

            // Live View
            await r.goto(r.mock(`/?lang=${r.lang}#live`), 2500);
            r.address(`${host}/#live`);
            r.say(t('Live View: the camera\'s live picture, about 5-10 frames a second on a good Wi-Fi.', 'Xem trực tiếp: hình ảnh trực tiếp của camera, khoảng 5-10 khung hình mỗi giây khi Wi-Fi tốt.'));
            await r.hold(4);
            r.say(t('Send to FlyBot takes a full-size photo now, uploads it for counting and keeps it on the SD card.', '“Gửi lên FlyBot” chụp ngay một ảnh đầy đủ, tải lên để đếm ruồi và lưu vào thẻ SD.'));
            await r.move({ sel: '#snap' });
            await r.highlight({ sel: '#snap' });
            await r.hold(4.5);
            r.say(t('Size and quality: larger is sharper but slower; Smooth suits a weak Wi-Fi.', 'Kích thước và chất lượng: lớn hơn thì nét hơn nhưng chậm hơn; “Mượt” hợp với Wi-Fi yếu.'));
            const size = await r.find({ sel: '#size' }), qual = await r.find({ sel: '#qual' });
            await r.move({ sel: '#size' });
            await r.highlight([size.box[0], size.box[1], qual.box[0] + qual.box[2] - size.box[0], size.box[3]]);
            await r.hold(4);
            r.say(t('The status panel: network, cloud, battery, power mode, next capture, motion and SD card.', 'Bảng trạng thái: mạng, đám mây, pin, chế độ nguồn, lần chụp kế tiếp, chuyển động và thẻ SD.'));
            await r.highlight({ sel: '.side .panel' });
            await r.hold(4.5);
            await r.highlight(null);

            // Playback
            r.say(t('Playback: the photos on the microSD card, by day. Pick a day on the left.', 'Xem lại: ảnh trên thẻ microSD, theo ngày. Chọn một ngày ở bên trái.'));
            await r.click({ sel: '#tPlay' }, { after: 1.5 });
            r.address(`${host}/#playback`);
            await r.click({ sel: '#dl a', index: 1 }, { after: 1.5 });
            await r.click({ sel: '#dl a', index: 0 }, { after: 1.2 });
            r.say(t('The time line has a mark for every photo; motion photos are red. Click a mark or a row of the list.', 'Thanh thời gian có một vạch cho mỗi ảnh; ảnh do chuyển động có màu đỏ. Bấm vào một vạch hoặc một dòng trong danh sách.'));
            await r.highlight({ sel: '#tl' });
            await r.hold(3.5);
            await r.highlight(null);
            await r.click({ sel: 'td', text: '09:41:09' }, { after: 1.5 });
            r.say(t('Previous and Next step through the day, Download saves the photo, Delete removes it.', '“Trước” và “Sau” để xem lần lượt trong ngày, “Tải về” để lưu ảnh, “Xóa” để xóa ảnh.'));
            await r.highlight({ sel: '#pPrev', up: 1 });
            await r.hold(4.5);
            await r.highlight(null);

            // Configuration, page by page
            r.say(t('Configuration: a menu on the left, in groups. Device Information has the serial number and the verify code, to claim the camera in FlyBot.', 'Cấu hình: menu bên trái, theo nhóm. Thông tin thiết bị có số serial và mã xác minh để nhận camera trên FlyBot.'));
            await r.click({ sel: '#tConfig' }, { after: 1.2 });
            r.address(`${host}/#config/device`);
            const serial = await r.find({ sel: '.kv div', text: 'ESP000000000001', exact: true });
            const code = await r.find({ sel: '.kv div', text: 'ABC123', exact: true });
            const kv = await r.find({ sel: '#page .kv' });
            await r.highlight([kv.box[0], serial.box[1], kv.box[2] * 0.5, code.box[1] + code.box[3] - serial.box[1]]);
            await r.hold(6);
            await r.highlight(null);
            const page = async (id, caption, after = 4.5, extra) => {
                await r.click({ sel: `aside a[data-p="${id}"]` }, { sec: 0.5, after: 0.5 });
                r.say(caption);
                r.address(`${host}/#config/${id}`);
                if (extra) await extra();
                await r.hold(after);
                await r.highlight(null);
            };
            await page('time', t('Time Settings: the camera\'s clock and timezone, set by themselves from FlyBot, the GPS or the IP address.', 'Cài đặt thời gian: đồng hồ và múi giờ của camera, tự đặt theo FlyBot, GPS hoặc địa chỉ IP.'));
            await page('maint', t('Maintenance & Upgrade: Check & upgrade asks FlyBot for a newer firmware, or upload an -update.bin file. Restart and Factory reset too.', 'Bảo trì & nâng cấp: “Kiểm tra & nâng cấp” hỏi FlyBot có firmware mới không, hoặc tải lên file -update.bin. Có cả Khởi động lại và Khôi phục cài đặt gốc.'), 5.5,
                () => r.highlight({ sel: '#fGo' }));
            await page('events', t('Events: photos taken and uploaded, motion, the SD card, settings saved.', 'Sự kiện: ảnh đã chụp và tải lên, chuyển động, thẻ SD, cài đặt đã lưu.'));
            await page('logs', t('Log: the camera\'s live log. Download it and send it along when you report a problem.', 'Nhật ký: nhật ký trực tiếp của camera. Tải về và gửi kèm khi báo lỗi.'), 4.5,
                () => r.highlight({ sel: '#lSave' }));
            await page('wifi', t('Wi-Fi / TCP/IP: the current connection, a static address if you need one, and Change Wi-Fi network.', 'Wi-Fi / TCP/IP: kết nối hiện tại, địa chỉ tĩnh nếu cần, và Đổi mạng Wi-Fi.'), 2.5);
            await r.scroll(420, { sec: 1.2, x: 750, y: 500 });
            await r.hold(2.5);
            // The 4G page of a camera on 4G (the mock's made-up IMEI and ICCID)
            r.say(t('4G: on 4G, the operator, the signal, the IMEI and the ICCID. The APN is chosen from the SIM.', '4G: khi dùng 4G, hiện nhà mạng, cường độ sóng, IMEI và ICCID. APN được chọn theo SIM.'));
            await r.goto(r.mock(`/?net=4g&lang=${r.lang}#config/cell`), 2000);
            r.address(`${host}/#config/cell`);
            await r.hold(5);
            await r.goto(r.mock(`/?lang=${r.lang}#config/cell`), 1500);
            await page('cloud', t('Cloud Platform: the FlyBot connection. Usually nothing to change: the camera registers itself.', 'Nền tảng đám mây: kết nối FlyBot. Thường không cần đổi gì: camera tự đăng ký.'));
            await page('image', t('Display: every image control next to the live picture. Set the orientation so the card is upright, then Save.', 'Hiển thị: các chỉnh ảnh nằm cạnh hình trực tiếp. Chỉnh hướng ảnh cho thẻ dính đứng thẳng, rồi bấm Lưu.'), 5,
                () => r.highlight({ sel: '#i_vflip', up: 2 }));
            await page('motion', t('Motion Detection: draw the area on the picture, set the sensitivity and choose what happens on motion.', 'Phát hiện chuyển động: vẽ vùng trên hình, chỉnh độ nhạy và chọn việc cần làm khi có chuyển động.'), 5);
            await page('schedule', t('Capture Schedule: a claimed camera follows the schedule set in FlyBot. The next photo times are listed.', 'Lịch chụp: camera đã được nhận sẽ theo lịch đặt trên FlyBot. Các lần chụp tiếp theo được liệt kê.'));
            await page('storage', t('Storage Management: the microSD card, “Save every photo to the card”, and what the native USB port does.', 'Quản lý lưu trữ: thẻ microSD, “Lưu mọi ảnh vào thẻ nhớ”, và chức năng của cổng USB native.'));
            await page('power', t('Power & Schedule: battery, solar, power mode. Tick “Battery / solar divider fitted” once the dividers are wired.', 'Nguồn & lịch: pin, năng lượng mặt trời, chế độ nguồn. Đánh dấu “Đã lắp mạch đo pin / pin mặt trời” khi đã nối các mạch chia áp.'), 5,
                () => r.highlight({ sel: '#pBatt', up: 1 }));
            await page('gps', t('GPS: the last position (FlyBot puts the trap on its map), the satellite systems and “Get position now”.', 'GPS: vị trí gần nhất (FlyBot đặt bẫy lên bản đồ), hệ vệ tinh và “Lấy vị trí ngay”.'));
            await page('account', t('Account: change the admin password. Forgot it? Hold BOOT 10 s: a factory reset.', 'Tài khoản: đổi mật khẩu quản trị. Quên mật khẩu? Giữ BOOT 10 giây để khôi phục cài đặt gốc.'));
            r.say(t('The language menu at the top switches the page to Tiếng Việt; the setup page follows.', 'Menu ngôn ngữ ở trên cùng chuyển trang sang English; trang cài đặt Wi-Fi cũng đổi theo.'));
            await r.move({ sel: '#hLang' });
            await r.highlight({ sel: '#hLang' });
            await r.hold(1.5);
            if (r.lang === 'en') {
                await r.js(`const s = document.getElementById('hLang'); s.value = 'vi'; s.dispatchEvent(new Event('change')); return true;`);
                await r.hold(1);
                await r.highlight(null);
            }
            await r.hold(3);
            await r.highlight(null);

            await closing(r, ['Good to know', 'Cần biết'], 'docs/WEB_CONSOLE.md', [
                ['The web console works on the local Wi-Fi only; from anywhere, use FlyBot', 'Trang quản trị chỉ dùng được trong mạng Wi-Fi nội bộ; ở xa thì dùng FlyBot'],
                ['A session ends after 30 minutes without use; Sign out is at the top right', 'Phiên đăng nhập hết sau 30 phút không dùng; nút Đăng xuất ở góc trên bên phải'],
                ['5 wrong passwords lock the sign-in for 5 minutes', 'Sai mật khẩu 5 lần sẽ khóa đăng nhập 5 phút']
            ]);
        }
    },
    {
        name: 'wiring',
        title: ['Wiring and assembly', 'Đấu dây và lắp ráp'],
        poster: 0.25,
        async run(r) {
            const t = r.t;
            // A part of the picture: zoom to its box, an optional highlight, the caption
            const look = async (box, caption, sec, light) => {
                r.say(caption);
                if (box) await r.zoom(box, 'fit', 1); else await r.zoom(null, 1, 1);
                if (light) await r.highlight(light);
                await r.hold(sec);
                await r.highlight(null);
            };
            await opening(r, 4, ['Wiring and assembly', 'Đấu dây và lắp ráp']);
            await r.scene({ kind: 'card', title: t('Only for the field camera', 'Chỉ dành cho camera ngoài vườn'), bullets: [
                t('A Wi-Fi camera needs no wiring: the board, its camera and a 5 V USB charger', 'Camera Wi-Fi không cần đấu dây: board, camera và một cục sạc USB 5 V'),
                t('The field camera adds 4G, GPS, a LiPo cell, a charger and a solar panel', 'Camera ngoài vườn có thêm 4G, GPS, pin LiPo, mạch sạc và tấm pin mặt trời'),
                t('Flash and set up the board on the bench first (videos 1-3)', 'Nạp firmware và cài đặt board trên bàn trước (video 1-3)')
            ] });
            await r.hold(6.5);

            // The wiring diagram of docs/WIRING.md (a drawing; pins are the firmware defaults)
            await r.scene({ kind: 'image', url: r.local('/img/wiring-overview.svg'), w: 1320, h: 1090, dsf: 2, settle: 800 });
            await look(null, t('The whole field camera on one page. Wired as drawn, firmware 0.9.2 and later needs no settings.', 'Toàn bộ camera ngoài vườn trên một trang. Đấu đúng như hình thì firmware 0.9.2 trở lên không cần cài đặt gì.'), 5);
            await look([30, 120, 560, 580], t('Power: the solar panel feeds the TP4056 charger (IN+ / IN−) through a screw terminal; the LiPo cell goes on B+ / B−.', 'Nguồn: tấm pin mặt trời cấp vào mạch sạc TP4056 (IN+ / IN−) qua cầu đấu; pin LiPo nối vào B+ / B−.'), 6);
            await look([440, 130, 640, 820], t('Charger OUT+ is BAT+ (red): it feeds the 4G switch, the GPS, the boost board and the battery divider.', 'OUT+ của mạch sạc là BAT+ (dây đỏ): cấp cho công tắc 4G, GPS, mạch tăng áp và mạch đo pin.'), 6);
            await look([590, 555, 720, 160], t('The 5 V boost board feeds the board\'s 5V pin. Set it to 5 V and measure 5.0-5.2 V before you connect it.', 'Mạch tăng áp 5 V cấp vào chân 5V của board. Chỉnh về 5 V và đo được 5,0-5,2 V rồi mới nối vào.'), 6, [698, 568, 244, 134]);
            await look([575, 95, 500, 400], t('4G (A7680C): VCC from BAT+ through the AO3401 P-MOSFET, switched by GPIO47 through a C1815. 1000 µF + 100 nF right at VCC.', '4G (A7680C): VCC lấy từ BAT+ qua MOSFET kênh P AO3401, đóng cắt bằng GPIO47 qua transistor C1815. Tụ 1000 µF + 100 nF sát chân VCC.'), 7);
            await look([690, 100, 620, 520], t('RXD to GPIO41, TXD to GPIO42, the LTE antenna, and a nano SIM with data: the APN is chosen from the SIM.', 'RXD nối GPIO41, TXD nối GPIO42, gắn ăng-ten LTE và nano SIM có data: APN tự chọn theo SIM.'), 6);
            await look([690, 745, 610, 335], t('GPS (ATGM336H): VCC on BAT+, its ground switched by a C1815 from GPIO21. TX to GPIO14, RX to GPIO3.', 'GPS (ATGM336H): VCC nối BAT+, chân GND đóng cắt bằng C1815 từ GPIO21. TX nối GPIO14, RX nối GPIO3.'), 6.5);
            await look([690, 745, 610, 335], t('The GPS patch antenna faces the sky, 10 cm or more from the LTE antenna.', 'Ăng-ten GPS hướng lên trời, cách ăng-ten LTE từ 10 cm trở lên.'), 4);
            await look([600, 380, 700, 150], t('Battery divider: 100k / 100k from BAT+, 100 nF, to GPIO1 (4.2 V reads as 2.1 V).', 'Mạch đo pin: chia áp 100k / 100k từ BAT+, tụ 100 nF, vào GPIO1 (4,2 V đọc thành 2,1 V).'), 5.5, [698, 386, 244, 136]);
            await look([30, 270, 1270, 210], t('Solar divider: 100k / 33k from the panel to GPIO2. Then tick “Battery / solar divider fitted” in the setup page or the web console.', 'Mạch đo pin mặt trời: chia áp 100k / 33k từ tấm pin vào GPIO2. Sau đó đánh dấu “Đã lắp mạch đo pin / pin mặt trời” trên trang cài đặt hoặc trang quản trị web.'), 7);
            await look([1030, 140, 270, 920], t('The ESP32-S3 pin map: every pin here is a firmware default. USB stays free for flashing and logs.', 'Sơ đồ chân ESP32-S3: mọi chân ở đây là mặc định của firmware. Cổng USB để trống cho nạp firmware và xem log.'), 5.5);
            await look(null, t('Check the silkscreen of the boards you receive against docs/WIRING.md before the first power-up.', 'Đối chiếu ký hiệu in trên các board bạn nhận được với docs/WIRING.md trước khi cấp điện lần đầu.'), 4);

            await r.scene({ kind: 'card', title: t('Order of assembly', 'Thứ tự lắp ráp'), bullets: [
                t('The board alone on USB: flash, Wi-Fi, a snapshot from the web console', 'Board riêng trên USB: nạp firmware, Wi-Fi, chụp thử từ trang quản trị web'),
                t('Add the battery divider; compare the battery value with a multimeter', 'Thêm mạch đo pin; so giá trị pin với đồng hồ đo'),
                t('Add the GPS and its switch; take a fix outdoors', 'Thêm GPS và công tắc của nó; lấy vị trí ngoài trời'),
                t('Add the 4G module with thick supply wires; insert the SIM', 'Thêm module 4G với dây nguồn to; lắp SIM'),
                t('Then the solar charger, the cell and the box', 'Sau cùng là mạch sạc, pin và hộp')
            ] });
            await r.hold(10);

            // The trap on its post (the drawing of docs/ASSEMBLY.md)
            await r.scene({ kind: 'image', url: r.local('/img/trap-illustration.svg'), w: 1100, h: 700, dsf: 2, settle: 800 });
            await look(null, t('In the orchard: a post 1.2-1.5 m high, in the canopy shade, where the farm hangs its fruit-fly traps.', 'Ngoài vườn: cột cao 1,2-1,5 m, dưới bóng tán cây, chỗ nhà vườn vẫn treo bẫy ruồi vàng.'), 5);
            await look([110, 190, 360, 300], t('The sticky card 15-25 cm in front of the lens, square to it and centred. Mount both on the same post.', 'Thẻ dính cách ống kính 15-25 cm, vuông góc và ở chính giữa. Gắn cả hai trên cùng một cột.'), 6);
            await look([250, 230, 200, 140], t('The lens sits centred behind a clear window, 2-5 mm from it. Focus on the card in Live View, then lock the lens.', 'Ống kính đặt giữa, sau một ô kính trong, cách 2-5 mm. Lấy nét vào thẻ dính bằng Xem trực tiếp, rồi cố định ống kính.'), 6);
            await look([540, 50, 420, 140], t('Solar panel on the roof, facing the equator (south in Vietnam), tilted about 15°. Shade the card from direct sun.', 'Tấm pin mặt trời trên mái, hướng về xích đạo (hướng nam ở Việt Nam), nghiêng khoảng 15°. Che nắng trực tiếp cho thẻ dính.'), 6);
            await look([280, 190, 220, 260], t('The LTE antenna vertical; cables enter at the bottom with a drip loop; a bag of silica gel inside.', 'Ăng-ten LTE dựng đứng; dây vào từ đáy hộp, có vòng chống nước nhỏ giọt; bỏ một gói hút ẩm bên trong.'), 6);
            await look(null, t('Power on: a green blip every 5 s means online. The first photo comes at the next capture slot.', 'Bật nguồn: đèn chớp xanh lá mỗi 5 giây là đã kết nối. Ảnh đầu tiên đến ở lần chụp kế tiếp.'), 4.5);

            await closing(r, ['Wiring and assembly', 'Đấu dây và lắp ráp'], 'docs/WIRING.md · docs/ASSEMBLY.md · docs/BOM.md');
        }
    },
    {
        name: 'flybot',
        title: ['Daily use in FlyBot', 'Dùng hằng ngày trên FlyBot'],
        poster: 0.35,
        async run(r) {
            const t = r.t;
            const host = 'flybot.agrhub.com';
            await opening(r, 5, ['Daily use in FlyBot', 'Dùng hằng ngày trên FlyBot'], ['Screens from a FlyBot demo with made-up farms and cameras; the pictures are drawings.', 'Màn hình từ bản demo FlyBot với dữ liệu mẫu; hình ảnh là hình vẽ minh họa.']);

            await r.scene({ kind: 'desktop', address: `${host}/cameras` });
            await flybotSession(r);
            await r.goto(`${FLYBOT}/cameras`, 8000);
            r.say(t('Sign in at flybot.agrhub.com and open Cameras. Click “Add Camera”.', 'Đăng nhập flybot.agrhub.com và mở Camera. Bấm “Thêm camera”.'));
            await r.hold(3);
            await r.click({ sel: 'main button', text: t('Add Camera', 'Thêm camera') }, { after: 1.2 });
            r.say(t('Choose CamOS, then type the serial and the 6-character verify code from the camera\'s label or its setup page.', 'Chọn CamOS, rồi nhập số serial và mã xác minh 6 ký tự trên nhãn camera hoặc trên trang cài đặt của camera.'));
            await r.click({ sel: '.el-dialog *', text: 'CamOS', exact: true }, { after: 0.8 });
            await r.click({ sel: '.el-dialog input[type=text]' }, { after: 0.3 });
            await r.type('ESP000000000001', { cps: 16 });
            await r.click({ sel: '.el-dialog input[type=password]' }, { after: 0.3 });
            await r.type('ABC123', { cps: 10 });
            await r.hold(0.8);
            r.say(t('Pick the trap type: a sticky card (the count grows until the card is replaced) or a lure trap.', 'Chọn loại bẫy: bẫy dính (số đếm tăng dần đến khi thay tấm keo) hoặc bẫy dẫn dụ.'));
            await r.move({ sel: '.el-dialog *', text: t('Sticky trap (glue card)', 'Bẫy dính (tấm keo)'), exact: true });
            await r.hold(3.5);
            await r.click({ sel: '.el-dialog__footer button', text: t('Add Camera', 'Thêm camera') }, { after: 0.5 });
            r.say(t('The camera joins your account at once: it registered itself when it went online.', 'Camera vào tài khoản của bạn ngay: nó đã tự đăng ký khi lên mạng.'));
            await r.hold(4.5);

            // The camera page. The demo has no cloud video: the player shows the mock camera's drawn picture
            await r.click({ sel: 'button', text: t('Details', 'Xem chi tiết') }, { after: 0.5 });
            r.address(`${host}/cameras/ESP000000000001`);
            await r.until(`return !!document.querySelector('.live-tab__viewport')`, 20);
            await r.js(LIVE_PICTURE);
            r.say(t('The camera page: the live picture, from anywhere, through the cloud.', 'Trang camera: hình ảnh trực tiếp, xem từ bất cứ đâu qua đám mây.'));
            await r.hold(4.5);
            r.say(t('“Capture now”: the camera takes a photo and uploads it, and FlyBot counts the flies on it.', '“Chụp ngay”: camera chụp và tải ảnh lên, FlyBot đếm số ruồi trên ảnh.'));
            await r.click({ sel: 'button', text: t('Capture now', 'Chụp ngay') }, { after: 4.5 });
            r.say(t('Every photo is in the history: its count against the alert threshold, the alarm state and the species.', 'Mọi ảnh đều có trong lịch sử: số đếm so với ngưỡng cảnh báo, trạng thái cảnh báo và loài côn trùng.'));
            await r.find({ sel: '.history-card .el-table' });
            await r.highlight({ sel: '.history-card' });
            await r.hold(5.5);
            await r.highlight(null);
            r.say(t('Camera settings: the photo interval, picture, motion, power and more. The camera applies them when online, else at its next connection.', 'Cài đặt camera: chu kỳ chụp, hình ảnh, chuyển động, nguồn và nhiều mục khác. Camera áp dụng ngay khi đang kết nối, nếu không thì ở lần kết nối sau.'));
            await r.click({ sel: 'button', text: t('Camera settings', 'Cài đặt camera') }, { after: 5.5 });
            await r.key('Escape', 'Escape', 27);
            await r.hold(0.6);

            // Alert threshold
            await r.goto(`${FLYBOT}/settings?tab=notifications`, 5000);
            r.address(`${host}/settings?tab=notifications`);
            const title = await r.find({ sel: '.settings-section-title', text: t('Alert threshold per camera', 'Ngưỡng cảnh báo theo camera') });
            await r.js(`document.querySelectorAll('.settings-section-title').forEach(e => { if (e.innerText.includes(${JSON.stringify(t('Alert threshold per camera', 'Ngưỡng cảnh báo theo camera'))})) e.scrollIntoView({ block: 'start' }); }); return true;`);
            await r.sleep(500);
            await r.capture();
            r.say(t('Settings → Notifications: an alert threshold per camera. An alert fires when one photo counts at least this many insects.', 'Cài đặt → Thông báo: mỗi camera một ngưỡng cảnh báo. Cảnh báo được gửi khi một ảnh đếm được từ ngần này con trở lên.'));
            const row = await r.js(`return [...document.querySelectorAll('.el-input-number')].findIndex(e => (e.getAttribute('aria-label') || e.querySelector('input')?.getAttribute('aria-label') || '').includes('CamOS 0001'));`);
            if (title && row >= 0) await r.highlight({ sel: '.el-input-number', index: row, up: 1 });
            await r.hold(3.5);
            for (let k = 0; k < 5; k++) await r.click({ sel: '.el-input-number__increase', index: Math.max(0, row) }, { sec: k ? 0.15 : 0.6, after: 0.25 });
            r.say(t('Set it for each trap; the change is saved at once.', 'Đặt ngưỡng cho từng bẫy; thay đổi được lưu ngay.'));
            await r.hold(3);
            await r.highlight(null);

            // Field Map
            await r.goto(`${FLYBOT}/map`, 7000);
            r.address(`${host}/map`);
            r.say(t('Field Map: the CamOS camera puts itself on the map with its own GPS position. The colours compare each trap with its threshold.', 'Bản đồ: camera CamOS tự đặt mình lên bản đồ theo vị trí GPS. Màu sắc so sánh từng bẫy với ngưỡng của nó.'));
            await r.hold(5);
            r.say(t('Click a trap in the list to find it on the map.', 'Bấm vào một bẫy trong danh sách để tìm nó trên bản đồ.'));
            await r.click({ text: 'ESP000000000001' }, { after: 3.5 });

            await closing(r, ['Every day in FlyBot', 'Hằng ngày trên FlyBot'], 'README.md', [
                ['Press “Card replaced” on the camera page when you change the sticky card', 'Bấm “Đã thay tấm bẫy” trên trang camera khi thay tấm keo'],
                ['A camera on battery answers a photo or live request at its next wake', 'Camera chạy pin trả lời yêu cầu chụp hoặc xem trực tiếp ở lần thức kế tiếp'],
                ['Reports, Analytics and the Assistant use the same photos and counts', 'Báo cáo, Phân tích và Trợ lý dùng cùng các ảnh và số đếm này']
            ]);
        }
    }
];

// The FlyBot demo of tools/media (demo-server.js, demo-client.mjs): its manager account, signed in, in the
// cooperative's workspace on a plan with room for one more camera, the page tours already seen
const FLYBOT = process.env.FLYBOT_DEMO_URL || `http://localhost:${Number(process.env.DEMO_CLIENT_PORT) || 3010}`;
async function flybotSession(r) {
    const tokens = JSON.parse(fs.readFileSync(new URL('../demo-tokens.json', import.meta.url), 'utf8'));
    await r.goto(`${FLYBOT}/`, 1500);
    await r.js(`
        localStorage.setItem('token', ${JSON.stringify(tokens.manager.token)});
        localStorage.setItem('user', ${JSON.stringify(JSON.stringify(tokens.manager.user))});
        localStorage.setItem('flybot_language', '${r.lang}');
        localStorage.setItem('smart_trap_theme', 'light');
        localStorage.setItem('flybot_tour_done', '1');
        for (const page of ['dashboard', 'cameras', 'camera', 'reports', 'analytics', 'farms', 'logbook', 'map', 'settings', 'notifications']) localStorage.setItem('flybot_tour_' + page + '_done', '1');
        const h = { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' };
        const { workspaces } = await (await fetch('/api/workspaces', { headers: h })).json();
        const org = workspaces.find(w => w.kind === 'organization');
        await fetch('/api/workspaces/current', { method: 'PUT', headers: h, body: JSON.stringify({ workspaceId: org.id }) });
        await fetch('/api/admin/workspaces/' + org.id + '/plan', { method: 'PUT', headers: { ...h, Authorization: 'Bearer ' + ${JSON.stringify(tokens.admin.token)} }, body: JSON.stringify({ plan: 'pro' }) });
        return true;`);
}
const LIVE_PICTURE = `
    const box = document.querySelector('.live-tab__viewport');
    const style = document.createElement('style');
    style.textContent = '.live-tab__scrim { display: none !important }';
    document.head.appendChild(style);
    const img = document.createElement('img');
    img.src = '${process.env.CAMOS_MOCK || 'http://localhost:8099'}/api/stream?w=1280&h=960';
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000';
    box.appendChild(img);
    await new Promise(r => { img.onload = r; setTimeout(r, 3000); });
    return true;`;
