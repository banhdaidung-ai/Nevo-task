/* 
  UI SERVICE
  Premium UI interactions and visual effects
*/

/**
 * Initialize Dark Mode based on preference or saved setting
 */
export function initDarkMode() {
    const savedTheme = localStorage.getItem('nevo_theme') || 'light';
    if (savedTheme === 'dark') {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
}

/**
 * Toggle between Light and Dark mode
 */
export function toggleDarkMode() {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('nevo_theme', isDark ? 'dark' : 'light');
    return isDark;
}

/**
 * Show a premium Toast notification
 */
export function showToast(title, message, icon = 'check_circle', type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    
    const colors = {
        success: 'text-emerald-500',
        error: 'text-rose-500',
        info: 'text-blue-500',
        warning: 'text-amber-500'
    };

    document.getElementById('toastTitle').textContent = title;
    document.getElementById('toastMsg').textContent = message;
    
    const iconEl = document.getElementById('toastIcon');
    iconEl.textContent = icon;
    iconEl.className = `material-symbols-outlined ${colors[type] || colors.success}`;
    
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 4000);
}

/**
 * Premium Page Navigation with transitions
 */
export function navigateTo(pageId) {
    const currentEl = document.querySelector('.page.active');
    const newEl = document.getElementById(`page-${pageId}`);
    
    if (currentEl === newEl && currentEl?.classList.contains('visible')) return;

    // Update global state for other scripts
    window.currentPage = pageId;

    if (currentEl) {
        currentEl.classList.remove('visible');
        setTimeout(() => currentEl.classList.remove('active'), 300);
    }

    setTimeout(() => {
        if (newEl) {
            newEl.classList.add('active');
            void newEl.offsetWidth; // Reflow
            newEl.classList.add('visible');
            window.location.hash = pageId;
            window.scrollTo({ top: 0, behavior: 'smooth' });

            // Update nav links active state
            document.querySelectorAll('.nav-link').forEach(link => {
                if (link.dataset.page) {
                    if (link.dataset.page === pageId) {
                        link.classList.remove('text-slate-500', 'hover:text-[#131b2e]');
                        link.classList.add('text-rose-600', 'border-b-2', 'border-rose-600', 'pb-1');
                    } else {
                        link.classList.add('text-slate-500', 'hover:text-[#131b2e]');
                        link.classList.remove('text-rose-600', 'border-b-2', 'border-rose-600', 'pb-1');
                    }
                }
            });

            // Trigger page-specific renders if they exist on window
            if (pageId === 'dashboard' && window.renderDashboardTable) window.renderDashboardTable();
            if (pageId === 'orders' && window.renderOrdersTable) window.renderOrdersTable();
            if (pageId === 'reports' && window.renderReports) window.renderReports();
            if (pageId === 'planning' && window.renderPlanningReport) window.renderPlanningReport();
            if (pageId === 'budgetReport') {
                if (window.switchBudgetTab) window.switchBudgetTab('production');
                else if (window.renderBudgetReport) window.renderBudgetReport();
            }
            if (pageId === 'detailed-report' && window.renderDetailedReport) window.renderDetailedReport();
            if (pageId === 'profile' && window.updateProfilePage) window.updateProfilePage();
            
            // Special logic for Create Order page
            if (pageId === 'create-order') {
                if (window.updateOrderCategoryDropdown) window.updateOrderCategoryDropdown();
                const role = localStorage.getItem('nevo_role') || 'user';
                const userName = localStorage.getItem('nevo_user') || '';
                const userDept = localStorage.getItem('nevo_dept') || '';
                
                const reqEl = document.getElementById('requester');
                const deptEl = document.getElementById('department');
                
                if (reqEl) {
                    let found = false;
                    for (let i = 0; i < reqEl.options.length; i++) {
                        if (reqEl.options[i].text === userName) {
                            reqEl.selectedIndex = i;
                            found = true;
                            break;
                        }
                    }
                    if (!found && userName) {
                        const opt = document.createElement('option');
                        opt.text = userName; opt.selected = true;
                        reqEl.add(opt);
                    }
                    if (role === 'user') {
                        reqEl.parentElement.classList.add('opacity-70', 'pointer-events-none');
                        reqEl.disabled = true;
                    }
                }
                
                if (deptEl) {
                    let found = false;
                    for (let i = 0; i < deptEl.options.length; i++) {
                        if (deptEl.options[i].text === userDept) {
                            deptEl.selectedIndex = i;
                            found = true;
                            break;
                        }
                    }
                    if (!found && userDept) {
                        const opt = document.createElement('option');
                        opt.text = userDept; opt.selected = true;
                        deptEl.add(opt);
                    }
                    if (role === 'user') {
                        deptEl.classList.add('opacity-70', 'pointer-events-none');
                        deptEl.disabled = true;
                    }
                }
                
                const assignmentsSection = document.getElementById('assignmentsSection');
                if (assignmentsSection) {
                    if (role === 'user') assignmentsSection.classList.add('hidden');
                    else assignmentsSection.classList.remove('hidden');
                }
            }
        }
    }, currentEl ? 300 : 0);
}

/**
 * Initialize Glassmorphism effects
 */
export function initPremiumEffects() {
    // Add intersection observer for reveal animations
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
