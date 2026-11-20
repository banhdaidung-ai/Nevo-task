/* 
  MAIN ENTRY POINT
  Initializes all services and handles global state without duplicating inline listeners
*/

import { initDarkMode, toggleDarkMode, initPremiumEffects, navigateTo, showToast } from './ui-service.js';
import { checkAuth, getCurrentUser, getRoleDisplayName, performLogout } from './auth-service.js';
import './firebase-service.js';

// Apply Dark Mode immediately before DOM paint finishes
initDarkMode();

function initMainApp() {
    if (window._nevoMainInit) return;
    window._nevoMainInit = true;

    if (!checkAuth()) return;

    initDarkMode();
    initPremiumEffects();

    const darkModeBtn = document.getElementById('darkModeBtn');
    if (darkModeBtn && !darkModeBtn.dataset.bound) {
        darkModeBtn.dataset.bound = '1';
        darkModeBtn.addEventListener('click', () => {
            toggleDarkMode();
        });
    }

    // Populate user badge with localized Vietnamese role
    const user = getCurrentUser();
    const navUserName = document.getElementById('navUserName');
    const navUserInitial = document.getElementById('navUserInitial');
    const dropUserName = document.getElementById('dropUserName');
    const dropUserRole = document.getElementById('dropUserRole');

    const initials = (user.name || 'NV')
        .split(/\s+/)
        .filter(Boolean)
        .map(n => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2) || 'NV';

    if (navUserName) navUserName.textContent = user.name;
    if (navUserInitial) navUserInitial.textContent = initials;
    if (dropUserName) dropUserName.textContent = user.name;
    if (dropUserRole) dropUserRole.textContent = getRoleDisplayName(user.role);

    // Single authoritative hash navigation
    const initialPage = window.location.hash.replace(/^#/, '').trim() || 'dashboard';
    navigateTo(initialPage);

    window.addEventListener('hashchange', () => {
        const rawHash = window.location.hash.replace(/^#/, '').trim();
        if (!rawHash && window.location.href.endsWith('#')) return;
        const hashPage = rawHash || 'dashboard';
        if (hashPage && window.currentPage !== hashPage) navigateTo(hashPage);
    });

    console.log('Nevo-Task Enterprise Initialized');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMainApp);
} else {
    initMainApp();
}

window.navigateTo = navigateTo;
window.showToast = showToast;
window.handleLogout = performLogout;
window.toggleUserMenu = (e) => {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('userDropdown');
    const notifDropdown = document.getElementById('notifDropdown');
    if (notifDropdown) notifDropdown.classList.remove('open');
    if (dropdown) dropdown.classList.toggle('open');
};
