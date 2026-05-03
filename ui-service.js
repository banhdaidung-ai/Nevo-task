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
    
    if (currentEl === newEl) return;

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
