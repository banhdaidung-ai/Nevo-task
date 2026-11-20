/* 
  UI SERVICE
  Premium UI interactions, unified Toast notifications, Dark Mode, and SPA navigation
*/

import "./security-utils.js";

let navTransitionTimer = null;
let hidePreviousTimer = null;
let toastHideTimer = null;

/**
 * Sync Dark Mode button icon with current document state
 */
export function syncDarkModeIcon() {
    const isDark = document.documentElement.classList.contains('dark');
    document.querySelectorAll('#darkModeBtn span, [data-theme-icon]').forEach(icon => {
        icon.textContent = isDark ? 'light_mode' : 'dark_mode';
    });
}

/**
 * Initialize Dark Mode based on preference or saved setting
 */
export function initDarkMode() {
    const savedTheme = localStorage.getItem('nevo_theme') || 'light';
    if (savedTheme === 'dark') {
        document.documentElement.classList.add('dark');
        document.documentElement.classList.remove('light');
    } else {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
    }
    syncDarkModeIcon();
}

/**
 * Toggle between Light and Dark mode
 */
export function toggleDarkMode() {
    const isDark = document.documentElement.classList.toggle('dark');
    document.documentElement.classList.toggle('light', !isDark);
    localStorage.setItem('nevo_theme', isDark ? 'dark' : 'light');
    syncDarkModeIcon();
    return isDark;
}

/**
 * Show a unified Toast notification (compatible with both 2-arg and 4-arg call sites)
 */
export function showToast(title, message = '', icon = 'check_circle', type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;

    // Normalize 2-argument legacy calls like showToast("Đã lưu", "success") or showToast("Lỗi...", "error")
    const knownTypes = ['success', 'error', 'info', 'warning'];
    if (arguments.length === 2 && knownTypes.includes(String(message).toLowerCase())) {
        type = String(message).toLowerCase();
        message = title;
        title = type === 'error' ? 'Lỗi!' : type === 'warning' ? 'Chú ý!' : type === 'info' ? 'Thông báo' : 'Thành công!';
        icon = type === 'error' ? 'error' : type === 'warning' ? 'warning' : type === 'info' ? 'info' : 'check_circle';
    }

    const colorMap = {
        success: 'text-emerald-500',
        error: 'text-rose-500',
        info: 'text-blue-500',
        warning: 'text-amber-500',
        'text-tertiary': 'text-emerald-500',
        'text-error': 'text-rose-500',
        'text-primary': 'text-rose-600'
    };

    const titleEl = document.getElementById('toastTitle');
    const msgEl = document.getElementById('toastMsg');
    const iconEl = document.getElementById('toastIcon');

    if (titleEl) titleEl.textContent = title || 'Thông báo';
    if (msgEl) msgEl.textContent = message || '';
    if (iconEl) {
        iconEl.textContent = icon || 'check_circle';
        iconEl.className = `material-symbols-outlined ${colorMap[type] || type || colorMap.success}`;
    }

    toast.classList.add('show');
    if (toastHideTimer) clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => toast.classList.remove('show'), 4000);
}

/**
 * Premium Page Navigation with race-condition protection and invalid-hash fallback
 */
export function navigateTo(pageId, eventObj) {
    if (eventObj && typeof eventObj.preventDefault === 'function') {
        eventObj.preventDefault();
    }
    const cleanId = String(pageId || 'dashboard').replace(/^#/, '').trim() || 'dashboard';
    let newEl = document.getElementById(`page-${cleanId}`);
    let resolvedPageId = cleanId;

    // Fallback safely to dashboard if hash does not match any page element
    if (!newEl) {
        resolvedPageId = 'dashboard';
        newEl = document.getElementById('page-dashboard');
        if (!newEl) return;
    }

    // Update current page, active nav highlight, and URL hash synchronously so hashchange/clicks stay in sync
    window.currentPage = resolvedPageId;
    updateActiveNavLinks(resolvedPageId);
    if (window.location.hash !== `#${resolvedPageId}`) {
        history.replaceState(null, '', `#${resolvedPageId}`);
    }

    const activePages = Array.from(document.querySelectorAll('.page.active'));
    if (activePages.length === 1 && activePages[0] === newEl && newEl.classList.contains('visible')) {
        return;
    }

    // Cancel any pending rapid-click navigation timers to prevent multiple active pages
    if (navTransitionTimer) clearTimeout(navTransitionTimer);
    if (hidePreviousTimer) clearTimeout(hidePreviousTimer);

    const otherPages = activePages.filter(el => el !== newEl);
    otherPages.forEach(el => el.classList.remove('visible'));

    if (otherPages.length > 0) {
        hidePreviousTimer = setTimeout(() => {
            document.querySelectorAll('.page').forEach(el => {
                if (el !== newEl) el.classList.remove('active', 'visible');
            });
        }, 220);
    }

    navTransitionTimer = setTimeout(() => {
        document.querySelectorAll('.page').forEach(el => {
            if (el !== newEl) el.classList.remove('active', 'visible');
        });

        newEl.classList.add('active');
        void newEl.offsetWidth;
        newEl.classList.add('visible');

        window.scrollTo?.({ top: 0, behavior: 'smooth' });

        // Trigger page-specific renders safely so a render issue never blocks navigation
        try {
            if (resolvedPageId === 'dashboard' && window.renderDashboardTable) window.renderDashboardTable();
            if (resolvedPageId === 'orders') {
                if (window.currentOrdersView === 'weekly' && window.renderWeeklyBoard) {
                    window.renderWeeklyBoard();
                } else if (window.currentOrdersView === 'kanban' && window.renderKanbanBoard) {
                    window.renderKanbanBoard();
                } else if (window.renderOrdersTable) {
                    window.renderOrdersTable();
                }
            }
            if (resolvedPageId === 'reports' && window.renderReports) window.renderReports();
            if (resolvedPageId === 'planning') {
                if (window.renderPlanningTable) window.renderPlanningTable();
                if (window.renderPlanningReport) window.renderPlanningReport();
            }
            if (resolvedPageId === 'budgetReport') {
                if (window.switchBudgetTab) window.switchBudgetTab(window.currentBudgetTab || 'production');
                else if (window.renderBudgetReport) window.renderBudgetReport();
            }
            if (resolvedPageId === 'detailed-report' && window.renderDetailedReport) window.renderDetailedReport();
            if (resolvedPageId === 'profile' && window.updateProfilePage) window.updateProfilePage();
        } catch (err) {
            console.error('[Nav render error]', resolvedPageId, err);
        }

        if (resolvedPageId === 'create-order') {
            if (window.updateOrderCategoryDropdown) window.updateOrderCategoryDropdown();
            const role = (localStorage.getItem('nevo_role') || 'user').toLowerCase();
            const userName = localStorage.getItem('nevo_user') || '';
            const userDept = localStorage.getItem('nevo_dept') || '';

            const reqEl = document.getElementById('requester');
            const deptEl = document.getElementById('department');

            if (reqEl && userName) {
                let found = false;
                for (let i = 0; i < reqEl.options.length; i++) {
                    if (reqEl.options[i].value === userName || reqEl.options[i].text === userName) {
                        reqEl.selectedIndex = i;
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    const opt = document.createElement('option');
                    opt.value = userName;
                    opt.text = userName;
                    opt.selected = true;
                    reqEl.add(opt);
                }
                const canChangeRequester = window.checkPermission ? window.checkPermission('requester') : role !== 'user';
                reqEl.disabled = !canChangeRequester;
                reqEl.parentElement?.classList.toggle('opacity-70', !canChangeRequester);
                reqEl.parentElement?.classList.toggle('pointer-events-none', !canChangeRequester);
            }

            if (deptEl && userDept) {
                let found = false;
                for (let i = 0; i < deptEl.options.length; i++) {
                    if (deptEl.options[i].value === userDept || deptEl.options[i].text === userDept) {
                        deptEl.selectedIndex = i;
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    const opt = document.createElement('option');
                    opt.value = userDept;
                    opt.text = userDept;
                    opt.selected = true;
                    deptEl.add(opt);
                }
                const canChangeDept = window.checkPermission ? window.checkPermission('department') : role !== 'user';
                deptEl.disabled = !canChangeDept;
                deptEl.classList.toggle('opacity-70', !canChangeDept);
                deptEl.classList.toggle('pointer-events-none', !canChangeDept);
            }
        }
    }, otherPages.length > 0 ? 180 : 0);
}

function updateActiveNavLinks(pageId) {
    document.querySelectorAll('.nav-link').forEach(link => {
        if (!link.dataset.page) return;
        const isActive = link.dataset.page === pageId;
        link.classList.toggle('text-rose-600', isActive);
        link.classList.toggle('border-b-2', isActive);
        link.classList.toggle('border-rose-600', isActive);
        link.classList.toggle('pb-1', isActive);
        link.classList.toggle('text-slate-500', !isActive);
        link.classList.toggle('hover:text-[#131b2e]', !isActive);
    });
}

/**
 * Initialize Glassmorphism reveal animations & PWA Service Worker
 */
export function initPremiumEffects() {
    if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('animate-slide-up');
                }
            });
        }, { threshold: 0.1 });

        document.querySelectorAll('.glass-card').forEach(card => {
            observer.observe(card);
        });
    }

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
        navigator.serviceWorker.register('./sw.js').catch(err => {
            console.warn('SW registration skipped:', err);
        });
    }
}

if (typeof window !== 'undefined') {
    window.showToast = showToast;
    window.navigateTo = navigateTo;
    window.initDarkMode = initDarkMode;
    window.toggleDarkMode = toggleDarkMode;
}
