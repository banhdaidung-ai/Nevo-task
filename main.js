/* 
  MAIN ENTRY POINT
  Initializes all services and handles global state
*/

import { initDarkMode, toggleDarkMode, initPremiumEffects, navigateTo } from './ui-service.js';
import { checkAuth, getCurrentUser } from './auth-service.js';
import './firebase-service.js'; // Ensure Firebase is initialized

document.addEventListener('DOMContentLoaded', () => {
    // 1. Check Authentication
    if (!checkAuth()) return;

    // 2. Initialize UI
    initDarkMode();
    initPremiumEffects();

    // 3. Setup Global Events
    const darkModeBtn = document.getElementById('darkModeBtn');
    if (darkModeBtn) {
        darkModeBtn.addEventListener('click', () => {
            const isDark = toggleDarkMode();
            const icon = darkModeBtn.querySelector('span');
            if (icon) {
                icon.textContent = isDark ? 'light_mode' : 'dark_mode';
            }
        });
    }

    // 4. Handle initial navigation based on hash
    const initialPage = window.location.hash.replace('#', '') || 'dashboard';
    navigateTo(initialPage);

    // 5. Update UI with user info
    const user = getCurrentUser();
    const navUserName = document.getElementById('navUserName');
    const navUserInitial = document.getElementById('navUserInitial');
    const dropUserName = document.getElementById('dropUserName');
    const dropUserRole = document.getElementById('dropUserRole');

    if (navUserName) navUserName.textContent = user.name;
    if (navUserInitial) navUserInitial.textContent = user.name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
    if (dropUserName) dropUserName.textContent = user.name;
    if (dropUserRole) dropUserRole.textContent = user.role.toUpperCase();

    console.log('Nevo-Task Premium Initialized');
});

// Export global functions for HTML inline calls
window.navigateTo = navigateTo;
window.handleLogout = () => {
    localStorage.clear();
    window.location.replace('login.html');
};
window.toggleUserMenu = () => {
    const dropdown = document.getElementById('userDropdown');
    if (dropdown) dropdown.classList.toggle('open');
};
