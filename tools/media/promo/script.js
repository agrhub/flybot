// The Vietnamese introduction film for growers, cooperatives and agricultural companies: its scenes in order, their
// length, what each shows and the subtitle lines (said by a voice too when media/promo-voice holds them).
// Shared by promo.html (pictures and subtitles) and render-promo.mjs (sound, SRT file).
// Nothing is recorded for it: every picture is material that already exists.
//   tvc:     a part of the Vietnamese commercial, client/public/media/flybot-tvc-vi.mp4 (from, to in its seconds)
//   footage: the orchard clip of the demo film, film/media/footage/real-trap.mp4 (segments in its seconds; its first
//            20 s pass the people check, a face is flagged at 28 s)
//   app:     guide screenshots, client/public/manual/vi/<name>.webp (1440 x 900), or another picture by path:
//            /app/... client/public or /media/... film/media. zoom: [scene second, centre x, centre y, scale] in
//            picture pixels, eased; w, h for a picture of another size.
//   photos:  photos of the trap camera on cards (x, y, w, h), each shown from its second at with a slow push in
//   end:     the call to action
// at: seconds from the start of the scene. A scene lasts at least as long as its last line plus a beat.
export const SCENES = [
    // 0-28.8 s of the commercial: the pain, then FlyBot, then how it works (music bars line up with it)
    { id: 'open', kind: 'tvc', from: 0, to: 28.8, lines: [
        { at: 0.6, vi: 'Ruồi vàng đục trái là nỗi lo của mọi nhà vườn: chúng đẻ trứng vào trái đang chín, giòi phá trái từ bên trong.' },
        { at: 7.4, vi: 'Đi kiểm từng bẫy, đếm bằng mắt thì tốn công, số liệu đến trễ, nên thường phun thuốc quá muộn hoặc quá nhiều.' },
        { at: 14.9, vi: 'FlyBot làm việc đó thay bạn.' },
        { at: 19.6, vi: 'Camera chụp bên trong bẫy, AI khoanh và đếm từng con ruồi, rồi báo ngay về điện thoại của bạn.' }] },
    { id: 'trap', kind: 'photos', dur: 15,
        kicker: 'Camera bẫy FlyBot', title: 'Chạy bằng năng lượng mặt trời, gửi ảnh qua 4G',
        points: ['Camera 5 MP chụp bên trong bẫy theo lịch', 'Modem 4G và GPS: không cần Wi-Fi', 'Pin sạc từ tấm pin mặt trời nhỏ, không cần điện lưới'],
        photos: [
            { src: '/media/photos/IMG_20261024_144403_702.jpg', caption: 'Bẫy hoàn chỉnh: camera nhìn xuống thân bẫy', at: 0.6, x: 880, y: 120, w: 480, h: 640, from: [0.5, 0.5, 1.0], to: [0.5, 0.45, 1.12] },
            { src: '/media/photos/IMG_20261024_144519_297.jpg', caption: 'Nắp bẫy: tấm pin mặt trời sạc pin', at: 5.5, x: 1400, y: 190, w: 440, h: 586, from: [0.5, 0.5, 1.0], to: [0.5, 0.5, 1.1] }
        ],
        lines: [
            { at: 0.4, vi: 'Camera bẫy của AgrHub chạy bằng năng lượng mặt trời và gửi ảnh qua mạng 4G.' },
            { at: 7.4, vi: 'Không cần Wi-Fi, không cần kéo điện: treo ở góc vườn nào cũng được.' }] },
    { id: 'field', kind: 'footage', dur: 11, segments: [[0, 19]],
        kicker: 'Ngoài vườn', title: 'Treo ngang tầm trái, tự chụp mỗi ngày',
        lines: [{ at: 0.5, vi: 'Ngoài vườn, bẫy treo ngang tầm trái. Camera tự chụp theo lịch và gửi từng ảnh về FlyBot.' }] },
    { id: 'count', kind: 'app', dur: 10,
        kicker: 'AI đếm ruồi', title: 'Mỗi ảnh được đếm tự động',
        points: ['AI khoanh từng con ruồi trên ảnh', 'Số đếm theo từng bẫy, từng loài', 'Kỹ thuật viên xác nhận hoặc sửa số đếm'],
        shots: [
            { src: 'detection', dur: 5, zoom: [[0, 720, 450, 1], [5, 720, 420, 1.12]] },
            { src: 'dashboard-cameras', zoom: [[0, 720, 450, 1], [5, 720, 450, 1.08]] }
        ],
        lines: [{ at: 0.4, vi: 'Mỗi ảnh về tới FlyBot đều được AI đếm: từng con ruồi được khoanh lại, và bạn có thể xác nhận hoặc sửa số đếm.' }] },
    { id: 'dashboard', kind: 'app', dur: 10,
        kicker: 'Tổng quan', title: 'Biết ngay lô nào cần xử lý',
        points: ['Bẫy nào vượt ngưỡng hôm nay', 'Việc nên làm cho từng lô', 'Số ruồi vào bẫy mỗi ngày'],
        shots: [
            { src: 'dashboard', dur: 5.5, zoom: [[0, 720, 450, 1], [5.5, 620, 380, 1.15]] },
            { src: 'catch-chart', zoom: [[0, 720, 450, 1], [4.5, 720, 450, 1.08]] }
        ],
        lines: [{ at: 0.4, vi: 'Trang Tổng quan cho biết hôm nay bẫy nào vượt ngưỡng, và việc nên làm cho từng lô.' }] },
    { id: 'map', kind: 'app', dur: 9,
        kicker: 'Bản đồ', title: 'Mật độ ruồi trên bản đồ',
        points: ['Bẫy theo lô, màu theo mức nguy cơ', 'Thấy ngay điểm nóng để xử lý đúng chỗ'],
        shots: [
            { src: 'map', dur: 4.5, zoom: [[0, 720, 450, 1], [4.5, 720, 450, 1.1]] },
            { src: 'farm-map', zoom: [[0, 720, 450, 1], [4.5, 720, 450, 1.1]] }
        ],
        lines: [{ at: 0.4, vi: 'Mật độ ruồi hiện trên bản đồ vườn, tô màu theo mức nguy cơ, để xử lý đúng chỗ, đúng lúc.' }] },
    { id: 'alerts', kind: 'app', dur: 10,
        kicker: 'Cảnh báo', title: 'Báo ngay khi cần',
        points: ['Vượt ngưỡng, tăng đột biến, mất kết nối', 'Trên ứng dụng, qua Telegram và email', 'Báo cáo PDF gửi theo lịch'],
        chips: ['Ứng dụng', 'Telegram', 'Email'],
        shots: [
            { src: 'notifications', dur: 5, zoom: [[0, 720, 450, 1], [5, 720, 400, 1.1]] },
            { src: 'report-schedule', zoom: [[0, 720, 450, 1], [5, 720, 450, 1.08]] }
        ],
        lines: [{ at: 0.4, vi: 'Khi số ruồi vượt ngưỡng, tăng đột biến hay camera mất kết nối, FlyBot báo ngay trên ứng dụng, qua Telegram và email.' }] },
    { id: 'assistant', kind: 'app', dur: 10,
        kicker: 'Trợ lý FlyBot', title: 'Hỏi bằng lời thường',
        points: ['Trả lời từ số liệu thật của vườn', 'Kèm ảnh và biểu đồ', 'Ghi nhật ký phun thuốc giúp bạn'],
        shots: [
            { src: 'assistant', dur: 5, zoom: [[0, 720, 450, 1], [5, 900, 450, 1.12]] },
            { src: 'assistant-chart', zoom: [[0, 720, 450, 1], [5, 900, 450, 1.1]] }
        ],
        lines: [{ at: 0.4, vi: 'Cứ hỏi trợ lý bằng lời thường: trợ lý trả lời từ số liệu thật của vườn, kèm ảnh và biểu đồ.' }] },
    { id: 'live', kind: 'app', dur: 9,
        kicker: 'Xem trực tiếp', title: 'Nhìn vào bẫy bất cứ lúc nào',
        points: ['Xem trực tiếp camera bẫy', 'Xem lại theo dòng thời gian'],
        shots: [
            { src: 'camera-detail', dur: 4.5, zoom: [[0, 720, 450, 1], [4.5, 850, 330, 1.15]] },
            { src: 'playback', zoom: [[0, 720, 450, 1], [4.5, 720, 450, 1.08]] }
        ],
        lines: [{ at: 0.4, vi: 'Muốn tận mắt kiểm tra? Mở xem trực tiếp camera bẫy, hoặc xem lại theo dòng thời gian.' }] },
    { id: 'reports', kind: 'app', dur: 10,
        kicker: 'Báo cáo', title: 'Báo cáo và sổ VietGAP tự động',
        points: ['Báo cáo từng vườn, xuất PDF và Excel', 'Nhật ký phun thuốc kèm hiệu quả đo được', 'Sổ VietGAP tự gửi ngày 1 hằng tháng'],
        shots: [
            { src: 'reports', dur: 5, zoom: [[0, 720, 450, 1], [5, 720, 450, 1.1]] },
            { src: 'logbook', zoom: [[0, 720, 450, 1], [5, 720, 450, 1.08]] }
        ],
        lines: [{ at: 0.4, vi: 'Báo cáo tự tổng hợp số liệu từng vườn. Nhật ký phun thuốc và sổ VietGAP được gửi tự động mỗi tháng.' }] },
    // 45.6-52.8 s of the commercial: cooperatives
    { id: 'coop', kind: 'tvc', from: 45.6, to: 52.8, lines: [
        { at: 0.5, vi: 'Với hợp tác xã và doanh nghiệp, mọi hộ thành viên, mọi vườn đều nằm trên một màn hình.' }] },
    { id: 'end', kind: 'end', dur: 11,
        head: ['Phát hiện ruồi vàng sớm.', 'Quyết định có căn cứ.'], url: 'flybot.agrhub.com',
        small: 'Dùng thử ngay trên web và điện thoại · FlyBot do AgrHub phát triển',
        lines: [{ at: 0.6, vi: 'FlyBot: phát hiện ruồi vàng sớm, quyết định có căn cứ. Dùng thử ngay tại flybot.agrhub.com.' }] }
];
