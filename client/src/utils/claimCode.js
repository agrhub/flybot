/**
 * What a CamOS camera's QR or link carries (flybot-aws CONTRACTS 2a.1):
 *   label QR   CAMOS:1;SN:<serial>;VC:<verify code>;M:<model>;;
 *   claim link https://flybot.agrhub.com/claim?sn=<serial>[&vc=<code>]
 * Returns { serial, verifyCode, model } (missing parts are empty), or null.
 */
export function parseClaimCode(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^CAMOS:/i.test(text)) {
    const fields = Object.fromEntries(
      text.split(';').map((part) => part.split(':')).filter((kv) => kv.length >= 2).map(([k, ...v]) => [k.trim().toUpperCase(), v.join(':').trim()]),
    );
    const serial = (fields.SN || '').toUpperCase();
    if (!/^[A-Z0-9_-]{3,64}$/.test(serial)) return null;
    return { serial, verifyCode: (fields.VC || '').toUpperCase().slice(0, 6), model: fields.M || '' };
  }
  try {
    const url = new URL(text);
    const serial = String(url.searchParams.get('sn') || '').toUpperCase();
    if (!/^[A-Z0-9_-]{3,64}$/.test(serial)) return null;
    return { serial, verifyCode: String(url.searchParams.get('vc') || '').toUpperCase().slice(0, 6), model: '' };
  } catch {
    return null;
  }
}
