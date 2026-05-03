/* 
  UTILITY FUNCTIONS
  Data formatting, sanitization, and common helpers
*/

/**
 * Format number as currency (VNĐ)
 * Handles NaN cases gracefully
 */
export function formatCurrency(value) {
    const num = parseInt(value.toString().replace(/\D/g, '')) || 0;
    return num.toLocaleString('vi-VN');
}

/**
 * Sanitize number from string
 */
export function sanitizeNumber(value) {
    if (typeof value === 'number') return value;
    const clean = (value || '').toString().replace(/\D/g, '');
    return parseInt(clean) || 0;
}

/**
 * Format date to local string (DD/MM/YYYY)
 */
export function formatDate(date) {
    if (!date) return 'N/A';
    const d = new Date(date);
    if (isNaN(d.getTime())) return 'N/A';
    return d.toLocaleDateString('vi-VN');
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
    return map[status] || 'bg-slate-100 text-slate-700';
}
