/* 
  AUTH SERVICE
  Permissions and Access Control
*/

export function checkAuth() {
    if (localStorage.getItem('nevo_logged_in') !== 'true') {
        window.location.replace('login.html');
        return false;
    }
    return true;
}

export function getCurrentUser() {
    return {
        name: localStorage.getItem('nevo_user') || '',
        role: localStorage.getItem('nevo_role') || 'user',
        dept: localStorage.getItem('nevo_dept') || '',
        empId: localStorage.getItem('nevo_empId') || ''
    };
}

export function checkPermission(field) {
    const user = getCurrentUser();
    const userRoleSlug = user.role.toLowerCase();
    
    // Permission map based on the existing logic
    const permissionMap = {
        'view': 'orders_view',
        'costs': 'orders_edit_costs',
        'status': 'orders_edit_status',
        'delete': 'orders_delete',
        'create': 'orders_create',
        'planning_view': 'planning_view',
        'planning_edit': 'planning_edit',
        'finance_view': 'finance_view',
        'finance_edit': 'finance_edit',
        'reports_view': 'reports_view',
        'admin_access': 'admin_access'
    };

    const permKey = permissionMap[field] || field;

    // Use global appRoles if available, otherwise fallback
    if (window.appRoles && window.appRoles[userRoleSlug]) {
        const roleData = window.appRoles[userRoleSlug];
        if (roleData.permissions && roleData.permissions[permKey] !== undefined) {
            return !!roleData.permissions[permKey];
        }
    }

    // Fallbacks
    if (userRoleSlug === 'admin') return true;
    if (userRoleSlug === 'viewer') return ['orders_view', 'planning_view', 'finance_view', 'reports_view'].includes(permKey);
    
    if (userRoleSlug === 'manager') {
        const deniedForManager = ['admin_access', 'orders_delete'];
        return !deniedForManager.includes(permKey);
    }

    if (['user', 'member', 'thành viên'].includes(userRoleSlug)) {
        const allowedForUser = ['orders_view', 'orders_create', 'planning_view', 'reports_view'];
        return allowedForUser.includes(permKey);
    }

    return false;
}

window.checkPermission = checkPermission; // Export to global for legacy inline calls
