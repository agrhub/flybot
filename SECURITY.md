# Security

## Reporting a vulnerability

Please email **contact@agrhub.com** with the details and steps to reproduce, rather than opening a public issue. We answer within a few working days and will tell you when a fix is deployed.

## How FlyBot protects data

- **Accounts:** passwords hashed with bcrypt; sign-in tokens in an httpOnly cookie or a Bearer header, never in URLs; sessions can be revoked per device; rate limits on sign-in, sign-up, password reset and email confirmation.
- **Email confirmation:** an invitation (to a camera, farm, report or organization) gives access only once the address is confirmed, so registering someone else's address does not grant their access.
- **Access checks on the server** for every camera, photo, farm, report and organization. Records you cannot see answer with the same 404 as missing ones.
- **Photos** are served through the API after an access check, never from public storage links. Uploaded profile photos are decoded and re-encoded, which drops location and camera details.
- **Secrets** (database, EZVIZ, S3, Roboflow, SMTP, Telegram, VAPID) live in `.env` locally, in AWS Secrets Manager on AWS and in Google Secret Manager on Cloud Run. They are not in the repository. On AWS, FlyBot reaches S3, Lambda, IoT Core and Kinesis Video Streams with the instance role, without stored keys.
- **Public API keys** are stored as hashes, read-only and rate-limited. Webhooks are signed and cannot target private network addresses in production.
- **Cameras:** each CamOS camera has its own AWS IoT certificate (its private key never leaves the camera) and its own device token, stored as a hash. Self-registration is rate-limited, a camera nobody claims stays invisible and is removed after 7 days, and a wrong claim code answers the same as an unknown camera and locks the serial after 5 tries. Live view uses short-lived credentials limited to one camera's channel.
- **The assistant** only reads data the user can see, and actions it proposes (recording a card change or a treatment) are saved only after the user confirms them.
- **Audit log** of sign-ins, role changes, sharing and other admin actions.
