# Thanh toán trực tuyến: thiết lập PayOS và Stripe

[English](payments.md)

Tài liệu này dành cho người vận hành FlyBot. Nội dung gồm: tạo tài khoản và khóa PayOS, Stripe; đặt khóa ở đâu; kiểm tra bằng một lần mua thử; giữ khóa an toàn. Cách mã thanh toán hoạt động nằm trong [API.md, mục "Payments"](../API.md#payments).

- **PayOS**: chuyển khoản VietQR, tiền VND. Mỗi kỳ thanh toán riêng, FlyBot nhắc chủ không gian làm việc trước khi gói hết hạn.
- **Stripe**: thẻ, tiền USD hoặc VND. Gói tự động gia hạn.

Bạn có thể bật một hoặc cả hai cổng. Cổng nào đã có khóa thì hiện trong ứng dụng.

Đã đối chiếu với tài liệu chính thức của hai nhà cung cấp ngày 17/10/2026. Giao diện quản trị có thể thay đổi; chỗ nào chưa xác minh được tên menu, tài liệu ghi rõ.

## Mục lục

1. [Trước khi bắt đầu](#1-trước-khi-bắt-đầu)
2. [PayOS](#2-payos)
3. [Stripe](#3-stripe)
4. [Đặt khóa ở đâu](#4-đặt-khóa-ở-đâu)
5. [Kiểm tra bằng một lần mua thử](#5-kiểm-tra-bằng-một-lần-mua-thử)
6. [Đổi khóa](#6-đổi-khóa)
7. [Lưu ý bảo mật](#7-lưu-ý-bảo-mật)
8. [Các biến cấu hình FlyBot đọc](#8-các-biến-cấu-hình-flybot-đọc)

## 1. Trước khi bắt đầu

- FlyBot phải chạy qua **HTTPS** ở địa chỉ công khai, ví dụ `https://flybot.agrhub.com`. Đặt `APP_BASE_URL` bằng địa chỉ đó. Cổng thanh toán đưa người mua quay về `<APP_BASE_URL>/billing/return` và gửi webhook đến:

  | Cổng | Webhook URL |
  |---|---|
  | PayOS | `https://flybot.agrhub.com/api/payments/webhooks/payos` |
  | Stripe | `https://flybot.agrhub.com/api/payments/webhooks/stripe` |

- Đặt giá trước. Đăng nhập bằng tài khoản quản trị, mở **Cài đặt → Các gói** (nhóm Quản trị). Với mỗi gói trả phí, nhập giá **Mỗi tháng**, **Mỗi năm**, **Thêm camera mỗi tháng** và **Thêm camera mỗi năm**, bằng VND (cho PayOS và Stripe) và/hoặc USD (cho Stripe). Gói chưa có giá thì không bán trực tuyến và vẫn hiện "Liên hệ".
- Với `APP_MODE=b2b`, thanh toán trực tuyến luôn tắt; hóa đơn làm thủ công.

## 2. PayOS

PayOS ([payos.vn](https://payos.vn)) tạo link thanh toán VietQR, người mua trả bằng chuyển khoản qua Napas 24/7. Trang quản trị là [my.payos.vn](https://my.payos.vn).

### 2.1 Tạo tài khoản

1. Vào [my.payos.vn/login](https://my.payos.vn/login), chọn **Đăng ký**, điền thông tin rồi nhấn **Tạo tài khoản**.
2. Mở email PayOS gửi đến và nhấn **Xác thực** để kích hoạt tài khoản.

Nguồn: [Tạo tài khoản payOS](https://payos.vn/docs/huong-dan-su-dung/tao-tai-khoan-payos).

### 2.2 Xác thực tổ chức

PayOS chỉ nhận tiền vào tài khoản ngân hàng đứng tên đúng tổ chức đã xác thực, nên cần xác thực trước.

- **Doanh nghiệp (có pháp nhân)**: chọn **Doanh nghiệp (có pháp nhân)**, nhập mã số thuế hoặc số giấy phép kinh doanh (MST/GPKD) rồi nhấn **Kiểm tra**. Thành công thì tên doanh nghiệp tự điền; nhấn **Tiếp tục**.
- **Cá nhân hoặc hộ kinh doanh**: chọn **Tài khoản cá nhân/Hộ kinh doanh**, nhập số CCCD/CMND và họ tên, nhấn **Kiểm tra**.
- Cả hai trường hợp đều kết thúc bằng một **khoản chuyển khoản nhỏ theo mã QR**. Chuyển từ tài khoản ngân hàng đứng tên tổ chức (không dùng ví điện tử), đúng nội dung và số tiền hiển thị. PayOS sẽ tự xác thực.
- Nếu PayOS không tìm thấy MST hoặc CCCD, gửi email tới **verify@payos.vn** với tiêu đề `[payOS] Xác thực thủ công + <email dùng payOS>`. Đính kèm ảnh hai mặt CCCD; doanh nghiệp đính kèm thêm giấy phép kinh doanh có mộc đỏ.

Nguồn: [Xác thực tổ chức](https://payos.vn/docs/huong-dan-su-dung/xac-thuc-to-chuc).

### 2.3 Liên kết tài khoản ngân hàng

Yêu cầu với tài khoản ngân hàng:

- Tên chủ tài khoản phải trùng với tổ chức đã xác thực.
- Ngân hàng phải nằm trong danh sách PayOS liên kết được. Lúc kiểm tra, hướng dẫn PayOS có trang cho **ACB, BIDV, KienlongBank, MB, OCB, VPBank, MSB và Vietcombank**. Hãy xem [danh sách hiện tại](https://payos.vn/docs/huong-dan-su-dung/kenh-thu/ket-noi-tai-khoan/ngan-hang-acb) trước khi làm.

Để liên kết, thêm ngân hàng trong PayOS. Nhập số tài khoản và tên chủ tài khoản rồi nhấn **Kiểm tra**. Nhập số điện thoại, đồng ý điều khoản và nhấn **Liên kết**. Sau đó nhập mã OTP ngân hàng gửi qua SMS hoặc ứng dụng.

### 2.4 Tạo kênh thanh toán và lấy khóa

1. Trong menu **Kênh thanh toán**, nhấn **Tạo kênh thanh toán**.
2. Nhập tên kênh (ví dụ `FlyBot`), tải lên logo rồi nhấn **Tiếp tục**.
3. Chọn tài khoản ngân hàng cho kênh và nhấn **Tạo kênh thanh toán và tích hợp**.
4. Màn hình báo thành công hiển thị ba khóa. Chép ngay từng khóa vào trình quản lý mật khẩu:

   | PayOS hiển thị | Biến của FlyBot |
   |---|---|
   | Client ID | `PAYOS_CLIENT_ID` |
   | API Key | `PAYOS_API_KEY` |
   | Checksum Key | `PAYOS_CHECKSUM_KEY` |

5. Nhấn **Hoàn tất**.

Nguồn: [Tạo kênh thanh toán](https://payos.vn/docs/huong-dan-su-dung/kenh-thu/tao-kenh-thanh-toan).

Các khóa này thuộc về kênh này. Chưa xác minh được: có xem lại các khóa sau này từ trang của kênh được hay không. Hãy coi màn hình này là lần duy nhất bạn thấy chúng.

### 2.5 Đặt webhook URL

FlyBot phải đang chạy với đủ ba khóa (mục 4), vì PayOS kiểm tra URL ngay khi bạn lưu.

1. Trong **Kênh thanh toán**, mở kênh FlyBot và nhập webhook URL `https://flybot.agrhub.com/api/payments/webhooks/payos`. Hướng dẫn PayOS ghi: "ấn chọn Kênh thanh toán để thêm webhookURL". Chưa xác minh được tên chính xác của ô nhập.
2. Khi lưu URL, PayOS gửi một **giao dịch mẫu** đến đó và chờ phản hồi `2xx`. FlyBot kiểm tra chữ ký của giao dịch mẫu bằng Checksum Key và trả `200`; không có đơn nào khớp nên không có gì thay đổi.

Thay cho trang quản trị, có thể đặt URL qua API của PayOS (`POST https://api-merchant.payos.vn/confirm-webhook`); API này kiểm tra theo cùng cách:

```bash
curl -X POST https://api-merchant.payos.vn/confirm-webhook \
  -H "x-client-id: $PAYOS_CLIENT_ID" -H "x-api-key: $PAYOS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl":"https://flybot.agrhub.com/api/payments/webhooks/payos"}'
```

PayOS trả `200` khi URL dùng được và `400` khi bị từ chối. Nếu bị từ chối, kiểm tra FlyBot đang chạy với `PAYMENTS_ENABLED=true` và đúng `PAYOS_CHECKSUM_KEY`. Nguồn: [Tài liệu API](https://payos.vn/docs/api/).

### 2.6 Thử nghiệm với PayOS

**PayOS không có sandbox hay môi trường thử nghiệm.** Tài liệu PayOS viết "payOS không cung cấp môi trường test (sandbox/staging) riêng biệt", và mọi giao dịch chạy trên API thật. Nguồn: [Môi trường test](https://payos.vn/docs/moi-truong-test).

PayOS đề xuất thử bằng tiền thật:

- Trong lúc thử, đặt giá VND nhỏ cho gói (ví dụ 10.000 đ) và chuyển khoản thật một lần vào tài khoản của chính bạn.
- Dùng một kênh thanh toán (và bộ khóa) riêng cho việc thử, để kênh chính luôn sạch. Thử xong thì đặt lại giá thật.
- Trên máy không có địa chỉ công khai, PayOS không gửi webhook đến được. Trang quay về của FlyBot tự hỏi PayOS trạng thái thanh toán qua một câu trả lời có chữ ký. Vì vậy khoản thanh toán thử vẫn hoàn tất khi bạn quay lại trang đó. Cũng có thể dùng một đường hầm (ví dụ ngrok) để nhận webhook.

PayOS hiển thị cho người mua một nội dung chuyển khoản ngắn. FlyBot dùng tối đa 9 ký tự, ví dụ `FBPROM` cho gói PRO theo tháng, vì PayOS giới hạn 9 ký tự với tài khoản ngân hàng không liên kết qua PayOS.

## 3. Stripe

Stripe ([dashboard.stripe.com](https://dashboard.stripe.com)) nhận thanh toán bằng thẻ và gia hạn gói mỗi tháng hoặc mỗi năm. FlyBot dùng trang Checkout do Stripe lưu trữ, nên thông tin thẻ không bao giờ đi qua FlyBot.

### 3.1 Sandbox (thử nghiệm) và live mode

Stripe tách riêng thử nghiệm và thật. Mỗi **sandbox** có bộ khóa riêng: secret key `sk_test_…`, restricted key `rk_test_…` và publishable key `pk_test_…`. Thanh toán trong sandbox là giả lập và chỉ thẻ thử nghiệm dùng được. Khóa **live mode** bắt đầu bằng `sk_live_`, `rk_live_` và `pk_live_`, và chuyển tiền thật. Dữ liệu của hai bên không dùng chung. Dùng sandbox cho đến khi chạy thật. Nguồn: [API keys](https://docs.stripe.com/keys).

FlyBot từ chối khóa live (`sk_live_…` hoặc `rk_live_…`) nếu chưa đặt `PAYMENTS_ALLOW_LIVE=true`, để máy thử nghiệm không lỡ dùng khóa thật.

### 3.2 Khóa API

1. Mở trang [API keys](https://dashboard.stripe.com/apikeys) trong một sandbox. Trang hiển thị tài khoản hoặc sandbox bạn đang xem.
2. Nên dùng: nhấn **Create restricted key** và đặt tên, ví dụ `flybot-billing`. Chỉ đặt **Write** cho hai quyền sau, các quyền khác để **None**:
   - **Checkout Sessions: Write** (FlyBot tạo trang thanh toán gói)
   - **Subscriptions: Write** (FlyBot dừng gia hạn khi chủ không gian làm việc yêu cầu)

   Nhấn **Create key**, hoàn tất bước xác minh rồi chép giá trị `rk_test_…`. Stripe không hiển thị lại khóa bạn tự tạo.
3. Hoặc dùng **secret key** (`sk_test_…`) trong mục **Standard keys**. Khóa này có toàn quyền với tài khoản, vì vậy Stripe khuyên dùng restricted key.

Chưa xác minh được: Stripe có cần thêm quyền cho phần giá FlyBot gửi kèm mỗi lần thanh toán (`price_data`) hay không. Nếu thanh toán báo lỗi thiếu quyền, mở menu (⋯) của khóa, chọn **View request logs**, rồi thêm quyền mà yêu cầu lỗi nêu tên (ví dụ **Products** hoặc **Prices: Write**). Nguồn: [Restricted API keys](https://docs.stripe.com/keys/restricted-api-keys).

Đặt khóa vào `STRIPE_SECRET_KEY`. FlyBot nhận cả hai loại khóa.

Không cần **publishable key** (`pk_…`). FlyBot đưa người mua sang trang thanh toán của Stripe và không có ô nhập thẻ riêng.

### 3.3 Webhook endpoint

1. Mở tab [Webhooks](https://dashboard.stripe.com/webhooks) trong **Workbench** và nhấn **Create an event destination**. Developers Dashboard cũ có trang tương tự.
2. Chọn **Your account**.
3. Chọn định dạng **Snapshot**, không phải Thin. FlyBot đọc toàn bộ đối tượng trong mỗi sự kiện. Giữ phiên bản API mặc định của tài khoản; FlyBot đọc được cả kiểu hóa đơn cũ và mới.
4. Chọn đúng các sự kiện sau:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `customer.subscription.deleted`
5. Chọn **Webhook endpoint** làm loại đích, và nhập **Endpoint URL** `https://flybot.agrhub.com/api/payments/webhooks/stripe`.
6. Trên trang của endpoint, nhấn **Reveal secret** và chép giá trị `whsec_…` vào `STRIPE_WEBHOOK_SECRET`.

Mỗi endpoint có signing secret riêng, và secret của endpoint sandbox khác secret của endpoint live. Nguồn: [Receive Stripe events](https://docs.stripe.com/webhooks).

### 3.4 Thử trên máy cá nhân bằng Stripe CLI

Stripe không gọi được `localhost`, nên dùng [Stripe CLI](https://docs.stripe.com/cli/install) để chuyển tiếp sự kiện:

```bash
stripe login
stripe listen --forward-to localhost:3003/api/payments/webhooks/stripe
```

Cổng 3003 là API server khi phát triển (`npm run dev`); `localhost:3000/api/...` cũng được, qua proxy của ứng dụng web. `stripe listen` in ra `Ready! Your webhook signing secret is 'whsec_…'`. Đặt giá trị đó vào `STRIPE_WEBHOOK_SECRET` trong `.env` rồi khởi động lại FlyBot. Secret này khác với secret của endpoint trên Dashboard.

`stripe trigger invoice.payment_failed` gửi một sự kiện thử, nhưng hóa đơn của nó không có thông tin FlyBot, nên FlyBot xác nhận đã nhận và không thay đổi gì. Cách thử có ích là một lần mua thử thật (mục 5).

### 3.5 Thẻ thử nghiệm

Dùng ngày hết hạn bất kỳ trong tương lai (ví dụ `12/34`), CVC 3 chữ số bất kỳ, các ô khác điền gì cũng được. Nguồn: [Testing](https://docs.stripe.com/testing).

| Số thẻ | Kết quả |
|---|---|
| `4242 4242 4242 4242` | Thanh toán thành công |
| `4000 0000 0000 0002` | Bị từ chối (`card_declined`) |
| `4000 0000 0000 3220` | Yêu cầu xác thực 3D Secure, sau đó thành công |
| `4000 0000 0000 0341` | Thanh toán đầu thành công, các lần trừ tiền sau thất bại. Dùng để thấy lần gia hạn lỗi và thời gian ân hạn |

### 3.6 Chuyển sang chạy thật

1. Ở live mode, hoàn tất kích hoạt tài khoản Stripe và [danh sách kiểm tra go-live](https://docs.stripe.com/get-started/checklist/go-live).
2. Tạo restricted key **live** với cùng các quyền (`rk_live_…`).
3. Tạo webhook endpoint **live** với cùng URL và sự kiện, rồi chép `whsec_…` mới.
4. Thay `STRIPE_SECRET_KEY` và `STRIPE_WEBHOOK_SECRET` trong secret của production. Chỉ đặt `PAYMENTS_ALLOW_LIVE=true` trên máy chủ production, rồi khởi động lại.

## 4. Đặt khóa ở đâu

Không bao giờ đưa khóa vào git, issue hay tin nhắn. `.env` và `deploy.env` đã được git bỏ qua; `.env.example` chỉ chứa giá trị trống.

### 4.1 Trên máy cá nhân: `.env`

```bash
APP_BASE_URL=http://localhost:3000
PAYMENTS_ENABLED=true
PAYOS_CLIENT_ID=...
PAYOS_API_KEY=...
PAYOS_CHECKSUM_KEY=...
STRIPE_SECRET_KEY=rk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...      # lấy từ `stripe listen`
```

Khởi động lại server sau khi sửa `.env`.

### 4.2 Trên AWS: flybot-aws

Khi khởi động, FlyBot đọc secret từ AWS Secrets Manager theo tên trong `FLYBOT_SECRETS` (`flybot-<stage>-app`). Secret đó là một đối tượng JSON; giá trị đã có trong biến môi trường được ưu tiên hơn.

| Vào secret `flybot-<stage>-app` của Secrets Manager (bí mật) | Vào cấu hình máy chủ (không bí mật) |
|---|---|
| `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `PAYMENTS_ENABLED`, `PAYMENTS_GRACE_DAYS`, `PAYMENTS_ALLOW_LIVE` (chỉ production), cùng các biến tùy chọn `PAYOS_API_URL`, `PAYOS_LINK_TTL_MINUTES`, `STRIPE_API_URL`, `STRIPE_WEBHOOK_TOLERANCE` |

Với flybot-aws, điền vào `deploy.env` rồi chạy deploy. Script đưa phần bí mật vào `flybot-<stage>-app` và phần cấu hình lên máy chủ. Muốn sửa tay, vào AWS console **Secrets Manager → flybot-<stage>-app → Retrieve secret value → Edit**, sau đó khởi động lại FlyBot (`sudo systemctl restart flybot`).

Google Cloud Run: xem [DEPLOY.md](../DEPLOY.md) (mỗi khóa là một secret trong Secret Manager, thêm vào `_EXTRA_SECRETS`).

## 5. Kiểm tra bằng một lần mua thử

Dùng sandbox Stripe (hoặc kênh PayOS thử nghiệm với giá nhỏ):

1. Bằng tài khoản quản trị, đặt giá gói PRO trong **Cài đặt → Các gói**, đặt `PAYMENTS_ENABLED=true` rồi khởi động lại.
2. Mở trình duyệt ẩn danh, đăng ký một tài khoản mới. Tài khoản mới ở gói **FREE** (**Cài đặt → Gói & mức dùng** hiện "0 / 3" camera).
3. Mở trang **Các gói**. Ở gói PRO, nhấn **Thanh toán**, chọn theo tháng hoặc theo năm, thêm một camera, chọn **Thẻ (Stripe)** hoặc **Chuyển khoản VietQR (PayOS)**, rồi nhấn **Đến trang thanh toán**.
4. Trả bằng thẻ `4242 4242 4242 4242` trên trang Stripe, hoặc quét mã QR bằng ứng dụng ngân hàng trên trang PayOS.
5. Bạn được đưa về trang FlyBot "Cảm ơn bạn! Bạn đang dùng gói PRO", kèm số biên lai và ngày hết hạn.
6. **Cài đặt → Gói & mức dùng** hiện gói PRO với mức dùng cao hơn (ví dụ "0 / 11" camera) và biên lai trong phần **Thanh toán**.
7. Bằng tài khoản quản trị, **Cài đặt → Doanh thu** hiện khoản thanh toán theo tháng, cách thanh toán và gói, và không gian làm việc nằm trong số đang trả phí. Chủ không gian làm việc nhận thông báo "Đã nhận thanh toán".
8. Phía cổng thanh toán báo gửi thành công (`200`): Stripe ở **Workbench → Webhooks → endpoint của bạn → Event deliveries**. PayOS hiện giao dịch trên trang quản trị.

Nếu gói không đổi, kiểm tra: `PAYMENTS_ENABLED=true`; webhook secret hoặc Checksum Key đúng (sai thì trả `400`); `APP_BASE_URL` là địa chỉ HTTPS công khai; log máy chủ (`journalctl -u flybot`) không có dòng bắt đầu bằng "Payment webhook failed".

## 6. Đổi khóa

Đổi khóa khi người từng biết khóa nghỉ việc, khi khóa có thể đã lộ, hoặc theo lịch định kỳ.

- **Khóa API Stripe**: trên trang [API keys](https://dashboard.stripe.com/apikeys), mở menu (⋯) của khóa, chọn **Rotate key** và chọn lúc khóa cũ hết hạn (dùng song song tối đa 7 ngày). Đặt khóa mới vào secret, khởi động lại FlyBot, rồi xem **View request logs** của khóa cũ để chắc nó không còn được dùng.
- **Webhook secret Stripe**: trên trang của endpoint, mở menu (⋯) và nhấn **Roll secret**. Có thể giữ secret cũ dùng được tối đa 24 giờ. Trong thời gian đó Stripe ký bằng cả hai secret, và FlyBot nhận một lần gửi có chữ ký hợp lệ với secret nó đang giữ. Vì vậy hãy cập nhật `STRIPE_WEBHOOK_SECRET` và khởi động lại trong khoảng thời gian này.
- **Khóa PayOS**: chưa xác minh được trang quản trị có tạo lại khóa cho kênh được không. Nếu không, đổi khóa bằng cách tạo kênh thanh toán mới trên cùng tài khoản ngân hàng (mục 2.4), đặt khóa của kênh mới vào secret và khởi động lại FlyBot. Sau đó đặt webhook URL cho kênh mới (mục 2.5) và xóa kênh cũ. Các link thanh toán đã mở trên kênh cũ có thể ngừng hoạt động, nên hãy đổi vào lúc ít giao dịch.

## 7. Lưu ý bảo mật

- **Quyền tối thiểu.** Với Stripe, dùng restricted key chỉ có Checkout Sessions và Subscriptions (mục 3.2). Stripe còn cho giới hạn khóa theo địa chỉ ([access policies](https://dashboard.stripe.com/api-access-policies)), ví dụ chỉ IP của máy chủ. Theo những gì chúng tôi tìm được, khóa PayOS không có phân cấp quyền.
- **Mọi webhook đều được kiểm tra.** Webhook PayOS phải có chữ ký HMAC-SHA256 hợp lệ, tạo bằng Checksum Key. Webhook Stripe phải có `Stripe-Signature` hợp lệ, tạo bằng `whsec_…` và gửi trong vòng 5 phút (`STRIPE_WEBHOOK_TOLERANCE`), để chặn việc gửi lại. Lần gửi không qua kiểm tra nhận `400` và không thay đổi gì.
- **Mỗi khoản chỉ áp dụng một lần.** FlyBot lưu mã của mọi sự kiện đã áp dụng, và một khoản đã thanh toán không bao giờ được tính lại. Vì vậy việc cổng thanh toán gửi lại hay gửi trùng đều vô hại. Khoản trả thiếu tiền hoặc khác loại tiền được giữ ở trạng thái "Đang kiểm tra" trong **Cài đặt → Doanh thu** và không đổi gói.
- **Giá do FlyBot tính.** Số tiền thu được tính trên máy chủ từ **Cài đặt → Các gói**, không bao giờ lấy từ trình duyệt.
- **FlyBot không giữ dữ liệu thẻ.** Người mua trả tiền trên trang riêng của PayOS hoặc Stripe.
- **Hoàn tiền tạm thời làm thủ công.** Hoàn tiền trên trang quản trị của cổng thanh toán: Stripe từ khoản thanh toán, PayOS bằng cách chuyển khoản trả lại người mua. Sau đó, trong FlyBot, đặt lại gói của không gian làm việc bằng tay ở **Cài đặt → Không gian làm việc** (ví dụ về FREE, hoặc lùi ngày hết hạn). FlyBot không đọc sự kiện hoàn tiền, và biên lai vẫn hiện là đã thanh toán.
- **Khóa live chỉ dùng trên production.** Ở mọi nơi khác giữ `PAYMENTS_ALLOW_LIVE=false`.

## 8. Các biến cấu hình FlyBot đọc

| Biến | Bí mật | Mặc định | Ý nghĩa |
|---|---|---|---|
| `PAYMENTS_ENABLED` | không | `false` | Bật thanh toán trực tuyến (không bao giờ bật khi `APP_MODE=b2b`) |
| `PAYMENTS_GRACE_DAYS` | không | `7` | Số ngày gói trả trực tuyến vẫn dùng được sau ngày hết hạn, trước khi về FREE |
| `PAYMENTS_ALLOW_LIVE` | không | `false` | `true` chỉ trên production: cho phép khóa Stripe live |
| `PAYOS_CLIENT_ID` | có | | Client ID của kênh PayOS |
| `PAYOS_API_KEY` | có | | API Key của kênh PayOS |
| `PAYOS_CHECKSUM_KEY` | có | | Checksum Key của kênh PayOS (ký yêu cầu, kiểm tra webhook) |
| `PAYOS_API_URL` | không | `https://api-merchant.payos.vn` | Địa chỉ API PayOS |
| `PAYOS_LINK_TTL_MINUTES` | không | `60` | Thời gian link thanh toán PayOS còn hiệu lực |
| `STRIPE_SECRET_KEY` | có | | `rk_test_…` / `sk_test_…` (live: `rk_live_…` / `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | có | | `whsec_…` của webhook endpoint |
| `STRIPE_API_URL` | không | `https://api.stripe.com` | Địa chỉ API Stripe |
| `STRIPE_WEBHOOK_TOLERANCE` | không | `300` | Số giây webhook Stripe có chữ ký còn được chấp nhận |
| `APP_BASE_URL` | không | | Địa chỉ HTTPS công khai; cổng thanh toán đưa người mua về `<APP_BASE_URL>/billing/return` |
