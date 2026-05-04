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
    // Delegate to the comprehensive global version if available (defined in index.html)
    if (typeof window.checkPermission === 'function' && window.checkPermission !== checkPermission) {
        return window.checkPermission(field);
    }

    // Fallback: basic permission check if global version not yet loaded
    const user = getCurrentUser();
    const userRoleSlug = user.role.toLowerCase();
    if (userRoleSlug === 'admin') return true;
    
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

    if (window.appRoles && window.appRoles[userRoleSlug]) {
        const roleData = window.appRoles[userRoleSlug];
        if (roleData.permissions && roleData.permissions[permKey] !== undefined) {
            return !!roleData.permissions[permKey];
        }
    }
    return false;
}

// DO NOT overwrite window.checkPermission here — the comprehensive version
// in index.html (regular <script>) must remain the authoritative global.
