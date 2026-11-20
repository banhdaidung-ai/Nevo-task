/*
  SECURITY, FORMATTING & TIMEZONE UTILITIES
  Shared across index.html, admin.html, login.html, products.js, model.html, pdf-service.js
*/

/** Escape HTML special characters for safe text/attribute interpolation. */
export function escapeHtml(val) {
    return String(val ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Escape string for safe interpolation inside single-quoted JS string inside HTML onclick="fn('...')" */
export function escapeJsStr(val) {
    return String(val ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;')
        .replace(/\r/g, '')
        .replace(/\n/g, '\\n')
        .replace(/</g, '\\x3c')
        .replace(/>/g, '\\x3e');
}

/** Allow only http(s), mailto/tel, or raster base64 data:image URLs; return '' otherwise. */
export function safeUrl(raw) {
    const str = String(raw || '').trim();
    if (!str) return '';
    if (/^data:image\/(?:jpeg|jpg|png|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(str)) {
        return str;
    }
    try {
        const rawOrigin = globalThis.location?.origin;
        const base = (rawOrigin && rawOrigin !== 'null' && /^https?:/i.test(rawOrigin))
            ? rawOrigin
            : 'https://nevotask.firebaseapp.com';
        const parsed = new URL(str, base);
        if (['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) {
            return parsed.href;
        }
        return '';
    } catch {
        return '';
    }
}

/** Hash password with SHA-256 (64-char lowercase hex), with pure-JS fallback for non-HTTPS LAN testing. */
export async function hashPassword(password) {
    if (!password) return '';
    const str = String(password);
    if (globalThis.crypto?.subtle?.digest) {
        const msgBuffer = new TextEncoder().encode(str);
        const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', msgBuffer);
        return Array.from(new Uint8Array(hashBuffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }
    return sha256Fallback(str);
}

/** Compact deterministic SHA-256 fallback when WebCrypto subtle is unavailable (e.g. HTTP LAN IP). */
function sha256Fallback(ascii) {
    const rightRotate = (v, a) => (v >>> a) | (v << (32 - a));
    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    let result = '';
    const words = [];
    const bytes = new TextEncoder().encode(ascii);
    const bitLen = bytes.length * 8;
    const hash = [];
    const k = [];
    let primeCounter = 0;
    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
        if (!isComposite[candidate]) {
            for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
            hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
            k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
        }
    }
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / maxWord), false);
    dv.setUint32(padded.length - 4, bitLen >>> 0, false);
    for (let i = 0; i < padded.length; i += 4) words.push(dv.getUint32(i, false));

    for (let j = 0; j < words.length;) {
        const w = words.slice(j, (j += 16));
        const oldHash = hash.slice(0, 8);
        for (let i = 0; i < 64; i++) {
            const w15 = w[i - 15], w2 = w[i - 2];
            const a = hash[0], e = hash[4];
            const temp1 = (hash[7]
                + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
                + ((e & hash[5]) ^ (~e & hash[6]))
                + k[i]
                + (w[i] = i < 16 ? w[i] : (
                    w[i - 16]
                    + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
                    + w[i - 7]
                    + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
                ) | 0)) | 0;
            const temp2 = ((rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
                + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]))) | 0;
            hash.unshift((temp1 + temp2) | 0);
            hash[4] = (hash[4] + temp1) | 0;
            hash.pop();
        }
        for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (let i = 0; i < 8; i++) {
        for (let j = 3; j >= 0; j--) {
            const b = (hash[i] >> (j * 8)) & 255;
            result += b.toString(16).padStart(2, '0');
        }
    }
    return result;
}

/**
 * Parse Vietnamese/formatted currency string or number safely without NaN or sign loss.
 * Examples: "5.000.000 đ" -> 5000000, "-120.000" -> -120000, null -> 0, 15000 -> 15000.
 */
export function parseCurrencyNumber(val) {
    if (val === null || val === undefined || val === '') return 0;
    if (typeof val === 'number') return Number.isFinite(val) ? Math.round(val) : 0;
    const raw = String(val).trim();
    if (!raw) return 0;
    const isNeg = raw.startsWith('-');
    // Remove currency symbols and spaces; Vietnamese thousands separator is '.' or ','
    const digitsOnly = raw.replace(/[^\d]/g, '');
    if (!digitsOnly) return 0;
    const parsed = parseInt(digitsOnly, 10);
    if (!Number.isFinite(parsed)) return 0;
    return isNeg ? -parsed : parsed;
}

/** Format numeric or formatted currency input into "X.XXX.XXX đ" idempotently (never produces "NaN đ"). */
export function formatCurrencyVND(val, includeSuffix = true) {
    const num = parseCurrencyNumber(val);
    const formatted = num.toLocaleString('vi-VN');
    return includeSuffix ? `${formatted} đ` : formatted;
}

/** Format a local Date (or Timestamp / YYYY-MM-DD / DD/MM/YYYY) into local YYYY-MM-DD without UTC shift. */
export function toLocalYMD(val) {
    if (!val && val !== 0) return '';
    if (typeof val === 'object' && typeof val.toDate === 'function') {
        const d = val.toDate();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    if (typeof val === 'object' && typeof val.seconds === 'number') {
        const d = new Date(val.seconds * 1000);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    if (val instanceof Date && !isNaN(val.getTime())) {
        return `${val.getFullYear()}-${String(val.getMonth() + 1).padStart(2, '0')}-${String(val.getDate()).padStart(2, '0')}`;
    }
    const str = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
        const d = new Date(str);
        if (!isNaN(d.getTime())) {
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }
        return str.slice(0, 10);
    }
    const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) {
        return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    }
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
        return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
    }
    return '';
}

/** Build YYYY-MM-DD directly from (year, month1Based, day) without UTC drift. */
export function buildLocalYMD(year, month1Based, day = 1) {
    const d = new Date(Number(year), Number(month1Based) - 1, Number(day));
    return toLocalYMD(d);
}

/**
 * Determine whether an order was completed on or before its local deadline day (23:59:59.999 local time).
 */
export function isCompletedOnTimeLocal(deadlineVal, completedVal) {
    const deadlineYMD = toLocalYMD(deadlineVal);
    if (!deadlineYMD) return true;
    const completedYMD = completedVal ? toLocalYMD(completedVal) : toLocalYMD(new Date());
    if (!completedYMD) return true;
    return completedYMD <= deadlineYMD;
}

/** Convert Firestore Timestamp / seconds / ISO string / Date to epoch milliseconds consistently. */
export function toEpochMs(val) {
    if (!val) return 0;
    if (typeof val === 'number') return val < 1e12 ? val * 1000 : val;
    if (typeof val.toMillis === 'function') return val.toMillis();
    if (typeof val.toDate === 'function') return val.toDate().getTime();
    if (typeof val.seconds === 'number') return val.seconds * 1000;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(val).trim())) {
        const [y, m, d] = String(val).trim().split('-').map(Number);
        return new Date(y, m - 1, d).getTime();
    }
    const d = new Date(val);
    return isNaN(d.getTime()) ? 0 : d.getTime();
}

/** Safely strip HTML markup into readable plain text (preserving line breaks for block tags). */
export function stripHtmlToText(html) {
    if (!html) return '';
    const str = String(html)
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
    if (typeof DOMParser !== 'undefined') {
        const doc = new DOMParser().parseFromString(str, 'text/html');
        return (doc.body.textContent || '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }
    return str
        .replace(/<[^>]*>/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Safely render rich HTML into an element using native Sanitizer API or DOMPurify fallback. */
export function safeSetRichHTML(el, rawHtml) {
    if (!el) return;
    const html = String(rawHtml ?? '');
    if (typeof Element !== 'undefined' && 'setHTML' in Element.prototype) {
        try {
            el.setHTML(html);
            return;
        } catch {
            // Fall through to DOMPurify if custom sanitizer signature differs
        }
    }
    if (globalThis.DOMPurify?.sanitize) {
        el.innerHTML = globalThis.DOMPurify.sanitize(html, {
            USE_PROFILES: { html: true },
            ADD_ATTR: ['target', 'rel']
        });
        return;
    }
    el.textContent = stripHtmlToText(html);
}

/** Dynamic year range helper (from 2024 up to currentYear + 2). */
export function getDynamicYears(startYear = 2024, ahead = 2) {
    const current = new Date().getFullYear();
    const maxY = Math.max(current + ahead, 2027);
    const years = [];
    for (let y = startYear; y <= maxY; y++) years.push(y);
    return years;
}

/** Progressive-enhancement light-dismiss fallback for <dialog closedby="any"> on browsers lacking closedBy. */
export function attachDialogLightDismiss(dialog) {
    if (!dialog || dialog.dataset.lightDismissBound === '1') return;
    dialog.dataset.lightDismissBound = '1';
    dialog.addEventListener('close', () => {
        dialog.returnValue = '';
    });
    if (!('closedBy' in HTMLDialogElement.prototype)) {
        const outside = (e, dlg) => {
            const r = dlg.getBoundingClientRect();
            return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        };
        let pressedOutside = false;
        dialog.addEventListener('pointerdown', (e) => {
            pressedOutside = e.target === dialog && outside(e, dialog);
        });
        dialog.addEventListener('pointerup', (e) => {
            if (pressedOutside && e.target === dialog && outside(e, dialog)) {
                dialog.close();
            }
            pressedOutside = false;
        });
    }
}

// Expose globally for classic inline scripts
if (typeof window !== 'undefined') {
    window.escHtml = escapeHtml;
    window.escapeHtml = escapeHtml;
    window.escapeJsStr = escapeJsStr;
    window.safeUrl = safeUrl;
    window.hashPassword = hashPassword;
    window.parseCurrencyNumber = parseCurrencyNumber;
    window.formatCurrency = (val) => formatCurrencyVND(val, true);
    window.formatCurrencyPlain = (val) => formatCurrencyVND(val, false);
    window.unformatCurrencyValue = parseCurrencyNumber;
    window.toLocalYMD = toLocalYMD;
    window.buildLocalYMD = buildLocalYMD;
    window.isCompletedOnTimeLocal = isCompletedOnTimeLocal;
    window.toEpochMs = toEpochMs;
    window.stripHtmlToText = stripHtmlToText;
    window.safeSetRichHTML = safeSetRichHTML;
    window.getDynamicYears = getDynamicYears;
    window.attachDialogLightDismiss = attachDialogLightDismiss;
}
