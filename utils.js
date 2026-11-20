/* 
  UTILITY FUNCTIONS
  Data formatting, sanitization, and common helpers
*/

import { parseCurrencyNumber, toLocalYMD } from "./security-utils.js";

/**
 * Format number as currency digits (vi-VN) safely without throwing on null/undefined
 */
export function formatCurrency(value) {
    return parseCurrencyNumber(value).toLocaleString('vi-VN');
}

/**
 * Sanitize number from string or number preserving sign and decimals when present
 */
export function sanitizeNumber(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    return parseCurrencyNumber(value);
}

/**
 * Format date to local string (DD/MM/YYYY) without UTC boundary shift
 */
export function formatDate(date) {
    const ymd = toLocalYMD(date);
    if (!ymd) return 'N/A';
    const [y, m, d] = ymd.split('-');
    return `${d}/${m}/${y}`;
}

/**
 * Debounce function for performance
 */
export function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Get status color class
 */
export function getStatusColorClass(status) {
    const map = {
        'Chờ duyệt': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
        'Đang xử lý': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
        'Hoàn thành': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
        'Từ chối': 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400'
    };
    return map[status] || 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
}
