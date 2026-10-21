// The film's script: scenes in order, their length and the voice-over lines with their subtitles.
// Shared by film.html (pictures and subtitles), voice.mjs (the spoken lines) and render-film.mjs (sound, SRT files).
// at: seconds from the start of the scene. A scene lasts at least as long as its last line plus a beat
// (film.js lengthens it when a recorded voice is longer than planned). Numbers on screen come from
// flybot-aws docs/REPORT.md and the files it names; simulated material is labelled on screen.
export const SCENES = [
    { id: 'intro', dur: 9, lines: [
        { at: 0.8, en: 'Farms count fruit flies on traps. FlyBot photographs the traps and counts the flies, with OpenCV 5 on AWS.',
          vi: 'Nhà vườn đếm ruồi vàng trên bẫy. FlyBot chụp ảnh bẫy và đếm ruồi bằng OpenCV 5 trên AWS.' }] },
    { id: 'problem', dur: 12, lines: [
        { at: 0.3, en: "But a count alone can't tell a bad photo from a catch. Glare, blur or a moved camera give wrong numbers, and the camera never reacts.",
          vi: 'Nhưng chỉ đếm thì không phân biệt được ảnh hỏng với ruồi thật. Lóa, mờ hay camera lệch đều cho số sai, và camera không phản ứng.' }] },
    { id: 'idea', dur: 10, lines: [
        { at: 0.3, en: 'FlyBot Sentinel checks every photo, decides what to do, and proposes it. Nothing reaches a camera until a person confirms.',
          vi: 'FlyBot Sentinel kiểm tra từng ảnh, quyết định cần làm gì và đề xuất. Không lệnh nào tới camera khi chưa có người xác nhận.' }] },
    { id: 'bom', dur: 12, lines: [
        { at: 0.3, en: 'This is our open trap camera: an ESP32-S3 board with a five-megapixel camera, a 4G modem, GPS, an 18650 cell and a small solar panel.',
          vi: 'Đây là camera bẫy mã nguồn mở: board ESP32-S3 với camera 5 megapixel, modem 4G, GPS, pin 18650 và tấm pin mặt trời nhỏ.' }] },
    { id: 'wiring', dur: 25, lines: [
        { at: 0.3, en: 'First the cell and its charger. A boost converter makes five volts for the board.',
          vi: 'Đầu tiên là pin và mạch sạc. Mạch tăng áp tạo 5 V cho board.' },
        { at: 6.6, en: 'The 4G modem runs straight from the cell, and talks to the board on two pins.',
          vi: 'Module 4G lấy điện thẳng từ pin và nói chuyện với board qua hai chân.' },
        { at: 12.4, en: 'The GPS takes three point three volts and sends its position on one wire.',
          vi: 'GPS lấy 3,3 V và gửi vị trí qua một dây.' },
        { at: 18.0, en: 'Two resistors let the camera measure its own battery.',
          vi: 'Hai điện trở giúp camera tự đo pin của mình.' }] },
    { id: 'board', dur: 9, lines: [
        { at: 0.3, en: 'This is the real board. It goes into the lid of a solar trap housing.',
          vi: 'Đây là board thật. Nó được lắp vào nắp của vỏ bẫy năng lượng mặt trời.' }] },
    { id: 'field', dur: 30, footage: true, lines: [
        { at: 0.8, en: 'In the orchard, the trap hangs at fruit height. The camera photographs the inside of the trap on a schedule and sends each photo to AWS over 4G.',
          vi: 'Ngoài vườn, bẫy được treo ngang tầm trái. Camera chụp bên trong bẫy theo lịch và gửi từng ảnh lên AWS qua 4G.' }] },
    { id: 'guest', dur: 12, rec: true, lines: [
        { at: 0.3, en: 'Anyone can try FlyBot: one click on Guest access opens a read-only demo for two hours, with no sign-up.',
          vi: 'Ai cũng dùng thử được FlyBot: một cú nhấp vào Truy cập khách mở bản demo chỉ xem trong hai giờ, không cần đăng ký.' }] },
    { id: 'dashboard', dur: 15, rec: true, lines: [
        { at: 0.3, en: 'The dashboard shows two real orchard traps, and a clearly labelled simulated network of 114 traps on 47 farms, to show FlyBot at scale.',
          vi: 'Bảng điều khiển có hai bẫy thật ngoài vườn, và một mạng mô phỏng được ghi rõ gồm 114 bẫy trên 47 vườn, để thấy FlyBot ở quy mô lớn.' }] },
    { id: 'cameras', dur: 11, rec: true, lines: [
        { at: 0.3, en: 'The camera list searches and filters real and simulated traps, sticky cards or lures, in two to five columns.',
          vi: 'Danh sách camera tìm kiếm và lọc bẫy thật hay mô phỏng, bẫy dính hay bẫy dẫn dụ, hiển thị từ hai đến năm cột.' }] },
    { id: 'sticky', dur: 13, rec: true, lines: [
        { at: 0.3, en: 'Every photo, real or synthetic, goes through the same OpenCV 5 Lambda. On a simulated card, the count sits next to the number of flies we drew.',
          vi: 'Mọi ảnh, thật hay tổng hợp, đều qua cùng một Lambda OpenCV 5. Với tấm bẫy mô phỏng, số đếm nằm cạnh số ruồi chúng tôi đã vẽ.' }] },
    { id: 'trace', dur: 19, rec: true, lines: [
        { at: 0.3, en: 'For each photo, the Sentinel console shows what OpenCV saw, which rule the agent applied and why, and every step it took.',
          vi: 'Với mỗi ảnh, bảng Sentinel cho thấy OpenCV đã thấy gì, tác tử áp dụng quy tắc nào và vì sao, và từng bước nó đã làm.' },
        { at: 9.0, en: 'Here the count surged, but no neighbour trap confirmed it, so the agent proposes a notification.',
          vi: 'Ở đây số ruồi tăng vọt nhưng không bẫy lân cận nào xác nhận, nên tác tử đề xuất một thông báo.' }] },
    { id: 'approve', dur: 12, rec: true, lines: [
        { at: 0.3, en: 'Proposals wait for a person. Only after the owner confirms, in the chat, on Telegram or here, does a camera act, and its new photo starts the loop again.',
          vi: 'Đề xuất chờ con người. Chỉ khi chủ vườn xác nhận, trong khung chat, trên Telegram hay tại đây, camera mới hành động, và ảnh mới lại bắt đầu vòng lặp.' }] },
    { id: 'assistant', dur: 12, rec: true, lines: [
        { at: 0.3, en: 'Growers can ask the assistant in plain words. It answers from the counts FlyBot measured.',
          vi: 'Nhà vườn hỏi trợ lý bằng lời thường. Trợ lý trả lời từ số liệu FlyBot đã đo.' }] },
    { id: 'esp32', dur: 22, rec: true, owner: true, lines: [
        { at: 0.3, en: 'Our ESP32 camera streams live through Kinesis Video Streams.',
          vi: 'Camera ESP32 của chúng tôi phát trực tiếp qua Kinesis Video Streams.' },
        { at: 6.5, en: 'It sends its log to the console, and the camera fleet updates over the air through AWS IoT Core, on alpha, beta and stable channels.',
          vi: 'Camera gửi nhật ký về bảng điều khiển, và cả đội camera cập nhật firmware từ xa qua AWS IoT Core, theo các kênh alpha, beta và stable.' }] },
    { id: 'mapreports', dur: 9, rec: true, lines: [
        { at: 0.3, en: 'Traps sit on a field map with a heat map, and reports gather the numbers for each farm.',
          vi: 'Bẫy nằm trên bản đồ vườn có bản đồ nhiệt, và báo cáo tổng hợp số liệu cho từng vườn.' }] },
    { id: 'architecture', dur: 14, lines: [
        { at: 0.3, en: 'Two camera families, one vision Lambda, one agent, and a person on every action. It all runs in one SAM stack in Sydney, deployed with one command.',
          vi: 'Hai dòng camera, một Lambda thị giác, một tác tử, và con người duyệt mọi hành động. Tất cả chạy trong một stack SAM ở Sydney, triển khai bằng một lệnh.' }] },
    { id: 'opencv', dur: 15, lines: [
        { at: 0.3, en: "YOLO26n runs on OpenCV 5's new DNN engine, with a test mAP at fifty of 0.953. On synthetic sticky cards, tiling the frame raised recall from 0.07 to 0.82.",
          vi: 'YOLO26n chạy trên engine DNN mới của OpenCV 5, mAP@50 trên tập kiểm tra là 0,953. Trên bẫy dính tổng hợp, chia ô khung hình nâng độ nhạy từ 0,07 lên 0,82.' }] },
    { id: 'results', dur: 12, lines: [
        { at: 0.3, en: 'Failure injection passed 38 of 38 cases with zero false actuations. The demo costs about 17 dollars a month, and about five cents per thousand photos.',
          vi: 'Thử lỗi có chủ đích đạt 38/38 trường hợp, không có lệnh sai nào. Bản demo tốn khoảng 17 USD mỗi tháng, và khoảng 5 xu cho mỗi nghìn ảnh.' }] },
    { id: 'end', dur: 16, lines: [
        { at: 0.3, en: 'Our agronomy advisor judged 43 of 49 agent decisions correct. Our limits: no human count labels yet, sticky cards measured on synthetic photos only, and no autonomous spraying. A person always decides. Try it with Guest access.',
          vi: 'Chuyên gia nông học đánh giá 43 trên 49 quyết định của tác tử là đúng. Giới hạn: chưa có nhãn đếm do người gán, bẫy dính mới đo trên ảnh tổng hợp, và không phun thuốc tự động. Con người luôn quyết định. Hãy thử với Truy cập khách.' }] }
];

// The longest film the competition accepts
export const MAX_SECONDS = 300;
