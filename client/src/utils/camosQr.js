// Text of the QR codes of FlyBot AI cameras (CamOS device protocol, section 12):
// fields "KEY:value" separated by ";", ending with ";;", with "\", ";" and ":" escaped by "\".

const escapeValue = (value) => String(value ?? '').replace(/([\\;:])/g, '\\$1');

// "CAMOS:1;SN:...;VC:...;;" -> { CAMOS: '1', SN: '...', VC: '...' }
function parseFields(text) {
  const fields = {};
  let key = null;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      current += text[++i];
    } else if (ch === ':' && key === null) {
      key = current;
      current = '';
    } else if (ch === ';') {
      if (key !== null) fields[key] = current;
      key = null;
      current = '';
    } else {
      current += ch;
    }
  }
  if (key !== null) fields[key] = current;
  return fields;
}

/**
 * The QR code on an AI camera's label: { serial, code, model }, or null when the text is not one
 * (an EZVIZ label, a plain serial number).
 */
export function parseCameraLabel(text) {
  const value = String(text || '').trim();
  if (!value.startsWith('CAMOS:')) return null;
  const fields = parseFields(value);
  if (!fields.SN || !fields.VC) return null;
  return { serial: fields.SN, code: fields.VC, model: fields.M || '' };
}

/**
 * The network QR code the camera scans: the Wi-Fi to join and the provision token FlyBot got
 * when it added the camera. Built in the browser, so the Wi-Fi password never reaches a server.
 */
export function networkQrText({ ssid, password, token, mqttHost, apn }) {
  const parts = ['CAMOS:1', `T:${password ? 'WPA' : 'nopass'}`, `S:${escapeValue(ssid)}`];
  if (password) parts.push(`P:${escapeValue(password)}`);
  parts.push(`K:${escapeValue(token)}`);
  if (mqttHost) parts.push(`E:${escapeValue(mqttHost)}`);
  if (apn) parts.push(`A:${escapeValue(apn)}`);
  return `${parts.join(';')};;`;
}
