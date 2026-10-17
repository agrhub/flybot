# Online payments: setting up PayOS and Stripe

[Tiếng Việt](payments.vi.md)

This guide is for the person who runs FlyBot. It covers creating the PayOS and Stripe accounts and keys, where the keys go, checking the setup with a test purchase, and keeping the keys safe. What the payment code does is in [API.md, "Payments"](../API.md#payments).

- **PayOS**: VietQR bank transfer, in VND. Each period is paid separately, and FlyBot reminds the owner before the plan ends.
- **Stripe**: cards, in USD or VND. The subscription renews automatically.

You can turn on one provider or both. A provider shows up in the app once its keys are set.

Checked against the providers' official documentation on 2026-10-17. Dashboards change, so where a menu name could not be confirmed, this guide says so.

## Contents

1. [Before you start](#1-before-you-start)
2. [PayOS](#2-payos)
3. [Stripe](#3-stripe)
4. [Where the keys go](#4-where-the-keys-go)
5. [Check the setup with a test purchase](#5-check-the-setup-with-a-test-purchase)
6. [Rotating keys](#6-rotating-keys)
7. [Security notes](#7-security-notes)
8. [Settings FlyBot reads](#8-settings-flybot-reads)

## 1. Before you start

- FlyBot must be reachable over **HTTPS** at its public address, for example `https://flybot.agrhub.com`. Set `APP_BASE_URL` to that address. The providers send the buyer back to `<APP_BASE_URL>/billing/return` and post their webhooks to:

  | Provider | Webhook URL |
  |---|---|
  | PayOS | `https://flybot.agrhub.com/api/payments/webhooks/payos` |
  | Stripe | `https://flybot.agrhub.com/api/payments/webhooks/stripe` |

- Set the prices first. Signed in as the administrator, open **Settings → Plans** (in the Administration group). For each paid plan, enter the price **Per month**, **Per year**, **Extra camera per month** and **Extra camera per year**, in VND (for PayOS and Stripe) and/or USD (for Stripe). A plan without a price is not sold online and keeps showing "Contact us".
- With `APP_MODE=b2b`, online payment stays off and invoices are manual.

## 2. PayOS

PayOS ([payos.vn](https://payos.vn)) creates VietQR payment links paid by bank transfer through Napas 24/7. Its dashboard is [my.payos.vn](https://my.payos.vn).

### 2.1 Create the account

1. Open [my.payos.vn/login](https://my.payos.vn/login), choose **Đăng ký** (Sign up), fill in the form and press **Tạo tài khoản** (Create account).
2. Open the email from PayOS and press **Xác thực** (Verify) to activate the account.

Source: [Tạo tài khoản payOS](https://payos.vn/docs/huong-dan-su-dung/tao-tai-khoan-payos).

### 2.2 Verify the organization

PayOS only pays into a bank account whose holder name matches the verified organization, so verify first.

- **Business (with a legal entity)**: choose **Doanh nghiệp (có pháp nhân)**, enter the tax code or business licence number (MST/GPKD) and press **Kiểm tra** (Check). If it succeeds, the company name fills in; press **Tiếp tục** (Continue).
- **Individual or household business**: choose **Tài khoản cá nhân/Hộ kinh doanh**, enter the national ID number (CCCD/CMND) and full name, and press **Kiểm tra**.
- In both cases, finish by making the small **bank transfer shown as a QR code**. Send it from a bank account in the organization's own name (not an e-wallet), with exactly the content and amount shown. PayOS then verifies automatically.
- If PayOS cannot find the tax code or ID, email **verify@payos.vn** with the subject `[payOS] Xác thực thủ công + <your payOS email>`. Attach both sides of the CCCD and, for a business, the business licence with its red stamp.

Source: [Xác thực tổ chức](https://payos.vn/docs/huong-dan-su-dung/xac-thuc-to-chuc).

### 2.3 Link the bank account

Bank account requirements:

- The account holder's name must match the verified organization.
- The bank must be one PayOS can link. The PayOS guide had pages for **ACB, BIDV, KienlongBank, MB, OCB, VPBank, MSB and Vietcombank** when checked. Check [the current list](https://payos.vn/docs/huong-dan-su-dung/kenh-thu/ket-noi-tai-khoan/ngan-hang-acb) before you start.

To link an account, add the bank in PayOS. Enter the account number and holder name and press **Kiểm tra**. Enter your phone number, accept the terms and press **Liên kết** (Link). Then type the OTP your bank sends by SMS or in its app.

### 2.4 Create the payment channel and copy the keys

1. In the **Kênh thanh toán** (Payment channels) menu, press **Tạo kênh thanh toán** (Create payment channel).
2. Enter a channel name (for example `FlyBot`), upload a logo, and press **Tiếp tục**.
3. Choose the bank account for the channel and press **Tạo kênh thanh toán và tích hợp** (Create payment channel and integrate).
4. The success screen shows three keys. Copy each one into your password manager straight away:

   | PayOS shows | FlyBot setting |
   |---|---|
   | Client ID | `PAYOS_CLIENT_ID` |
   | API Key | `PAYOS_API_KEY` |
   | Checksum Key | `PAYOS_CHECKSUM_KEY` |

5. Press **Hoàn tất** (Done).

Source: [Tạo kênh thanh toán](https://payos.vn/docs/huong-dan-su-dung/kenh-thu/tao-kenh-thanh-toan).

The keys belong to this channel. Not verified: whether the keys can be shown again later from the channel's page. Treat this screen as the only time you see them.

### 2.5 Set the webhook URL

FlyBot must already be running with the three keys (section 4), because PayOS tests the URL when you save it.

1. In **Kênh thanh toán**, open the FlyBot channel and enter the webhook URL `https://flybot.agrhub.com/api/payments/webhooks/payos`. PayOS's guide says to add the webhook URL from the payment channel ("ấn chọn Kênh thanh toán để thêm webhookURL"). The exact name of the field was not verified.
2. When the URL is saved, PayOS posts a **sample payment** to it and expects a `2xx` answer. FlyBot checks the sample's signature with the checksum key and answers `200`; it finds no matching order and changes nothing.

Instead of the dashboard, the URL can also be set through PayOS's API (`POST https://api-merchant.payos.vn/confirm-webhook`), which runs the same check:

```bash
curl -X POST https://api-merchant.payos.vn/confirm-webhook \
  -H "x-client-id: $PAYOS_CLIENT_ID" -H "x-api-key: $PAYOS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl":"https://flybot.agrhub.com/api/payments/webhooks/payos"}'
```

PayOS answers `200` when the URL works and `400` when it is rejected. If it is rejected, check that FlyBot is running with `PAYMENTS_ENABLED=true` and the right `PAYOS_CHECKSUM_KEY`. Source: [API reference](https://payos.vn/docs/api/).

### 2.6 Testing with PayOS

**PayOS has no sandbox or test environment.** Its documentation says "payOS không cung cấp môi trường test (sandbox/staging) riêng biệt" (there is no separate sandbox or staging), and every transaction runs on the real API. Source: [Môi trường test](https://payos.vn/docs/moi-truong-test).

PayOS suggests testing with real money:

- Set a small VND price on the plan while you test (for example 10,000 VND), and make one real transfer to your own linked account.
- Keep a separate payment channel (and keys) for testing, so the production channel stays clean. Put the production price back afterwards.
- On a computer with no public address, PayOS cannot reach the webhook. FlyBot's return page asks PayOS for the payment status itself, through a signed API answer. So a test payment still completes when you come back to the return page. A tunnel (for example ngrok) also works for receiving the webhook.

PayOS shows a short transfer content to the buyer. FlyBot uses at most 9 characters, such as `FBPROM` for PRO monthly, because PayOS limits it to 9 characters for bank accounts not linked through PayOS.

## 3. Stripe

Stripe ([dashboard.stripe.com](https://dashboard.stripe.com)) takes cards and renews the subscription each month or year. FlyBot uses Stripe's hosted Checkout page, so card details never touch FlyBot.

### 3.1 Sandbox (test) and live mode

Stripe keeps test and live apart. A **sandbox** has its own keys: `sk_test_…` secret key, `rk_test_…` restricted key and `pk_test_…` publishable key. Payments there are simulated, and only test cards work. **Live mode** keys start with `sk_live_`, `rk_live_` and `pk_live_` and move real money. Objects never cross between the two. Use a sandbox until you go live. Source: [API keys](https://docs.stripe.com/keys).

FlyBot refuses a live key (`sk_live_…` or `rk_live_…`) unless `PAYMENTS_ALLOW_LIVE=true`, so a live key cannot be used by mistake on a test server.

### 3.2 The API key

1. Open [API keys](https://dashboard.stripe.com/apikeys) in a sandbox. The page shows the account or sandbox you are viewing.
2. Recommended: press **Create restricted key** and give it a name such as `flybot-billing`. Set only these permissions to **Write** and leave everything else at **None**:
   - **Checkout Sessions: Write** (FlyBot creates the subscription checkout)
   - **Subscriptions: Write** (FlyBot stops renewal when the owner asks)

   Press **Create key**, complete the verification and copy the `rk_test_…` value. Stripe will not show a key you created yourself again.
3. Or use the **secret key** (`sk_test_…`) from **Standard keys**. It has full access to the account, which is why Stripe recommends restricted keys.

Not verified: whether Stripe needs more permissions for the prices FlyBot sends with each checkout (`price_data`). If checkout fails with a permission error, open the key's menu (⋯), select **View request logs**, and add the permission the failed request names (for example **Products** or **Prices: Write**). Source: [Restricted API keys](https://docs.stripe.com/keys/restricted-api-keys).

Put the key in `STRIPE_SECRET_KEY`. FlyBot accepts either kind of key.

The **publishable key** (`pk_…`) is not needed. FlyBot sends the buyer to Stripe's own checkout page and has no card form of its own.

### 3.3 The webhook endpoint

1. Open the [Webhooks](https://dashboard.stripe.com/webhooks) tab in **Workbench** and press **Create an event destination**. The older Developers Dashboard has a similar page.
2. Choose **Your account**.
3. Choose the payload format **Snapshot**, not Thin. FlyBot reads the full object in each event. Keep the account's default API version; FlyBot reads both the older and the newer invoice layouts.
4. Select exactly these events:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `customer.subscription.deleted`
5. Choose **Webhook endpoint** as the destination type, and enter the **Endpoint URL** `https://flybot.agrhub.com/api/payments/webhooks/stripe`.
6. On the endpoint's page, press **Reveal secret** and copy the `whsec_…` value into `STRIPE_WEBHOOK_SECRET`.

Each endpoint has its own signing secret, and a sandbox endpoint's secret differs from a live endpoint's. Source: [Receive Stripe events](https://docs.stripe.com/webhooks).

### 3.4 Testing on your computer with the Stripe CLI

Stripe cannot reach `localhost`, so the [Stripe CLI](https://docs.stripe.com/cli/install) forwards the events:

```bash
stripe login
stripe listen --forward-to localhost:3003/api/payments/webhooks/stripe
```

Port 3003 is the API server in development (`npm run dev`); `localhost:3000/api/...` works too, through the web app's proxy. `stripe listen` prints `Ready! Your webhook signing secret is 'whsec_…'`. Put that value in `STRIPE_WEBHOOK_SECRET` in your `.env` and restart FlyBot. The secret is not the one from the Dashboard endpoint.

`stripe trigger invoice.payment_failed` sends a test event, but its invoice has no FlyBot metadata, so FlyBot acknowledges it and changes nothing. A real test purchase is the useful test (section 5).

### 3.5 Test cards

Use any future expiry date (for example `12/34`), any 3-digit CVC and any other values. Source: [Testing](https://docs.stripe.com/testing).

| Card number | What happens |
|---|---|
| `4242 4242 4242 4242` | Payment succeeds |
| `4000 0000 0000 0002` | Declined (`card_declined`) |
| `4000 0000 0000 3220` | Asks for 3D Secure authentication, then succeeds |
| `4000 0000 0000 0341` | Checkout succeeds but later charges fail. Use it to see a failed renewal and the grace period |

### 3.6 Going live

1. In live mode, finish Stripe's account activation and its [go-live checklist](https://docs.stripe.com/get-started/checklist/go-live).
2. Create a **live** restricted key with the same permissions (`rk_live_…`).
3. Create a **live** webhook endpoint with the same URL and events, and copy its new `whsec_…`.
4. Replace `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in the production secret. Set `PAYMENTS_ALLOW_LIVE=true` on the production server only, and restart.

## 4. Where the keys go

Never put a key in git, in an issue, or in a chat. `.env` and `deploy.env` are ignored by git; `.env.example` holds only empty values.

### 4.1 On your computer: `.env`

```bash
APP_BASE_URL=http://localhost:3000
PAYMENTS_ENABLED=true
PAYOS_CLIENT_ID=...
PAYOS_API_KEY=...
PAYOS_CHECKSUM_KEY=...
STRIPE_SECRET_KEY=rk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...      # from `stripe listen`
```

Restart the server after changing `.env`.

### 4.2 On AWS: flybot-aws

FlyBot reads its secrets at start-up from the AWS Secrets Manager secret named by `FLYBOT_SECRETS` (`flybot-<stage>-app`). That secret is one JSON object, and a value already set in the environment wins over it.

| Goes to the Secrets Manager secret `flybot-<stage>-app` (secrets) | Goes to the instance settings (not secret) |
|---|---|
| `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `PAYMENTS_ENABLED`, `PAYMENTS_GRACE_DAYS`, `PAYMENTS_ALLOW_LIVE` (production only), plus the optional `PAYOS_API_URL`, `PAYOS_LINK_TTL_MINUTES`, `STRIPE_API_URL`, `STRIPE_WEBHOOK_TOLERANCE` |

With flybot-aws, put them in `deploy.env` and run the deploy. The script moves the secrets into `flybot-<stage>-app` and the settings into the instance. To change a value by hand, edit the secret in the AWS console under **Secrets Manager → flybot-<stage>-app → Retrieve secret value → Edit**, then restart FlyBot (`sudo systemctl restart flybot`).

Google Cloud Run: see [DEPLOY.md](../DEPLOY.md) (each key as a Secret Manager secret in `_EXTRA_SECRETS`).

## 5. Check the setup with a test purchase

With a Stripe sandbox (or a PayOS test channel and a small price):

1. As administrator, set the PRO prices in **Settings → Plans**, set `PAYMENTS_ENABLED=true` and restart.
2. In a private browser window, sign up as a new user. The new account is on **FREE** (**Settings → Plan & usage** shows "0 / 3" cameras).
3. Open **Plans** (the pricing page). Under PRO, press **Pay**, choose monthly or yearly, add an extra camera, pick **Card (Stripe)** or **VietQR bank transfer (PayOS)**, and press **Go to payment**.
4. Pay with `4242 4242 4242 4242` on Stripe's page, or scan the QR code with your banking app on PayOS's page.
5. You come back to FlyBot's page "Thank you! You are on PRO", with the receipt number and the end date.
6. **Settings → Plan & usage** shows PRO with the higher limits (for example "0 / 11" cameras) and the receipt under **Payments**.
7. As administrator, **Settings → Revenue** shows the payment, by month, payment method and plan, and the workspace among the paying ones. The owner gets a "Payment received" notification.
8. At the provider, the delivery shows as successful (`200`): on Stripe, **Workbench → Webhooks → your endpoint → Event deliveries**. PayOS shows the transaction in its dashboard.

If the plan does not change, check that `PAYMENTS_ENABLED=true`, the webhook secret or checksum key is right (a wrong one answers `400`), `APP_BASE_URL` is the public HTTPS address, and the server log (`journalctl -u flybot`) shows no lines starting with "Payment webhook failed".

## 6. Rotating keys

Rotate when someone who knew a key leaves, when a key may have leaked, or on a schedule.

- **Stripe API key**: on [API keys](https://dashboard.stripe.com/apikeys), open the key's menu (⋯), select **Rotate key**, and choose when the old one expires (up to 7 days of overlap). Put the new key in the secret, restart FlyBot, and check the old key's **View request logs** shows no more use.
- **Stripe webhook secret**: on the endpoint's page, open the menu (⋯) and press **Roll secret**. You can keep the old secret valid for up to 24 hours. During that time Stripe signs with both secrets, and FlyBot accepts a delivery that carries a valid signature for the secret it has, so update `STRIPE_WEBHOOK_SECRET` and restart within that window.
- **PayOS keys**: not verified whether the dashboard can regenerate a channel's keys. If it cannot, rotate by creating a new payment channel on the same bank account (section 2.4), putting its keys in the secret and restarting FlyBot. Then set its webhook URL (section 2.5) and remove the old channel. PayOS links already opened on the old channel may stop working, so rotate at a quiet time.

## 7. Security notes

- **Least privilege.** On Stripe, use a restricted key with only Checkout Sessions and Subscriptions (section 3.2). Stripe also lets you limit a key to known addresses ([access policies](https://dashboard.stripe.com/api-access-policies)), for example to your server's IP. PayOS has no permission levels on its keys that we could find.
- **Every webhook is checked.** A PayOS webhook must carry a valid HMAC-SHA256 signature made with the checksum key. A Stripe webhook must carry a valid `Stripe-Signature` made with the `whsec_…`, sent within the last 5 minutes (`STRIPE_WEBHOOK_TOLERANCE`), which stops replays. A delivery that fails the check gets `400` and changes nothing.
- **Each payment is applied once.** FlyBot keeps the id of every event it applied, and a paid payment is never paid again, so the providers' retries and duplicates are harmless. A payment of less money than ordered, or in another currency, is held as "Being checked" in **Settings → Revenue** and does not change the plan.
- **Prices come from FlyBot.** The amount charged is computed on the server from **Settings → Plans**, never taken from the browser.
- **No card data in FlyBot.** Buyers pay on PayOS's or Stripe's own page.
- **Refunds are manual for now.** Refund in the provider's dashboard: on Stripe from the payment, on PayOS by a bank transfer back to the buyer. Then, in FlyBot, set the workspace's plan by hand in **Settings → Workspaces** (for example back to FREE, or an earlier end date). FlyBot does not read refund events, and the receipt stays in the list as paid.
- **Live keys only on production.** Keep `PAYMENTS_ALLOW_LIVE=false` everywhere else.

## 8. Settings FlyBot reads

| Setting | Secret | Default | Meaning |
|---|---|---|---|
| `PAYMENTS_ENABLED` | no | `false` | Turns online payment on (never with `APP_MODE=b2b`) |
| `PAYMENTS_GRACE_DAYS` | no | `7` | Days a plan paid online keeps working after its end date, before FREE |
| `PAYMENTS_ALLOW_LIVE` | no | `false` | `true` on production only: allows a live Stripe key |
| `PAYOS_CLIENT_ID` | yes | | PayOS channel's Client ID |
| `PAYOS_API_KEY` | yes | | PayOS channel's API Key |
| `PAYOS_CHECKSUM_KEY` | yes | | PayOS channel's Checksum Key (signs requests, checks webhooks) |
| `PAYOS_API_URL` | no | `https://api-merchant.payos.vn` | PayOS API address |
| `PAYOS_LINK_TTL_MINUTES` | no | `60` | How long a PayOS payment link stays open |
| `STRIPE_SECRET_KEY` | yes | | `rk_test_…` / `sk_test_…` (live: `rk_live_…` / `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | yes | | The webhook endpoint's `whsec_…` |
| `STRIPE_API_URL` | no | `https://api.stripe.com` | Stripe API address |
| `STRIPE_WEBHOOK_TOLERANCE` | no | `300` | Seconds a signed Stripe webhook is accepted |
| `APP_BASE_URL` | no | | Public HTTPS address; the providers return the buyer to `<APP_BASE_URL>/billing/return` |
