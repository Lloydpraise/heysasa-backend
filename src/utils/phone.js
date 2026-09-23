// Strict Kenyan mobile number validation. Accepts the formats people
// actually type — 07XXXXXXXX, 01XXXXXXXX, +254XXXXXXXXX, 254XXXXXXXXX,
// with spaces or dashes anywhere — and normalizes all of them to a
// single canonical form: 254XXXXXXXXX (12 digits, no plus, no leading 0).
// Anything that doesn't resolve to a real-looking Safaricom/Airtel/Telkom
// mobile prefix is rejected outright rather than guessed at.
export function normalizeKenyanPhone(input) {
    if (!input) return null;
    const digitsOnly = String(input).replace(/[^\d+]/g, '');
    const stripped = digitsOnly.replace(/^\+/, '');

    let national; // the 9 digits after the leading 7/1, no country/trunk code
    if (stripped.startsWith('254') && stripped.length === 12) {
        national = stripped.slice(3);
    } else if (stripped.startsWith('0') && stripped.length === 10) {
        national = stripped.slice(1);
    } else if (stripped.length === 9) {
        national = stripped;
    } else {
        return null;
    }

    // Kenyan mobile numbers start with 7 (Safaricom/Airtel/Telkom) or 1
    // (newer Safaricom/Airtel ranges, e.g. 110-115).
    if (!/^[71]\d{8}$/.test(national)) return null;

    return `254${national}`;
}

// Formats a normalized 254XXXXXXXXX number back to 07XX XXX XXX for
// display purposes only — never used for storage or comparison.
export function displayKenyanPhone(normalized) {
    if (!normalized || normalized.length !== 12) return normalized || '';
    const national = normalized.slice(3);
    return `0${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
}
