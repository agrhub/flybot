// Amounts from the server are integers in the currency's smallest unit (VND: dong, USD: cents)
const MINOR_DIGITS = { VND: 0, USD: 2 };

/** The amount as a number of whole units (19900 USD cents -> 199). */
export function fromMinor(amount, currency) {
  const digits = MINOR_DIGITS[String(currency || '').toUpperCase()] ?? 2;
  return Number(amount || 0) / 10 ** digits;
}

/** The amount in whole units -> the smallest unit, as the server stores it (199 USD -> 19900). */
export function toMinor(value, currency) {
  const digits = MINOR_DIGITS[String(currency || '').toUpperCase()] ?? 2;
  return Math.round(Number(value || 0) * 10 ** digits);
}

/** "199.000 ₫", "$9.00": an amount in the smallest unit, formatted for the app's language. */
export function formatMoney(amount, currency, locale = 'vi') {
  const code = String(currency || 'VND').toUpperCase();
  const digits = MINOR_DIGITS[code] ?? 2;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(fromMinor(amount, code));
  } catch {
    return `${fromMinor(amount, code)} ${code}`;
  }
}

export const PRICE_CURRENCIES = Object.keys(MINOR_DIGITS);
