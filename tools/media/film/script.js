// The film's script: scenes in order, their length and the voice-over lines with their subtitles.
// Shared by film.html (pictures and subtitles), voice.mjs (the spoken lines) and render-film.mjs (sound, SRT files).
// at: seconds from the start of the scene. A scene lasts at least as long as its last line plus a beat
// (film.js lengthens it when a recorded voice is longer than planned). Numbers on screen come from
// flybot-aws docs/REPORT.md and the files it names; simulated material is labelled on screen.
export const SCENES = [
    // Why it matters: what fruit flies cost (sources on screen), then the farmer's problem, then FlyBot
    { id: 'harm', dur: 19, lines: [
        { at: 0.5, en: 'Fruit flies are the most damaging pest of fruit in the world. They lay their eggs inside ripening fruit, and the maggots ruin it from within.',
          vi: 'Ruồi đục quả là loài gây hại cây ăn quả nặng nhất thế giới. Chúng đẻ trứng vào trái đang chín, và giòi phá hỏng trái từ bên trong.' },
        { at: 9.6, en: 'In Africa alone they cost two billion dollars a year. Mango orchards lose ten to forty percent of the harvest, and infested fruit is turned away at export.',
          vi: 'Riêng ở châu Phi, thiệt hại ước 2 tỷ USD mỗi năm. Vườn xoài mất 10 đến 40% sản lượng, và trái nhiễm ruồi bị từ chối khi xuất khẩu.' }] },
    { id: 'farmers', dur: 11, lines: [
        { at: 0.3, en: 'To protect the crop, farmers walk to every trap and count the flies by eye. It is slow, the numbers come late, and they spray too late or too much.',
          vi: 'Để giữ mùa màng, nhà vườn đi tới từng bẫy và đếm ruồi bằng mắt. Việc này chậm, số liệu đến trễ, và họ phun thuốc quá muộn hoặc quá nhiều.' }] },
    { id: 'intro', dur: 10, lines: [
        { at: 0.6, en: 'FlyBot does that work for them: a camera on each trap takes the photos, and OpenCV 5 on AWS counts the flies and warns the farmer in time.',
          vi: 'FlyBot làm việc đó thay họ: camera trên mỗi bẫy chụp ảnh, OpenCV 5 trên AWS đếm ruồi và báo cho nhà vườn kịp lúc.' }] },
    // How it works: one photo from the trap to the report (replaces the AWS diagram)
    { id: 'pipeline', dur: 29.4, lines: [
        { at: 0.3, en: "Here is how it works. A fly comes to the lure, and the trap's camera takes a photo.",
          vi: 'FlyBot hoạt động thế này. Ruồi bị mồi dụ vào bẫy, và camera trong bẫy chụp ảnh.' },
        { at: 5.6, en: 'Over 4G it reaches FlyBot on EC2, which keeps it in Amazon S3 and MongoDB.',
          vi: 'Qua mạng 4G, ảnh tới FlyBot trên EC2 và được lưu vào Amazon S3 và MongoDB.' },
        { at: 13.0, en: 'AWS Lambda runs OpenCV 5: YOLO26n counts the flies and checks the photo. Then the Sentinel agent proposes what to do.',
          vi: 'AWS Lambda chạy OpenCV 5: YOLO26n đếm ruồi và kiểm tra ảnh. Sau đó tác tử Sentinel đề xuất việc cần làm.' },
        { at: 23.5, en: "The count goes into the farm's reports, and any action waits for a person to confirm it.",
          vi: 'Số liệu vào báo cáo của vườn, và mọi hành động đều chờ con người xác nhận.' }] },
    { id: 'bom', dur: 12, lines: [
        { at: 0.3, en: 'This is our open trap camera: an ESP32-S3 board with a five-megapixel camera, a 4G modem, GPS, a flat lithium-polymer cell and a small solar panel.',
          vi: 'Đây là camera bẫy mã nguồn mở: board ESP32-S3 với camera 5 megapixel, modem 4G, GPS, pin lithium-polymer dạng dẹt và tấm pin mặt trời nhỏ.' }] },
    { id: 'wiring', dur: 22, lines: [
        { at: 0.3, en: 'First the cell and its charger. A boost converter makes five volts for the board.',
          vi: 'Đầu tiên là pin và mạch sạc. Mạch tăng áp tạo 5 V cho board.' },
        { at: 6.6, en: 'The 4G modem runs from the cell through a switch, and talks to the board on two pins.',
          vi: 'Module 4G lấy điện từ pin qua một công tắc và nói chuyện với board qua hai chân.' },
        { at: 12.4, en: 'The GPS also runs from the cell, and talks to the board on two wires.',
          vi: 'GPS cũng lấy điện từ pin và nói chuyện với board qua hai dây.' },
        { at: 18.0, en: 'Two resistors let the camera measure its own battery.',
          vi: 'Hai điện trở giúp camera tự đo pin của mình.' }] },
    { id: 'board', dur: 7, lines: [
        { at: 0.3, en: 'This is the real board. It goes into the lid of a solar trap housing.',
          vi: 'Đây là board thật. Nó được lắp vào nắp của vỏ bẫy năng lượng mặt trời.' }] },
    { id: 'field', dur: 22, footage: true, lines: [
        { at: 0.8, en: 'In the orchard, the trap hangs at fruit height. The camera photographs the inside of the trap on a schedule and sends each photo to AWS over 4G.',
          vi: 'Ngoài vườn, bẫy được treo ngang tầm trái. Camera chụp bên trong bẫy theo lịch và gửi từng ảnh lên AWS qua 4G.' }] },
    { id: 'guest', dur: 10, rec: true, lines: [
        { at: 0.3, en: 'Anyone can try FlyBot: one click on Guest access opens a read-only demo for two hours, with no sign-up.',
          vi: 'Ai cũng dùng thử được FlyBot: một cú nhấp vào Truy cập khách mở bản demo chỉ xem trong hai giờ, không cần đăng ký.' }] },
    { id: 'dashboard', dur: 12.5, rec: true, lines: [
        { at: 0.3, en: 'The dashboard shows two real orchard traps, and a clearly labelled simulated network of 114 traps on 47 farms, to show FlyBot at scale.',
          vi: 'Bảng điều khiển có hai bẫy thật ngoài vườn, và một mạng mô phỏng được ghi rõ gồm 114 bẫy trên 47 vườn, để thấy FlyBot ở quy mô lớn.' }] },
    { id: 'cameras', dur: 9.5, rec: true, lines: [
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
    { id: 'assistant', dur: 10, rec: true, lines: [
        { at: 0.3, en: 'Growers can ask the assistant in plain words. It answers from the counts FlyBot measured.',
          vi: 'Nhà vườn hỏi trợ lý bằng lời thường. Trợ lý trả lời từ số liệu FlyBot đã đo.' }] },
    { id: 'esp32', dur: 20, rec: true, owner: true, lines: [
        { at: 0.3, en: 'Our ESP32 camera streams live through Kinesis Video Streams.',
          vi: 'Camera ESP32 của chúng tôi phát trực tiếp qua Kinesis Video Streams.' },
        { at: 6.5, en: 'It sends its log to the console, and the camera fleet updates over the air through AWS IoT Core, on alpha, beta and stable channels.',
          vi: 'Camera gửi nhật ký về bảng điều khiển, và cả đội camera cập nhật firmware từ xa qua AWS IoT Core, theo các kênh alpha, beta và stable.' }] },
    { id: 'mapreports', dur: 9, rec: true, lines: [
        { at: 0.3, en: 'Traps sit on a field map with a heat map, and reports gather the numbers for each farm.',
          vi: 'Bẫy nằm trên bản đồ vườn có bản đồ nhiệt, và báo cáo tổng hợp số liệu cho từng vườn.' }] },
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
