/* 
  AUTH SERVICE
  Unified Role-Based Access Control (RBAC) & Session Management
*/

import { auth, onAuthStateChanged, signOut } from "./firebase-service.js";

export const PERMISSION_FIELD_MAP = {
    view: 'orders_view',
    costs: 'orders_edit_costs',
    status: 'orders_edit_status',
    orderCode: 'orders_edit_title',
    customer: 'orders_edit_requester',
    product: 'orders_edit_category',
    quantity: 'orders_edit_title',
    orderDate: 'orders_edit_orderDate',
    deadline: 'orders_edit_deadline',
    deploymentDate: 'orders_edit_deployDate',
    deployDate: 'orders_edit_deployDate',
    category: 'orders_edit_category',
    dept: 'orders_edit_department',
    department: 'orders_edit_department',
    note: 'orders_edit_note',
    stylist: 'orders_edit_stylist',
    video: 'orders_edit_video',
    assignedVideo: 'orders_edit_video',
    photo: 'orders_edit_photo',
    assignedPhoto: 'orders_edit_photo',
    design: 'orders_edit_design',
    assignedDesign: 'orders_edit_design',
    requester: 'orders_edit_requester',
    title: 'orders_edit_title',
    content: 'orders_edit_title',
    delete: 'orders_delete',
    create: 'orders_create',
    planning_view: 'planning_view',
    planning_edit: 'planning_edit',
    planning_delete: 'planning_delete',
    finance_view: 'finance_view',
    finance_edit: 'finance_edit',
    reports_view: 'reports_view',
    schedule_view: 'schedule_view',
    schedule_create_own: 'schedule_create_own',
    schedule_manage_all: 'schedule_manage_all',
    admin_access: 'admin_access',
    model_view: 'model_view',
    model_edit: 'model_edit',
    products_view: 'products_view',
    products_edit: 'products_edit'
};

export const ORDER_EDIT_PERMS = [
    'orders_edit_requester', 'orders_edit_department', 'orders_edit_category',
    'orders_edit_title', 'orders_edit_note', 'orders_edit_orderDate',
    'orders_edit_deployDate', 'orders_edit_deadline', 'orders_edit_stylist',
    'orders_edit_video', 'orders_edit_photo', 'orders_edit_design',
    'orders_edit_status', 'orders_edit_costs'
];

export function checkAuth() {
    if (localStorage.getItem('nevo_logged_in') !== 'true') {
        window.location.replace('login.html');
        return false;
    }
    return true;
}

export function initAuthGuard(onSuccess) {
    if (!checkAuth()) return;

    if (auth) {
        onAuthStateChanged(auth, (user) => {
            if (user) {
                if (onSuccess) onSuccess(user);
            } else {
                const sessionUser = localStorage.getItem('nevo_user');
                if (!sessionUser) {
                    performLogout();
                } else if (onSuccess) {
                    onSuccess({ displayName: sessionUser });
                }
            }
        });
    } else if (onSuccess) {
        onSuccess(getCurrentUser());
    }
}

export function getCurrentUser() {
    return {
        name: localStorage.getItem('nevo_user') || '',
        role: localStorage.getItem('nevo_role') || 'user',
        dept: localStorage.getItem('nevo_dept') || '',
        empId: localStorage.getItem('nevo_empId') || '',
        email: localStorage.getItem('nevo_email') || '',
        phone: localStorage.getItem('nevo_phone') || ''
    };
}

export function getRoleDisplayName(roleSlug) {
    const r = String(roleSlug || 'user').toLowerCase();
    if (window.appRoles) {
        const matched = findRoleConfig(r);
        if (matched?.name) return matched.name;
    }
    const map = {
        admin: 'Quản trị viên hệ thống',
        manager: 'Quản lý điều phối',
        viewer: 'Người xem báo cáo',
        user: 'Thành viên dự án'
    };
    return map[r] || roleSlug || 'Thành viên';
}

function findRoleConfig(roleSlugLower) {
    if (!window.appRoles) return null;
    if (window.appRoles[roleSlugLower]) return window.appRoles[roleSlugLower];
    const key = Object.keys(window.appRoles).find(k => k.toLowerCase() === roleSlugLower);
    return key ? window.appRoles[key] : null;
}

export function checkPermission(field) {
    const user = getCurrentUser();
    const userRoleSlug = String(user.role || 'user').trim().toLowerCase();
    if (userRoleSlug === 'admin') return true;

    const permKey = PERMISSION_FIELD_MAP[field] || field;
    const roleData = findRoleConfig(userRoleSlug);

    if (permKey === 'orders_edit_any') {
        if (roleData?.permissions) {
            return ORDER_EDIT_PERMS.some(p => Boolean(roleData.permissions[p]));
        }
        return ['manager', 'user', 'member', 'thành viên'].includes(userRoleSlug);
    }

    if (roleData?.permissions && roleData.permissions[permKey] !== undefined) {
        return Boolean(roleData.permissions[permKey]);
    }

    // Safe defaults when Firestore role document hasn't loaded or lacks a newly added permission key
    if (userRoleSlug === 'viewer') {
        return ['orders_view', 'planning_view', 'finance_view', 'reports_view', 'schedule_view', 'products_view'].includes(permKey);
    }
    if (userRoleSlug === 'manager') {
        const deniedForManager = ['admin_access', 'orders_delete'];
        return !deniedForManager.includes(permKey);
    }
    if (userRoleSlug === 'user' || userRoleSlug === 'member' || userRoleSlug === 'thành viên') {
        return [
            'orders_view', 'orders_create',
            'orders_edit_title', 'orders_edit_category', 'orders_edit_deadline', 'orders_edit_note',
            'reports_view', 'schedule_view', 'schedule_create_own', 'products_view'
        ].includes(permKey);
    }
    if (userRoleSlug && ['orders_view', 'schedule_view', 'schedule_create_own', 'reports_view', 'products_view'].includes(permKey)) {
        return true;
    }
    return false;
}

export async function performLogout() {
    const savedTheme = localStorage.getItem('nevo_theme');
    const keysToRemove = [
        'nevo_logged_in', 'nevo_user', 'nevo_user_name', 'nevo_role',
        'nevo_dept', 'nevo_empId', 'nevo_email', 'nevo_phone', 'nevo_admin_access'
    ];
    keysToRemove.forEach(k => localStorage.removeItem(k));
    if (savedTheme) localStorage.setItem('nevo_theme', savedTheme);
    try {
        if (auth) await signOut(auth);
    } catch (e) {
        console.warn('SignOut warning:', e);
    }
    window.location.replace('login.html');
}

export const hasPermission = checkPermission;

if (typeof window !== 'undefined') {
    window.checkPermission = checkPermission;
    window.hasPermission = checkPermission;
    window.getRoleDisplayName = getRoleDisplayName;
    window.performLogout = performLogout;
}
