// --- Pay codes (the short reference inside the UPI note) ---
//
// Every UPI payment session gets a short unique code, for example "7K4MQX".
// It is put at the FRONT of the UPI transaction note (the `tn` field of the QR
// link), followed by a shortened product name:  "7K4MQX 100 Diamonds".
//
// Why: the bank SMS that verifies a payment never contains the note, so
// automatic verification keeps matching on the unique amount exactly as
// before. The note is for people. It shows up in the admin's own UPI app, so
// when a payment arrives long after its session expired, the admin reads the
// code there, searches it on the Payment Sessions page and finds the buyer in
// seconds. The buyer sees the same code on the QR screen and on their order.
//
// This module is pure (no database, no Node-only imports) so the server action,
// the admin page and the purchase popup can all share it.

// No look-alikes: 0/O, 1/I/L, 5/S, 2/Z and 8/B are left out, so a code can be
// read off a phone screen or spoken aloud without mistakes. 25 symbols, six
// positions: about 244 million codes.
export const PAY_CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
export const PAY_CODE_LENGTH = 6;

// UPI apps cut long notes and some banks reject notes with symbols, so the note
// stays short and is limited to letters, digits and single spaces.
export const UPI_NOTE_MAX_LENGTH = 40;

const FULL_CODE = new RegExp(`^[${PAY_CODE_ALPHABET}]{${PAY_CODE_LENGTH}}$`);
const CODE_INSIDE_TEXT = new RegExp(`(?:^|[^A-Z0-9])([${PAY_CODE_ALPHABET}]{${PAY_CODE_LENGTH}})(?=$|[^A-Z0-9])`);

export function isPayCode(value: unknown): value is string {
    return typeof value === 'string' && FULL_CODE.test(value);
}

/** A fresh random code. Uniqueness is guaranteed by the database index, not here. */
export function generatePayCode(): string {
    const size = PAY_CODE_ALPHABET.length; // 25
    const limit = 256 - (256 % size); // 250: reject the tail so every symbol is equally likely
    let code = '';
    while (code.length < PAY_CODE_LENGTH) {
        const bytes = new Uint8Array(PAY_CODE_LENGTH * 2);
        globalThis.crypto.getRandomValues(bytes);
        for (let index = 0; index < bytes.length && code.length < PAY_CODE_LENGTH; index++) {
            if (bytes[index] < limit) code += PAY_CODE_ALPHABET[bytes[index] % size];
        }
    }
    return code;
}

/** Letters, digits and single spaces only. Everything else (symbols, emoji, other scripts) becomes a space. */
export function sanitizeUpiNoteText(text: string): string {
    let cleaned = '';
    for (const char of text || '') {
        const code = char.charCodeAt(0);
        const isDigit = code >= 48 && code <= 57;
        const isUpper = code >= 65 && code <= 90;
        const isLower = code >= 97 && code <= 122;
        cleaned += isDigit || isUpper || isLower ? char : ' ';
    }
    return cleaned.split(' ').filter(Boolean).join(' ');
}

/**
 * The note for the QR link: the code first (so it can never be cut off),
 * then as much of the product name as fits, cut at a word where possible.
 */
export function buildUpiNote(payCode: string, productName: string): string {
    const name = sanitizeUpiNoteText(productName);
    const room = UPI_NOTE_MAX_LENGTH - payCode.length - 1;
    if (!name || room < 3) return payCode;
    if (name.length <= room) return `${payCode} ${name}`;
    let short = name.slice(0, room);
    const lastSpace = short.lastIndexOf(' ');
    if (lastSpace >= Math.floor(room / 2)) short = short.slice(0, lastSpace);
    return `${payCode} ${short.trim()}`;
}

/**
 * Finds a complete pay code in whatever the admin typed or pasted: the bare
 * code, lower case, or the whole note copied from the UPI app.
 */
export function findPayCodeInText(text: string): string | null {
    const match = (text || '').toUpperCase().match(CODE_INSIDE_TEXT);
    return match ? match[1] : null;
}

/** The first characters of a code (3 or more), for searching while still typing. */
export function partialPayCode(text: string): string | null {
    const compact = (text || '').toUpperCase().split(' ').join('').split('-').join('');
    if (compact.length < 3 || compact.length > PAY_CODE_LENGTH) return null;
    for (const char of compact) {
        if (!PAY_CODE_ALPHABET.includes(char)) return null;
    }
    return compact;
}
