/*
  SCHEDULE & MEMBER PERFORMANCE MANAGER
  Interactive team work calendar, Firestore realtime sync (`schedule_tasks`),
  14-metric member measurement, Chart.js analytics, and Excel import/export.
*/

import {
    db, collection, addDoc, doc, updateDoc, deleteDoc,
    onSnapshot, serverTimestamp
} from "./firebase-service.js";
import { checkPermission, getCurrentUser } from "./auth-service.js";
import { showToast } from "./ui-service.js";

export const SCHEDULE_CATEGORIES = [
    "Hình ảnh AI",
    "Quay / dựng video",
    "Thiết kế",
    "Chụp / hậu kỳ ảnh",
    "Styling mixmatch",
    "Nội dung / kịch bản",
    "Họp / điều phối",
    "Khác"
];

export const SCHEDULE_SOURCES = ["Trong KH tháng", "Việc phát sinh"];

export const SCHEDULE_TIME_SLOTS = [
    "08:00–10:00",
    "10:00–12:00",
    "13:00–15:00",
    "15:00–17:00",
    "08:00–12:00",
    "13:00–17:00",
    "Cả ngày",
    "Linh hoạt"
];

export const SCHEDULE_PRIORITIES = ["Cao", "Trung bình", "Thấp"];

export const SCHEDULE_UNITS = [
    "Ảnh",
    "Video",
    "Thiết kế / ấn phẩm",
    "Bài viết / kịch bản",
    "Trang / slide",
    "Việc",
    "Khác"
];

export const SCHEDULE_STATUSES = [
    "Chưa bắt đầu",
    "Đang làm",
    "Hoàn thành",
    "Chưa xong — dời sang ngày khác",
    "Tạm dừng / chờ duyệt"
];

export const SCHEDULE_APPROVALS = ["Chưa duyệt", "Đạt", "Cần sửa lại"];

const WEEKDAY_NAMES = ["Chủ Nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];

const NAME_ALIAS_MAP = {
    "khánh duy": "Duy Khánh",
    "duy khánh": "Duy Khánh",
    "khánh thu": "Khánh Thu",
    "thuận": "Thuận Design",
    "thuận design": "Thuận Design"
};

const CATEGORY_COLORS = {
    "Hình ảnh AI": { bar: "bg-indigo-500", badge: "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/50 dark:text-indigo-300 dark:border-indigo-800" },
    "Quay / dựng video": { bar: "bg-rose-500", badge: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800" },
    "Thiết kế": { bar: "bg-amber-500", badge: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800" },
    "Chụp / hậu kỳ ảnh": { bar: "bg-sky-500", badge: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:border-sky-800" },
    "Styling mixmatch": { bar: "bg-pink-500", badge: "bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-950/50 dark:text-pink-300 dark:border-pink-800" },
    "Nội dung / kịch bản": { bar: "bg-emerald-500", badge: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800" },
    "Họp / điều phối": { bar: "bg-violet-500", badge: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/50 dark:text-violet-300 dark:border-violet-800" },
    "Khác": { bar: "bg-slate-400", badge: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700" }
};

const state = {
    tasks: [],
    currentView: "week",
    anchorDate: new Date(),
    myTasksOnly: false,
    charts: { workload: null, daily: null },
    unsubTasks: null,
    dialogsInitialized: false
};

window.allScheduleTasks = [];
window.currentScheduleView = "week";

// ===== PURE HELPERS & PARSERS =====

/** Escape HTML special characters before interpolating user strings. */
function escapeHtml(val) {
    return String(val ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** Validate URL uses http(s) before rendering anchor hrefs. */
function safeUrl(raw) {
    const str = String(raw || "").trim();
    if (!str) return "";
    try {
        const parsed = new URL(str);
        return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
    } catch {
        return "";
    }
}

/** Format a local Date object as YYYY-MM-DD. */
function toYMD(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, "0");
    const d = String(dateObj.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/** Format YYYY-MM-DD as DD/MM/YYYY for Vietnamese display and Excel export. */
function formatDisplayDate(ymd) {
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "";
    const [y, m, d] = ymd.split("-");
    return `${d}/${m}/${y}`;
}

/** Normalize Date, DD/MM/YYYY, YYYY-MM-DD, Excel serial, or Timestamp to YYYY-MM-DD. */
function normalizeDateYMD(val) {
    if (!val && val !== 0) return "";
    if (typeof val === "object" && typeof val.toDate === "function") {
        return toYMD(val.toDate());
    }
    if (val instanceof Date && !isNaN(val.getTime())) {
        return toYMD(val);
    }
    if (typeof val === "number" && val > 20000 && val < 80000) {
        const utcDays = Math.floor(val - 25569);
        const dt = new Date(utcDays * 86400 * 1000);
        return toYMD(new Date(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
    }
    const str = String(val).trim();
    if (!str) return "";
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
        return str.slice(0, 10);
    }
    const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) {
        return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
    }
    return "";
}

/** Return Vietnamese weekday name for a YYYY-MM-DD date string. */
function getWeekdayLabel(ymd) {
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "";
    const [y, m, d] = ymd.split("-").map(Number);
    return WEEKDAY_NAMES[new Date(y, m - 1, d).getDay()] || "";
}

/** Parse numeric hours supporting Vietnamese comma decimals (e.g. "1,5" -> 1.5). */
function parseHours(val) {
    if (typeof val === "number") return Number.isFinite(val) && val >= 0 ? Math.round(val * 100) / 100 : 0;
    const str = String(val || "").trim().replace(",", ".");
    if (!str) return 0;
    const num = parseFloat(str);
    return Number.isFinite(num) && num >= 0 ? Math.round(num * 100) / 100 : 0;
}

/** Parse quantity supporting raw fractions/approx strings (e.g. "30/80" -> 30, "~80" -> 80). */
function parseQty(val) {
    if (typeof val === "number") return Number.isFinite(val) && val >= 0 ? val : 0;
    const str = String(val || "").trim();
    if (!str) return 0;
    const fracMatch = str.match(/^~?\s*(\d+(?:[.,]\d+)?)\s*\//);
    if (fracMatch) {
        const n = parseFloat(fracMatch[1].replace(",", "."));
        return Number.isFinite(n) ? n : 0;
    }
    const clean = str.replace(/^[~≈\s]+/, "").replace(",", ".");
    const num = parseFloat(clean);
    return Number.isFinite(num) && num >= 0 ? num : 0;
}

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

function formatNum(n) {
    const r = round2(n);
    return Number.isInteger(r) ? String(r) : r.toLocaleString("vi-VN", { maximumFractionDigits: 2 });
}

/** Map Google Sheet nicknames or raw names to canonical user display names. */
function canonicalName(rawName) {
    const trimmed = String(rawName || "").trim();
    if (!trimmed) return "";
    const lower = trimmed.toLowerCase();
    if (NAME_ALIAS_MAP[lower]) return NAME_ALIAS_MAP[lower];
    const matched = (window.allUsersData || []).find(
        u => (u.name || "").trim().toLowerCase() === lower
    );
    return matched ? matched.name.trim() : trimmed;
}

/** Resolve user profile metadata (name, empId, dept, role, initials) by name. */
function resolveMemberInfo(rawName) {
    const name = canonicalName(rawName);
    const users = window.allUsersData || [];
    const user = users.find(u => (u.name || "").trim().toLowerCase() === name.toLowerCase());
    const initials = name
        ? name.split(/\s+/).filter(Boolean).map(p => p[0]).join("").slice(0, 2).toUpperCase()
        : "??";
    return {
        name,
        empId: user?.empId || user?.id || "",
        dept: user?.dept || user?.department || "Chưa phân phòng",
        role: user?.role || "user",
        initials
    };
}

/** Compute Monday..Sunday Date objects for the week containing baseDate. */
function getWeekDates(baseDate) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const cur = new Date(d);
        cur.setDate(d.getDate() + i);
        dates.push(cur);
    }
    return dates;
}

/** True when task has a past YYYY-MM-DD deadline and is not yet completed. */
function isOverdue(task, todayYMD) {
    return Boolean(
        task.deadline &&
        /^\d{4}-\d{2}-\d{2}$/.test(task.deadline) &&
        task.deadline < todayYMD &&
        task.status !== "Hoàn thành"
    );
}

/** True when task deadline is within [today, today + 7 days] and not yet completed. */
function isDueSoon(task, todayYMD, plus7YMD) {
    return Boolean(
        task.deadline &&
        /^\d{4}-\d{2}-\d{2}$/.test(task.deadline) &&
        task.deadline >= todayYMD &&
        task.deadline <= plus7YMD &&
        task.status !== "Hoàn thành"
    );
}

function isOnTime(task) {
    return Boolean(
        task.status === "Hoàn thành" &&
        task.completedDate &&
        task.deadline &&
        /^\d{4}-\d{2}-\d{2}$/.test(task.deadline) &&
        task.completedDate <= task.deadline
    );
}

function isLateCompleted(task) {
    return Boolean(
        task.status === "Hoàn thành" &&
        task.completedDate &&
        task.deadline &&
        /^\d{4}-\d{2}-\d{2}$/.test(task.deadline) &&
        task.completedDate > task.deadline
    );
}

// ===== RBAC HELPERS =====

function canViewSchedule() {
    return checkPermission("schedule_view") || checkPermission("reports_view");
}

function canManageAll() {
    return checkPermission("schedule_manage_all");
}

function canCreateOwn() {
    return checkPermission("schedule_create_own") || canManageAll();
}

function isTaskOwner(task) {
    const me = getCurrentUser();
    if (!me.name && !me.empId) return false;
    if (task.assigneeId && me.empId && task.assigneeId === me.empId) return true;
    const myCanon = canonicalName(me.name).toLowerCase();
    const taskCanon = canonicalName(task.assignee).toLowerCase();
    if (myCanon && taskCanon && myCanon === taskCanon) return true;
    if (myCanon && task.createdBy && canonicalName(task.createdBy).toLowerCase() === myCanon) return true;
    return false;
}

function canEditTask(task) {
    if (canManageAll()) return true;
    if (!canCreateOwn()) return false;
    return isTaskOwner(task);
}

// ===== FIRESTORE SYNC =====

function startTasksListener() {
    if (!db || state.unsubTasks) return;
    const tasksRef = collection(db, "schedule_tasks");
    state.unsubTasks = onSnapshot(tasksRef, (snapshot) => {
        const list = [];
        snapshot.forEach(docSnap => {
            const raw = docSnap.data();
            const dateYMD = normalizeDateYMD(raw.date);
            const plannedHours = parseHours(raw.plannedHours);
            const actualHours = parseHours(raw.actualHours);
            const plannedQty = raw.plannedQty !== undefined && raw.plannedQty !== null
                ? parseQty(raw.plannedQty)
                : parseQty(raw.plannedQtyRaw);
            const actualQty = raw.actualQty !== undefined && raw.actualQty !== null
                ? parseQty(raw.actualQty)
                : parseQty(raw.actualQtyRaw);
            const assignee = canonicalName(raw.assignee);
            const memberInfo = resolveMemberInfo(assignee);
            list.push({
                id: docSnap.id,
                ...raw,
                date: dateYMD,
                assignee,
                assigneeId: raw.assigneeId || memberInfo.empId || "",
                department: raw.department || memberInfo.dept || "",
                category: raw.category || "Khác",
                source: raw.source || "Trong KH tháng",
                timeSlot: raw.timeSlot || "Linh hoạt",
                deadline: normalizeDateYMD(raw.deadline),
                deadlineNote: raw.deadlineNote || (!normalizeDateYMD(raw.deadline) ? (raw.deadline || "") : ""),
                priority: raw.priority || "Trung bình",
                plannedHours,
                actualHours,
                hoursDiff: round2(actualHours - plannedHours),
                plannedQtyRaw: raw.plannedQtyRaw !== undefined ? String(raw.plannedQtyRaw) : (raw.plannedQty ? String(raw.plannedQty) : ""),
                plannedQty,
                actualQtyRaw: raw.actualQtyRaw !== undefined ? String(raw.actualQtyRaw) : (raw.actualQty ? String(raw.actualQty) : ""),
                actualQty,
                status: raw.status || "Chưa bắt đầu",
                progress: Number.isFinite(Number(raw.progress)) ? Number(raw.progress) : (raw.status === "Hoàn thành" ? 100 : 0),
                completedDate: normalizeDateYMD(raw.completedDate),
                approvalStatus: raw.approvalStatus || "Chưa duyệt",
                resultLink: raw.resultLink || "",
                blocker: raw.blocker || "",
                nextStep: raw.nextStep || ""
            });
        });

        list.sort((a, b) => {
            if (a.date !== b.date) return (a.date || "").localeCompare(b.date || "");
            return (a.timeSlot || "").localeCompare(b.timeSlot || "");
        });

        state.tasks = list;
        window.allScheduleTasks = list;
        refreshScheduleFilters();
        if (window.currentPage === "reports") {
            renderReports();
        }
    }, (err) => {
        console.error("[ScheduleManager] Firestore sync error:", err);
    });
}

// ===== FILTERS & DATA SELECTION =====

function getFilterState() {
    const dept = document.getElementById("scheduleDeptFilter")?.value || "all";
    const user = document.getElementById("scheduleUserFilter")?.value || "all";
    const category = document.getElementById("scheduleCategoryFilter")?.value || "all";
    const status = document.getElementById("scheduleStatusFilter")?.value || "all";
    const source = document.getElementById("scheduleSourceFilter")?.value || "all";
    const search = (document.getElementById("scheduleSearchInput")?.value || "").trim().toLowerCase();
    const kpiScope = document.getElementById("kpiScopeSelect")?.value || "month";
    return { dept, user, category, status, source, search, kpiScope };
}

/** Populate department, member, category, and linked-order filter dropdowns. */
export function refreshScheduleFilters() {
    const deptEl = document.getElementById("scheduleDeptFilter");
    const userEl = document.getElementById("scheduleUserFilter");
    const catEl = document.getElementById("scheduleCategoryFilter");
    const modalAssigneeEl = document.getElementById("taskAssignee");
    const ordersDatalist = document.getElementById("scheduleOrdersDatalist");

    // 1. Departments
    if (deptEl) {
        const prev = deptEl.value || "all";
        const deptSet = new Set();
        (window.departmentsData || []).forEach(d => d.name && deptSet.add(d.name));
        (window.allUsersData || []).forEach(u => (u.dept || u.department) && deptSet.add(u.dept || u.department));
        state.tasks.forEach(t => t.department && t.department !== "Chưa phân phòng" && deptSet.add(t.department));
        const depts = Array.from(deptSet).sort((a, b) => a.localeCompare(b, "vi"));
        deptEl.innerHTML = `<option value="all">Tất cả phòng ban</option>` +
            depts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
        if (prev && (prev === "all" || deptSet.has(prev))) deptEl.value = prev;
    }

    // 2. Members (merge Firestore users + task assignees)
    const memberMap = new Map();
    (window.allUsersData || []).forEach(u => {
        if (!u.name) return;
        const name = canonicalName(u.name);
        memberMap.set(name.toLowerCase(), {
            name,
            dept: u.dept || u.department || "Chưa phân phòng"
        });
    });
    state.tasks.forEach(t => {
        if (!t.assignee) return;
        const key = t.assignee.toLowerCase();
        if (!memberMap.has(key)) {
            memberMap.set(key, { name: t.assignee, dept: t.department || "Chưa phân phòng" });
        }
    });
    const allMembers = Array.from(memberMap.values()).sort((a, b) => a.name.localeCompare(b.name, "vi"));

    if (userEl) {
        const prev = userEl.value || "all";
        const selectedDept = deptEl?.value || "all";
        const visibleMembers = selectedDept === "all"
            ? allMembers
            : allMembers.filter(m => m.dept === selectedDept);
        userEl.innerHTML = `<option value="all">Tất cả thành viên</option>` +
            visibleMembers.map(m => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)}</option>`).join("");
        if (prev === "all" || visibleMembers.some(m => m.name === prev)) {
            userEl.value = prev;
        }
    }

    if (modalAssigneeEl) {
        const prev = modalAssigneeEl.value;
        modalAssigneeEl.innerHTML = allMembers
            .map(m => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)} (${escapeHtml(m.dept)})</option>`)
            .join("");
        if (prev && allMembers.some(m => m.name === prev)) modalAssigneeEl.value = prev;
    }

    const bulkAssigneeEl = document.getElementById("bulkAssignee");
    if (bulkAssigneeEl) {
        const prev = bulkAssigneeEl.value;
        bulkAssigneeEl.innerHTML = allMembers
            .map(m => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)} (${escapeHtml(m.dept)})</option>`)
            .join("");
        if (prev && allMembers.some(m => m.name === prev)) bulkAssigneeEl.value = prev;
    }

    // 3. Categories
    if (catEl && catEl.options.length <= 1) {
        catEl.innerHTML = `<option value="all">Tất cả hạng mục</option>` +
            SCHEDULE_CATEGORIES.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    }

    // 4. Orders Datalist
    if (ordersDatalist) {
        ordersDatalist.innerHTML = (window.allOrdersData || [])
            .slice(0, 120)
            .map(o => `<option value="${escapeHtml(o.code || "")}">${escapeHtml(o.title || "")}</option>`)
            .join("");
    }
}

function getFilteredTasks(extraOpts = {}) {
    const f = getFilterState();
    const todayYMD = toYMD(new Date());
    const ignoreSearch = Boolean(extraOpts.ignoreSearch);

    return state.tasks.filter(t => {
        if (f.source === "orders") return false;
        if (f.dept !== "all" && t.department !== f.dept) return false;
        if (f.user !== "all" && canonicalName(t.assignee) !== canonicalName(f.user)) return false;
        if (f.category !== "all" && t.category !== f.category) return false;
        if (f.status !== "all") {
            if (f.status === "Quá hạn") {
                if (!isOverdue(t, todayYMD)) return false;
            } else if (t.status !== f.status) {
                return false;
            }
        }
        if (!ignoreSearch && f.search) {
            const hay = `${t.title} ${t.description} ${t.blocker} ${t.nextStep} ${t.linkedOrderCode || ""} ${t.assignee}`.toLowerCase();
            if (!hay.includes(f.search)) return false;
        }
        return true;
    });
}

function mapOrderCategoryToSchedule(orderCat) {
    const c = String(orderCat || "").trim().toLowerCase();
    if (c.includes("video") || c.includes("live")) return "Quay / dựng video";
    if (c.includes("ảnh") || c.includes("photo")) return "Chụp / hậu kỳ ảnh";
    if (c.includes("thiết kế") || c.includes("design")) return "Thiết kế";
    return "Khác";
}

function getAssignedActiveOrders(memberName, includeAllTeam = false) {
    const canonMember = canonicalName(memberName);
    const closedStatuses = new Set(["Hoàn thành", "Hủy", "Từ chối"]);
    return (window.allOrdersData || []).filter(o => {
        if (closedStatuses.has(o.status)) return false;
        if (includeAllTeam) return true;
        const assignees = getOrderAssignees(o);
        return canonMember && assignees.includes(canonMember);
    });
}

function isOrderLinkedInDay(order, dayTasks) {
    const code = String(order?.code || "").replace(/^#/, "").trim().toUpperCase();
    if (!code) return false;
    return dayTasks.some(t => String(t.linkedOrderCode || "").replace(/^#/, "").trim().toUpperCase() === code);
}

export function jumpToOrderByCode(orderCode, event) {
    if (event) event.stopPropagation();
    const clean = String(orderCode || "").replace(/^#/, "").trim().toUpperCase();
    if (!clean) return;
    const found = (window.allOrdersData || []).find(
        o => String(o.code || "").replace(/^#/, "").trim().toUpperCase() === clean
    );
    if (found && typeof window.jumpToOrder === "function") {
        window.jumpToOrder(found.id);
    } else {
        showToast("Không tìm thấy đơn", `Không thấy mã đơn #${clean} trong danh sách đơn hàng.`, "info", "info");
    }
}

export function openScheduleFromOrder(orderId, dateYMD, memberName, event) {
    if (event) event.stopPropagation();
    const order = (window.allOrdersData || []).find(o => o.id === orderId);
    if (!order) return;
    const normFn = window._normalizeDateToYMD || normalizeDateYMD;
    openScheduleTaskModal(null, {
        date: dateYMD || normFn(order.deployDate) || normFn(order.deadline) || toYMD(new Date()),
        assignee: memberName || canonicalName(getCurrentUser().name),
        title: order.title || `Đơn #${order.code || ""}`,
        category: mapOrderCategoryToSchedule(order.category),
        deadline: normFn(order.deadline),
        linkedOrderCode: order.code || "",
        description: order.content || ""
    });
}

function getOrderAssignees(order) {
    return [order.assignedVideo, order.assignedPhoto, order.assignedDesign, order.stylist]
        .filter(n => n && n !== "-")
        .map(canonicalName);
}

function getFilteredOrdersForDate(dateYMD) {
    const f = getFilterState();
    if (f.source === "tasks") return [];
    const normFn = window._normalizeDateToYMD || normalizeDateYMD;

    return (window.allOrdersData || []).filter(o => {
        const d = normFn(o.deployDate) || normFn(o.deadline) || "";
        if (dateYMD && d !== dateYMD) return false;
        const assignees = getOrderAssignees(o);
        if (f.user !== "all" && !assignees.includes(canonicalName(f.user))) return false;
        if (f.dept !== "all") {
            const matchesMemberDept = assignees.some(a => resolveMemberInfo(a).dept === f.dept);
            if (o.department !== f.dept && !matchesMemberDept) return false;
        }
        if (f.status !== "all") {
            if (f.status === "Hoàn thành" && o.status !== "Hoàn thành") return false;
            if (f.status === "Đang làm" && o.status !== "Đang xử lý") return false;
            if (f.status === "Chưa bắt đầu" && o.status !== "Chờ duyệt") return false;
        }
        if (f.search) {
            const hay = `${o.code || ""} ${o.title || ""} ${o.content || ""}`.toLowerCase();
            if (!hay.includes(f.search)) return false;
        }
        return true;
    });
}

function mapOrderCategoryToSchedule(orderCat) {
    const c = String(orderCat || "").trim().toLowerCase();
    if (c.includes("video") || c.includes("live")) return "Quay / dựng video";
    if (c.includes("ảnh") || c.includes("photo")) return "Chụp / hậu kỳ ảnh";
    if (c.includes("thiết kế") || c.includes("design")) return "Thiết kế";
    return "Khác";
}

function getAssignedActiveOrders(memberName, includeAllTeam = false) {
    const canonMember = canonicalName(memberName);
    const closedStatuses = new Set(["Hoàn thành", "Hủy", "Từ chối"]);
    return (window.allOrdersData || []).filter(o => {
        if (closedStatuses.has(o.status)) return false;
        if (includeAllTeam) return true;
        const assignees = getOrderAssignees(o);
        return canonMember && assignees.includes(canonMember);
    });
}

function isOrderLinkedInDay(order, dayTasks) {
    const code = String(order?.code || "").replace(/^#/, "").trim().toUpperCase();
    if (!code) return false;
    return dayTasks.some(t => String(t.linkedOrderCode || "").replace(/^#/, "").trim().toUpperCase() === code);
}

export function jumpToOrderByCode(orderCode, event) {
    if (event) event.stopPropagation();
    const clean = String(orderCode || "").replace(/^#/, "").trim().toUpperCase();
    if (!clean) return;
    const found = (window.allOrdersData || []).find(
        o => String(o.code || "").replace(/^#/, "").trim().toUpperCase() === clean
    );
    if (found && typeof window.jumpToOrder === "function") {
        window.jumpToOrder(found.id);
    } else {
        showToast("Không tìm thấy đơn", `Không thấy mã đơn #${clean} trong danh sách đơn hàng.`, "info", "info");
    }
}

export function openScheduleFromOrder(orderId, dateYMD, memberName, event) {
    if (event) event.stopPropagation();
    const order = (window.allOrdersData || []).find(o => o.id === orderId);
    if (!order) return;
    const normFn = window._normalizeDateToYMD || normalizeDateYMD;
    openScheduleTaskModal(null, {
        date: dateYMD || normFn(order.deployDate) || normFn(order.deadline) || toYMD(new Date()),
        assignee: memberName || canonicalName(getCurrentUser().name),
        title: order.title || `Đơn #${order.code || ""}`,
        category: mapOrderCategoryToSchedule(order.category),
        deadline: normFn(order.deadline),
        linkedOrderCode: order.code || "",
        description: order.content || ""
    });
}

function getStatusBadgeStyle(status, overdue = false) {
    if (overdue) {
        return {
            card: "bg-rose-50/90 border-rose-500 text-rose-950 dark:bg-rose-950/50 dark:text-rose-100 dark:border-rose-500",
            pill: "bg-rose-600 text-white",
            dot: "bg-rose-500"
        };
    }
    switch (status) {
        case "Hoàn thành":
            return {
                card: "bg-emerald-50/85 border-emerald-500 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100 dark:border-emerald-500",
                pill: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/70 dark:text-emerald-200",
                dot: "bg-emerald-500"
            };
        case "Đang làm":
            return {
                card: "bg-amber-50/85 border-amber-500 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100 dark:border-amber-500",
                pill: "bg-amber-100 text-amber-800 dark:bg-amber-900/70 dark:text-amber-200",
                dot: "bg-amber-500"
            };
        case "Chưa xong — dời sang ngày khác":
            return {
                card: "bg-orange-50/85 border-orange-400 text-orange-950 dark:bg-orange-950/40 dark:text-orange-100 dark:border-orange-500",
                pill: "bg-orange-100 text-orange-800 dark:bg-orange-900/70 dark:text-orange-200",
                dot: "bg-orange-500"
            };
        case "Tạm dừng / chờ duyệt":
            return {
                card: "bg-purple-50/85 border-purple-400 text-purple-950 dark:bg-purple-950/40 dark:text-purple-100 dark:border-purple-500",
                pill: "bg-purple-100 text-purple-800 dark:bg-purple-900/70 dark:text-purple-200",
                dot: "bg-purple-500"
            };
        default:
            return {
                card: "bg-slate-50 border-slate-300 text-slate-800 dark:bg-slate-800/80 dark:text-slate-100 dark:border-slate-600",
                pill: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
                dot: "bg-slate-400"
            };
    }
}

// ===== SCHEDULE VIEW SWITCHING & NAVIGATION =====

function updatePeriodLabel() {
    const labelEl = document.getElementById("schedulePeriodLabel");
    if (!labelEl) return;
    if (state.currentView === "week") {
        const days = getWeekDates(state.anchorDate);
        const start = days[0];
        const end = days[6];
        labelEl.textContent = `Tuần ${start.getDate()}/${start.getMonth() + 1} – ${end.getDate()}/${end.getMonth() + 1}/${end.getFullYear()}`;
    } else {
        labelEl.textContent = `Tháng ${state.anchorDate.getMonth() + 1} / ${state.anchorDate.getFullYear()}`;
    }
}

export function switchScheduleView(view) {
    state.currentView = view || "week";
    window.currentScheduleView = state.currentView;

    const tabs = [
        { id: "btnScheduleWeek", key: "week", cont: "weeklyScheduleContainer" },
        { id: "btnScheduleMonth", key: "month", cont: "monthlyCalendarContainer" },
        { id: "btnScheduleList", key: "list", cont: "listScheduleContainer" }
    ];

    tabs.forEach(t => {
        const btn = document.getElementById(t.id);
        const cont = document.getElementById(t.cont);
        const active = t.key === state.currentView;
        if (btn) {
            btn.classList.toggle("bg-primary", active);
            btn.classList.toggle("text-white", active);
            btn.classList.toggle("shadow-sm", active);
            btn.classList.toggle("text-slate-500", !active);
            btn.classList.toggle("hover:bg-slate-50", !active);
        }
        if (cont) cont.classList.toggle("hidden", !active);
    });

    updatePeriodLabel();
    if (state.currentView === "week") renderWeeklySchedule();
    else if (state.currentView === "month") renderMonthlyCalendar();
    else renderListSchedule();
}

export function navigateSchedulePeriod(delta) {
    if (delta === 0) {
        state.anchorDate = new Date();
    } else if (state.currentView === "week") {
        state.anchorDate = new Date(state.anchorDate.getFullYear(), state.anchorDate.getMonth(), state.anchorDate.getDate() + delta * 7);
    } else {
        state.anchorDate = new Date(state.anchorDate.getFullYear(), state.anchorDate.getMonth() + delta, 1);
    }
    renderReports();
}

export function changeWeek(delta) {
    state.anchorDate = new Date(state.anchorDate.getFullYear(), state.anchorDate.getMonth(), state.anchorDate.getDate() + delta * 7);
    renderReports();
}

export function changeMonth(delta) {
    state.anchorDate = new Date(state.anchorDate.getFullYear(), state.anchorDate.getMonth() + delta, 1);
    renderReports();
}

// ===== VIEW 1: WEEKLY MATRIX SCHEDULE =====

export function renderWeeklySchedule() {
    const headEl = document.getElementById("weeklyScheduleHead");
    const bodyEl = document.getElementById("weeklyScheduleBody");
    if (!headEl || !bodyEl) return;

    const weekDates = getWeekDates(state.anchorDate);
    const weekYmds = weekDates.map(toYMD);
    const todayYMD = toYMD(new Date());
    const f = getFilterState();
    const canAdd = canCreateOwn();
    const canManage = canManageAll();
    const me = getCurrentUser();
    const filteredTasks = getFilteredTasks();

    const dayLabels = ["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "Chủ Nhật"];
    let headHtml = `<tr class="bg-white dark:bg-slate-900">
        <th scope="col" class="py-4 px-5 text-[11px] font-black text-slate-400 uppercase tracking-[0.16em] border-b border-slate-100 dark:border-slate-800 min-w-[230px] sticky left-0 z-30 bg-white dark:bg-slate-900 shadow-[4px_0_12px_-6px_rgba(0,0,0,0.08)]">Thành viên</th>`;

    weekDates.forEach((d, idx) => {
        const ymd = weekYmds[idx];
        const isToday = ymd === todayYMD;
        headHtml += `<th scope="col" class="py-4 px-3 text-center border-b border-slate-100 dark:border-slate-800 min-w-[165px] ${isToday ? "bg-rose-50/70 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400" : "bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"}">
            <div class="text-xs font-black tracking-tight">${dayLabels[idx]}${isToday ? " · Nay" : ""}</div>
            <div class="text-[10px] font-bold opacity-55 mt-0.5">${d.getDate()}/${d.getMonth() + 1}</div>
        </th>`;
    });
    headHtml += `</tr>`;
    headEl.innerHTML = headHtml;

    // Determine member rows to display
    const memberSet = new Map();
    const addCandidate = (name) => {
        const canon = canonicalName(name);
        if (!canon || canon === "-") return;
        const info = resolveMemberInfo(canon);
        if (f.dept !== "all" && info.dept !== f.dept) return;
        if (f.user !== "all" && canon !== canonicalName(f.user)) return;
        memberSet.set(canon.toLowerCase(), info);
    };

    if (f.user !== "all") {
        addCandidate(f.user);
    } else {
        // Include members with tasks or orders this week, plus Creative/filtered dept users so empty members can receive tasks
        filteredTasks.forEach(t => { if (weekYmds.includes(t.date)) addCandidate(t.assignee); });
        weekYmds.forEach(ymd => {
            getFilteredOrdersForDate(ymd).forEach(o => getOrderAssignees(o).forEach(addCandidate));
        });
        (window.allUsersData || []).forEach(u => {
            if (f.dept !== "all" || u.dept === "Creative") addCandidate(u.name);
        });
    }

    const members = Array.from(memberSet.values()).sort((a, b) => {
        const aHas = filteredTasks.some(t => weekYmds.includes(t.date) && t.assignee === a.name);
        const bHas = filteredTasks.some(t => weekYmds.includes(t.date) && t.assignee === b.name);
        if (aHas !== bHas) return aHas ? -1 : 1;
        return a.name.localeCompare(b.name, "vi");
    });

    if (members.length === 0) {
        bodyEl.innerHTML = `<tr><td colspan="8" class="py-24 text-center text-slate-400">
            <span class="material-symbols-outlined text-5xl opacity-40 block mb-2">event_busy</span>
            <p class="text-xs font-bold uppercase tracking-widest">Không có thành viên hoặc công việc phù hợp bộ lọc</p>
        </td></tr>`;
        return;
    }

    let bodyHtml = "";
    members.forEach(member => {
        const weekMemberTasks = filteredTasks.filter(t => weekYmds.includes(t.date) && t.assignee === member.name);
        const doneCount = weekMemberTasks.filter(t => t.status === "Hoàn thành").length;
        const weekHours = round2(weekMemberTasks.reduce((sum, t) => sum + (t.plannedHours || 0), 0));
        const canAddForMember = canManage || (canAdd && canonicalName(me.name) === member.name);

        bodyHtml += `<tr class="group/row hover:bg-slate-50/40 dark:hover:bg-slate-800/30 transition-colors border-b border-slate-100 dark:border-slate-800">
            <th scope="row" class="py-4 px-5 text-left align-top bg-white dark:bg-slate-900 shadow-[4px_0_12px_-6px_rgba(0,0,0,0.08)] border-r border-slate-100 dark:border-slate-800">
                <button type="button" onclick="window.openMemberScorecard('${escapeHtml(member.name)}')" class="flex items-center gap-3 text-left w-full group/member">
                    <div class="w-10 h-10 rounded-2xl bg-gradient-to-br from-rose-50 to-indigo-50 dark:from-rose-950/60 dark:to-indigo-950/60 flex items-center justify-center text-xs font-black text-primary border border-rose-200/50 dark:border-rose-800/40 shrink-0">
                        ${escapeHtml(member.initials)}
                    </div>
                    <div class="min-w-0">
                        <p class="text-sm font-black text-slate-800 dark:text-slate-100 truncate group-hover/member:text-primary transition-colors">${escapeHtml(member.name)}</p>
                        <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider truncate">${escapeHtml(member.dept)}</p>
                        <div class="flex flex-wrap items-center gap-1.5 mt-1.5">
                            <span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">${doneCount}/${weekMemberTasks.length} việc</span>
                            <span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-300">${formatNum(weekHours)}h DK</span>
                        </div>
                    </div>
                </button>
                ${canAddForMember ? `<button type="button" onclick="window.openBulkScheduleModal({ mode: 'week', date: '${weekYmds[0]}', assignee: '${escapeHtml(member.name)}' })"
                    class="mt-2.5 w-full py-1 px-2 rounded-lg bg-rose-50/80 dark:bg-rose-950/40 text-primary hover:bg-rose-100 dark:hover:bg-rose-950/70 text-[10px] font-black flex items-center justify-center gap-1 transition-colors">
                    <span class="material-symbols-outlined text-[13px]">playlist_add</span> + Lập lịch tuần
                </button>` : ""}
            </th>`;

        weekDates.forEach((d, idx) => {
            const ymd = weekYmds[idx];
            const isToday = ymd === todayYMD;
            const dayTasks = weekMemberTasks.filter(t => t.date === ymd);
            const dayOrders = getFilteredOrdersForDate(ymd)
                .filter(o => getOrderAssignees(o).includes(member.name) && !isOrderLinkedInDay(o, dayTasks));

            let cellCards = "";
            dayTasks.forEach(t => {
                const overdue = isOverdue(t, todayYMD);
                const style = getStatusBadgeStyle(t.status, overdue);
                const editable = canEditTask(t);
                const linkHref = safeUrl(t.resultLink);
                const catStyle = CATEGORY_COLORS[t.category] || CATEGORY_COLORS["Khác"];
                const prioBadge = t.priority === "Cao" ? `<span class="text-[9px] font-black text-rose-600 dark:text-rose-400">● Cao</span>` : "";
                const linkedCodeClean = String(t.linkedOrderCode || "").replace(/^#/, "").trim();

                cellCards += `
                    <div class="mb-2 p-2.5 rounded-xl border-l-4 shadow-sm hover:shadow-md transition-all cursor-pointer ${style.card}"
                         onclick="window.openScheduleTaskModal('${escapeHtml(t.id)}')">
                        <div class="flex items-center justify-between gap-1 mb-1">
                            <span class="text-[9px] font-extrabold opacity-75 truncate">${escapeHtml(t.timeSlot || "Linh hoạt")}</span>
                            <div class="flex items-center gap-1 shrink-0">
                                ${prioBadge}
                                <button type="button" ${editable ? "" : "disabled"}
                                    title="${editable ? "Đổi nhanh trạng thái" : "Chỉ xem"}"
                                    onclick="window.quickCycleTaskStatus('${escapeHtml(t.id)}', event)"
                                    class="w-4 h-4 rounded-full flex items-center justify-center border border-current/20 hover:scale-110 transition-transform ${editable ? "" : "opacity-50 cursor-default"}">
                                    <span class="w-2 h-2 rounded-full ${style.dot}"></span>
                                </button>
                            </div>
                        </div>
                        <p class="text-[11px] font-bold leading-snug line-clamp-2 mb-1.5">${escapeHtml(t.title)}</p>
                        <div class="flex flex-wrap items-center gap-1">
                            <span class="px-1.5 py-0.5 rounded text-[9px] font-bold border ${catStyle.badge}">${escapeHtml(t.category)}</span>
                            ${linkedCodeClean ? `<button type="button" onclick="window.jumpToOrderByCode('${escapeHtml(linkedCodeClean)}', event)" title="Mở đơn hàng #${escapeHtml(linkedCodeClean)}" class="px-1.5 py-0.5 rounded text-[9px] font-black bg-rose-100/90 text-rose-700 hover:bg-rose-200 dark:bg-rose-900/60 dark:text-rose-200">#${escapeHtml(linkedCodeClean)}</button>` : ""}
                            ${t.source === "Việc phát sinh" ? `<span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100/80 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">Phát sinh</span>` : ""}
                            ${t.plannedQtyRaw ? `<span class="text-[9px] font-bold opacity-75">${escapeHtml(t.plannedQtyRaw)} ${escapeHtml(t.unit || "")}</span>` : ""}
                            ${t.plannedHours ? `<span class="text-[9px] font-bold opacity-75">· ${formatNum(t.plannedHours)}h</span>` : ""}
                            ${linkHref ? `<a href="${escapeHtml(linkHref)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="Mở minh chứng" class="inline-flex items-center text-blue-600 dark:text-blue-400 hover:underline"><span class="material-symbols-outlined text-[13px]">link</span></a>` : ""}
                            ${t.blocker ? `<span title="Vướng mắc: ${escapeHtml(t.blocker)}" class="inline-flex items-center text-rose-600 dark:text-rose-400"><span class="material-symbols-outlined text-[13px]">warning</span></span>` : ""}
                        </div>
                    </div>`;
            });

            dayOrders.forEach(o => {
                const isDone = o.status === "Hoàn thành";
                cellCards += `
                    <div class="mb-2 p-2 rounded-xl border border-dashed ${isDone ? "border-emerald-300 bg-emerald-50/40 text-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-200" : "border-rose-300 bg-rose-50/40 text-rose-900 dark:bg-rose-950/20 dark:text-rose-200"} cursor-pointer hover:shadow-sm transition-all"
                         onclick="window.jumpToOrder('${escapeHtml(o.id)}')">
                        <div class="flex items-center justify-between text-[9px] font-black uppercase tracking-wider opacity-75">
                            <span>Đơn #${escapeHtml(o.code || "")}</span>
                            <span>${escapeHtml(o.status || "")}</span>
                        </div>
                        <p class="text-[11px] font-semibold leading-snug line-clamp-2 mt-0.5">${escapeHtml(o.title || "")}</p>
                        ${canAddForMember && !isDone ? `<button type="button" onclick="window.openScheduleFromOrder('${escapeHtml(o.id)}', '${ymd}', '${escapeHtml(member.name)}', event)"
                            class="mt-1.5 px-2 py-0.5 rounded-md bg-white/80 dark:bg-slate-800/80 border border-rose-200/70 dark:border-rose-700/60 text-[9px] font-black text-primary hover:bg-primary hover:text-white transition-colors">
                            + Lên lịch việc
                        </button>` : ""}
                    </div>`;
            });

            const addBtnHtml = canAddForMember
                ? `<div class="flex items-center gap-1 opacity-75 sm:opacity-0 group-hover/cell:opacity-100 focus-within:opacity-100 transition-opacity">
                        <button type="button" onclick="window.openScheduleTaskModal(null, { date: '${ymd}', assignee: '${escapeHtml(member.name)}' })"
                            class="flex-1 py-1.5 rounded-lg border border-dashed border-slate-200 dark:border-slate-700 text-[10px] font-bold text-slate-400 hover:text-primary hover:border-primary/40 hover:bg-rose-50/40 dark:hover:bg-rose-950/20 transition-all flex items-center justify-center gap-0.5">
                            <span class="material-symbols-outlined text-[13px]">add</span> 1 việc
                        </button>
                        <button type="button" title="Thêm nhiều việc cho ngày ${d.getDate()}/${d.getMonth() + 1}" onclick="window.openBulkScheduleModal({ mode: 'day', date: '${ymd}', assignee: '${escapeHtml(member.name)}' })"
                            class="px-2 py-1.5 rounded-lg border border-dashed border-slate-200 dark:border-slate-700 text-[10px] font-bold text-slate-400 hover:text-primary hover:border-primary/40 hover:bg-rose-50/40 dark:hover:bg-rose-950/20 transition-all flex items-center justify-center gap-0.5">
                            <span class="material-symbols-outlined text-[13px]">playlist_add</span> Nhiều
                        </button>
                   </div>`
                : "";

            bodyHtml += `<td class="py-3 px-2.5 align-top group/cell border-r border-slate-50 dark:border-slate-800/60 ${isToday ? "bg-rose-50/25 dark:bg-rose-950/15" : ""}">
                ${cellCards}
                ${addBtnHtml}
            </td>`;
        });
        bodyHtml += `</tr>`;
    });

    bodyEl.innerHTML = bodyHtml;
}

// ===== VIEW 2: MONTHLY CALENDAR =====

export function renderMonthlyCalendar() {
    const grid = document.getElementById("calendarGrid");
    const titleEl = document.getElementById("calendarMonthTitle");
    if (!grid) return;

    const year = state.anchorDate.getFullYear();
    const month = state.anchorDate.getMonth();
    if (titleEl) titleEl.textContent = `Tháng ${month + 1} / ${year}`;

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startOffset = firstDay === 0 ? 6 : firstDay - 1;
    const todayYMD = toYMD(new Date());
    const filteredTasks = getFilteredTasks();
    const canAdd = canCreateOwn();
    const f = getFilterState();
    const defaultAssignee = f.user !== "all" ? f.user : canonicalName(getCurrentUser().name);

    let html = "";
    for (let i = 0; i < startOffset; i++) {
        html += `<div class="bg-slate-50/40 dark:bg-slate-900/40 min-h-[150px] p-2 border-b border-r border-slate-100 dark:border-slate-800"></div>`;
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const ymd = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const isToday = ymd === todayYMD;
        const dayTasks = filteredTasks.filter(t => t.date === ymd);
        const dayOrders = getFilteredOrdersForDate(ymd).filter(o => !isOrderLinkedInDay(o, dayTasks));
        const totalItems = dayTasks.length + dayOrders.length;

        let itemsHtml = "";
        dayTasks.forEach(t => {
            const overdue = isOverdue(t, todayYMD);
            const style = getStatusBadgeStyle(t.status, overdue);
            const shortOwner = f.user === "all" && t.assignee ? `${t.assignee.split(/\s+/).slice(-1)[0]}: ` : "";
            itemsHtml += `
                <button type="button" onclick="window.openScheduleTaskModal('${escapeHtml(t.id)}')"
                    class="w-full text-left mb-1 px-2 py-1 rounded-lg border-l-2 text-[10px] font-semibold flex items-center gap-1.5 hover:brightness-95 transition-all ${style.card}">
                    <span class="w-1.5 h-1.5 rounded-full ${style.dot} shrink-0"></span>
                    <span class="truncate">${escapeHtml(shortOwner + t.title)}</span>
                </button>`;
        });

        dayOrders.forEach(o => {
            const dot = o.status === "Hoàn thành" ? "bg-emerald-500" : "bg-rose-500";
            itemsHtml += `
                <button type="button" onclick="window.jumpToOrder('${escapeHtml(o.id)}')"
                    class="w-full text-left mb-1 px-2 py-1 rounded-lg bg-slate-100/80 dark:bg-slate-800 border-l-2 border-rose-400 text-[10px] font-bold text-slate-600 dark:text-slate-300 flex items-center gap-1.5 hover:bg-slate-200/70 transition-all">
                    <span class="w-1.5 h-1.5 rounded-full ${dot} shrink-0"></span>
                    <span class="truncate">#${escapeHtml(o.code || "")}: ${escapeHtml(o.title || "")}</span>
                </button>`;
        });

        html += `
            <div class="bg-white dark:bg-slate-900 min-h-[150px] p-2 border-b border-r border-slate-100 dark:border-slate-800 group/day flex flex-col ${isToday ? "ring-2 ring-inset ring-primary/30 bg-rose-50/20 dark:bg-rose-950/15" : ""}">
                <div class="flex items-center justify-between mb-1.5">
                    <div class="flex items-center gap-1.5">
                        <span class="text-xs font-black ${isToday ? "bg-primary text-white w-6 h-6 flex items-center justify-center rounded-full shadow-sm" : "text-slate-500 dark:text-slate-400"}">${d}</span>
                        ${totalItems > 0 ? `<span class="text-[10px] font-bold text-slate-400">· ${totalItems} việc</span>` : ""}
                    </div>
                    ${canAdd ? `<div class="flex items-center gap-1 opacity-0 group-hover/day:opacity-100 focus-within:opacity-100 transition-all">
                        <button type="button" title="Thêm 1 việc ngày ${d}/${month + 1}" onclick="window.openScheduleTaskModal(null, { date: '${ymd}', assignee: '${escapeHtml(defaultAssignee)}' })"
                            class="w-5 h-5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-primary hover:text-white flex items-center justify-center transition-all">
                            <span class="material-symbols-outlined text-[13px]">add</span>
                        </button>
                        <button type="button" title="Thêm nhiều việc ngày ${d}/${month + 1}" onclick="window.openBulkScheduleModal({ mode: 'day', date: '${ymd}', assignee: '${escapeHtml(defaultAssignee)}' })"
                            class="w-5 h-5 rounded-md bg-rose-50 dark:bg-rose-950/60 text-primary hover:bg-primary hover:text-white flex items-center justify-center transition-all">
                            <span class="material-symbols-outlined text-[13px]">playlist_add</span>
                        </button>
                    </div>` : ""}
                </div>
                <div class="space-y-0.5 overflow-y-auto max-h-[125px] pr-0.5">
                    ${itemsHtml}
                </div>
            </div>`;
    }

    grid.innerHTML = html;
}

// ===== VIEW 3: DETAILED LIST TABLE =====

export function renderListSchedule() {
    const bodyEl = document.getElementById("listScheduleBody");
    if (!bodyEl) return;

    const year = state.anchorDate.getFullYear();
    const monthPrefix = `${year}-${String(state.anchorDate.getMonth() + 1).padStart(2, "0")}`;
    const todayYMD = toYMD(new Date());
    const canManage = canManageAll();

    const rows = getFilteredTasks().filter(t => t.date.startsWith(monthPrefix));

    if (rows.length === 0) {
        bodyEl.innerHTML = `<tr><td colspan="9" class="py-16 text-center text-slate-400 text-xs font-bold uppercase tracking-widest">Chưa có công việc nào trong tháng ${state.anchorDate.getMonth() + 1}/${year} khớp bộ lọc</td></tr>`;
        return;
    }

    bodyEl.innerHTML = rows.map(t => {
        const overdue = isOverdue(t, todayYMD);
        const editable = canEditTask(t);
        const style = getStatusBadgeStyle(t.status, overdue);
        const linkHref = safeUrl(t.resultLink);

        return `<tr class="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 border-b border-slate-100 dark:border-slate-800 transition-colors ${overdue ? "bg-rose-50/30 dark:bg-rose-950/15" : ""}">
            <th scope="row" class="py-3 px-4 text-left align-top whitespace-nowrap border-r border-slate-100 dark:border-slate-800">
                <div class="text-xs font-black text-slate-800 dark:text-slate-100">${escapeHtml(formatDisplayDate(t.date))}</div>
                <div class="text-[10px] font-bold text-slate-400">${escapeHtml(getWeekdayLabel(t.date))} · ${escapeHtml(t.timeSlot)}</div>
            </th>
            <td class="py-3 px-4 align-top min-w-[240px]">
                <button type="button" onclick="window.openScheduleTaskModal('${escapeHtml(t.id)}')" class="text-left font-bold text-xs text-slate-800 dark:text-slate-100 hover:text-primary transition-colors">
                    ${escapeHtml(t.title)}
                </button>
                ${t.description && !t.description.startsWith("http") ? `<p class="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1 mt-0.5">${escapeHtml(t.description)}</p>` : ""}
                ${t.blocker ? `<p class="text-[10px] font-bold text-rose-600 dark:text-rose-400 mt-1 flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">warning</span>${escapeHtml(t.blocker)}</p>` : ""}
            </td>
            <td class="py-3 px-3 align-top whitespace-nowrap">
                <button type="button" onclick="window.openMemberScorecard('${escapeHtml(t.assignee)}')" class="text-xs font-bold text-slate-700 dark:text-slate-200 hover:text-primary">
                    ${escapeHtml(t.assignee)}
                </button>
                <div class="text-[10px] text-slate-400">${escapeHtml(t.department)}</div>
            </td>
            <td class="py-3 px-3 align-top whitespace-nowrap">
                <span class="px-2 py-0.5 rounded-md text-[10px] font-bold border ${(CATEGORY_COLORS[t.category] || CATEGORY_COLORS["Khác"]).badge}">${escapeHtml(t.category)}</span>
                <div class="text-[10px] mt-1 font-semibold ${t.source === "Việc phát sinh" ? "text-amber-600 dark:text-amber-400" : "text-slate-400"}">${escapeHtml(t.source)}</div>
            </td>
            <td class="py-3 px-3 align-top whitespace-nowrap text-xs">
                ${t.deadline ? `<span class="font-bold ${overdue ? "text-rose-600 dark:text-rose-400" : "text-slate-700 dark:text-slate-300"}">${escapeHtml(formatDisplayDate(t.deadline))}${overdue ? " (Quá hạn)" : ""}</span>` : `<span class="text-slate-400">${escapeHtml(t.deadlineNote || "—")}</span>`}
            </td>
            <td class="py-3 px-3 align-top whitespace-nowrap">
                <div class="flex items-center gap-1 text-xs">
                    <span class="text-slate-400 font-semibold">${formatNum(t.plannedHours)}h</span>
                    <span class="text-slate-300">/</span>
                    <input type="number" step="0.25" min="0" value="${t.actualHours || ""}" placeholder="TT"
                        aria-label="Giờ thực tế cho ${escapeHtml(t.title)}"
                        ${editable ? "" : "disabled"}
                        onchange="window.inlineUpdateTaskField('${escapeHtml(t.id)}', 'actualHours', this.value)"
                        class="w-16 px-1.5 py-1 text-xs font-bold border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-right">
                </div>
            </td>
            <td class="py-3 px-3 align-top whitespace-nowrap">
                <div class="flex items-center gap-1 text-xs">
                    <span class="text-slate-400 font-semibold">${escapeHtml(t.plannedQtyRaw || "0")}</span>
                    <span class="text-slate-300">/</span>
                    <input type="text" value="${escapeHtml(t.actualQtyRaw || "")}" placeholder="TT"
                        aria-label="Số lượng thực tế cho ${escapeHtml(t.title)}"
                        ${editable ? "" : "disabled"}
                        onchange="window.inlineUpdateTaskField('${escapeHtml(t.id)}', 'actualQty', this.value)"
                        class="w-16 px-1.5 py-1 text-xs font-bold border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-right">
                </div>
            </td>
            <td class="py-3 px-3 align-top whitespace-nowrap">
                <select aria-label="Trạng thái công việc ${escapeHtml(t.title)}"
                    ${editable ? "" : "disabled"}
                    onchange="window.inlineUpdateTaskField('${escapeHtml(t.id)}', 'status', this.value)"
                    class="text-[11px] font-bold rounded-lg px-2 py-1 border border-slate-200 dark:border-slate-700 ${style.pill}">
                    ${SCHEDULE_STATUSES.map(st => `<option value="${escapeHtml(st)}" ${t.status === st ? "selected" : ""}>${escapeHtml(st)}</option>`).join("")}
                </select>
            </td>
            <td class="py-3 px-3 align-top whitespace-nowrap">
                <div class="flex items-center gap-2">
                    <select aria-label="Duyệt công việc ${escapeHtml(t.title)}"
                        ${canManage ? "" : "disabled"}
                        onchange="window.inlineUpdateTaskField('${escapeHtml(t.id)}', 'approvalStatus', this.value)"
                        class="text-[11px] font-bold rounded-lg px-2 py-1 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                        ${SCHEDULE_APPROVALS.map(ap => `<option value="${escapeHtml(ap)}" ${t.approvalStatus === ap ? "selected" : ""}>${escapeHtml(ap)}</option>`).join("")}
                    </select>
                    ${linkHref ? `<a href="${escapeHtml(linkHref)}" target="_blank" rel="noopener noreferrer" title="Xem kết quả" class="p-1.5 rounded-lg bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 hover:bg-blue-100"><span class="material-symbols-outlined text-[15px]">open_in_new</span></a>` : ""}
                </div>
            </td>
        </tr>`;
    }).join("");
}

// ===== KPI & 14-METRIC MEMBER MEASUREMENT =====

function getMeasurementTasksScope() {
    const f = getFilterState();
    const baseTasks = getFilteredTasks();
    if (f.kpiScope === "week") {
        const weekYmds = getWeekDates(state.anchorDate).map(toYMD);
        const start = weekYmds[0];
        const end = weekYmds[6];
        const label = `Tuần ${formatDisplayDate(start).slice(0, 5)} – ${formatDisplayDate(end)}`;
        return {
            label,
            tasks: baseTasks.filter(t => weekYmds.includes(t.date))
        };
    }
    const year = state.anchorDate.getFullYear();
    const month = state.anchorDate.getMonth() + 1;
    const prefix = `${year}-${String(month).padStart(2, "0")}`;
    return {
        label: `Tháng ${month}/${year}`,
        tasks: baseTasks.filter(t => t.date.startsWith(prefix))
    };
}

/** Aggregate 14+ KPI metrics for a task array. */
function computeTaskMetrics(tasks, todayYMD, plus7YMD) {
    let completed = 0;
    let inProgress = 0;
    let notStarted = 0;
    let deferred = 0;
    let paused = 0;
    let overdue = 0;
    let dueSoon = 0;
    let onTime = 0;
    let late = 0;
    let plannedHours = 0;
    let actualHours = 0;
    let plannedQty = 0;
    let actualQty = 0;
    let unplanned = 0;
    let approvedOk = 0;
    let needsFix = 0;
    let blockers = 0;

    tasks.forEach(t => {
        if (t.status === "Hoàn thành") completed++;
        else if (t.status === "Đang làm") inProgress++;
        else if (t.status === "Chưa xong — dời sang ngày khác") deferred++;
        else if (t.status === "Tạm dừng / chờ duyệt") paused++;
        else notStarted++;

        if (isOverdue(t, todayYMD)) overdue++;
        if (isDueSoon(t, todayYMD, plus7YMD)) dueSoon++;
        if (isOnTime(t)) onTime++;
        if (isLateCompleted(t)) late++;

        plannedHours += t.plannedHours || 0;
        actualHours += t.actualHours || 0;
        plannedQty += t.plannedQty || 0;
        actualQty += t.actualQty || 0;

        if (t.source === "Việc phát sinh") unplanned++;
        if (t.approvalStatus === "Đạt") approvedOk++;
        else if (t.approvalStatus === "Cần sửa lại") needsFix++;
        if (t.blocker && t.blocker.trim()) blockers++;
    });

    const total = tasks.length;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
    const unplannedRate = total > 0 ? Math.round((unplanned / total) * 100) : 0;

    return {
        total,
        completed,
        inProgress,
        notStarted,
        deferred,
        paused,
        overdue,
        dueSoon,
        onTime,
        late,
        completionRate,
        plannedHours: round2(plannedHours),
        actualHours: round2(actualHours),
        hoursDiff: round2(actualHours - plannedHours),
        plannedQty: round2(plannedQty),
        actualQty: round2(actualQty),
        unplanned,
        unplannedRate,
        approvedOk,
        needsFix,
        blockers
    };
}

function getMemberRatingBadge(m) {
    if (m.total === 0) return { label: "Chưa có việc", cls: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" };
    if (m.overdue > 2 || (m.completionRate < 40 && m.completed < m.total)) {
        return { label: "Cần chú ý", cls: "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300" };
    }
    if (m.completionRate >= 85 && m.overdue === 0) {
        return { label: "Xuất sắc", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" };
    }
    if (m.completionRate >= 60) {
        return { label: "Tốt", cls: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300" };
    }
    return { label: "Đang triển khai", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" };
}

function renderSummaryAndMemberMeasurement() {
    const today = new Date();
    const todayYMD = toYMD(today);
    const plus7YMD = toYMD(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7));
    const { label, tasks } = getMeasurementTasksScope();
    const summary = computeTaskMetrics(tasks, todayYMD, plus7YMD);

    const periodBadge = document.getElementById("kpiPeriodBadge");
    if (periodBadge) periodBadge.textContent = label;

    // 6 Summary Cards
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText("kpiTotalTasks", String(summary.total));
    const pillsEl = document.getElementById("kpiBreakdownPills");
    if (pillsEl) {
        pillsEl.innerHTML = `
            <span class="px-2 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold">Xong: ${summary.completed}</span>
            <span class="px-2 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 text-[10px] font-bold">Đang làm: ${summary.inProgress}</span>
            <span class="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[10px] font-bold">Chờ: ${summary.notStarted}</span>
            ${summary.deferred > 0 ? `<span class="px-2 py-0.5 rounded-md bg-orange-50 dark:bg-orange-950/50 text-orange-700 dark:text-orange-300 text-[10px] font-bold">Dời: ${summary.deferred}</span>` : ""}
        `;
    }

    setText("kpiCompletionRate", `${summary.completionRate}%`);
    const barEl = document.getElementById("kpiCompletionBar");
    if (barEl) barEl.style.width = `${summary.completionRate}%`;
    setText("kpiSourceRatio", `Trong KH: ${summary.total - summary.unplanned} · Phát sinh: ${summary.unplanned} (${summary.unplannedRate}%)`);

    setText("kpiOnTimeSummary", `${summary.onTime} / ${summary.late}`);
    const overdueBadge = document.getElementById("kpiOverdueBadge");
    if (overdueBadge) {
        overdueBadge.textContent = `Quá hạn: ${summary.overdue} · Sắp hạn 7 ngày: ${summary.dueSoon}`;
        overdueBadge.className = `text-[11px] font-bold mt-2 ${summary.overdue > 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-500 dark:text-slate-400"}`;
    }

    setText("kpiHoursSummary", `${formatNum(summary.actualHours)} / ${formatNum(summary.plannedHours)}h`);
    const diffSign = summary.hoursDiff > 0 ? "+" : "";
    setText("kpiHoursDiff", `Chênh lệch (TT − DK): ${diffSign}${formatNum(summary.hoursDiff)} giờ`);

    setText("kpiQtySummary", `${formatNum(summary.actualQty)} / ${formatNum(summary.plannedQty)}`);
    const qtyRate = summary.plannedQty > 0 ? Math.round((summary.actualQty / summary.plannedQty) * 100) : 0;
    setText("kpiQtyDetail", `Tỷ lệ sản lượng đạt: ${qtyRate}%`);

    setText("kpiApprovalSummary", `${summary.approvedOk} / ${summary.needsFix}`);
    setText("kpiBlockerBadge", `Vướng mắc cần hỗ trợ: ${summary.blockers} việc`);

    // 14-Column Member Measurement Table
    const f = getFilterState();
    const memberNames = new Set();
    tasks.forEach(t => t.assignee && memberNames.add(canonicalName(t.assignee)));
    if (f.user !== "all") memberNames.add(canonicalName(f.user));
    (window.allUsersData || []).forEach(u => {
        if ((f.dept !== "all" && (u.dept || u.department) === f.dept) || u.dept === "Creative") {
            if (f.user === "all" || canonicalName(u.name) === canonicalName(f.user)) {
                memberNames.add(canonicalName(u.name));
            }
        }
    });

    const memberRows = Array.from(memberNames)
        .filter(Boolean)
        .map(name => {
            const info = resolveMemberInfo(name);
            const mTasks = tasks.filter(t => canonicalName(t.assignee) === name);
            return {
                ...info,
                ...computeTaskMetrics(mTasks, todayYMD, plus7YMD)
            };
        })
        .sort((a, b) => b.total - a.total || b.completed - a.completed || a.name.localeCompare(b.name, "vi"));

    const tbody = document.getElementById("memberMeasurementBody");
    if (tbody) {
        if (memberRows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="13" class="py-12 text-center text-slate-400 text-xs font-bold uppercase tracking-widest">Chưa có dữ liệu thành viên trong kỳ</td></tr>`;
        } else {
            tbody.innerHTML = memberRows.map(m => {
                const rating = getMemberRatingBadge(m);
                const diffStr = `${m.hoursDiff > 0 ? "+" : ""}${formatNum(m.hoursDiff)}h`;
                const barColor = m.completionRate >= 80 ? "bg-emerald-500" : m.completionRate >= 45 ? "bg-amber-500" : "bg-rose-500";
                return `<tr class="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 border-b border-slate-100 dark:border-slate-800 cursor-pointer transition-colors"
                            onclick="window.openMemberScorecard('${escapeHtml(m.name)}')">
                    <th scope="row" class="py-3.5 px-5 text-left whitespace-nowrap border-r border-slate-100 dark:border-slate-800">
                        <div class="flex items-center gap-3">
                            <div class="w-9 h-9 rounded-xl bg-rose-50 dark:bg-rose-950/60 text-primary flex items-center justify-center text-[11px] font-black shrink-0">${escapeHtml(m.initials)}</div>
                            <div>
                                <div class="text-sm font-black text-slate-800 dark:text-slate-100">${escapeHtml(m.name)}</div>
                                <div class="text-[10px] font-bold text-slate-400 uppercase">${escapeHtml(m.dept)}</div>
                            </div>
                        </div>
                    </th>
                    <td class="py-3.5 px-3 text-center font-black text-slate-800 dark:text-slate-100">${m.total}</td>
                    <td class="py-3.5 px-3 text-center font-bold text-emerald-600 dark:text-emerald-400">${m.completed}</td>
                    <td class="py-3.5 px-3 text-center font-bold text-amber-600 dark:text-amber-400">${m.inProgress}</td>
                    <td class="py-3.5 px-3 text-center font-bold text-slate-500">${m.notStarted}</td>
                    <td class="py-3.5 px-3 text-center font-black ${m.overdue > 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-400"}">${m.overdue}</td>
                    <td class="py-3.5 px-3 text-center text-xs font-bold whitespace-nowrap">
                        <span class="text-emerald-600 dark:text-emerald-400">${m.onTime}</span>
                        <span class="text-slate-300 mx-0.5">/</span>
                        <span class="${m.late > 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-400"}">${m.late}</span>
                    </td>
                    <td class="py-3.5 px-4 min-w-[120px]">
                        <div class="flex items-center gap-2">
                            <div class="flex-1 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                                <div class="h-full ${barColor} rounded-full" style="width: ${m.completionRate}%"></div>
                            </div>
                            <span class="text-[11px] font-black text-slate-600 dark:text-slate-300 w-9 text-right">${m.completionRate}%</span>
                        </div>
                    </td>
                    <td class="py-3.5 px-3 text-center text-xs whitespace-nowrap">
                        <span class="font-bold text-slate-700 dark:text-slate-200">${formatNum(m.plannedHours)}h / ${formatNum(m.actualHours)}h</span>
                        <span class="block text-[10px] font-bold ${m.hoursDiff > 0 ? "text-amber-600" : "text-slate-400"}">(${diffStr})</span>
                    </td>
                    <td class="py-3.5 px-3 text-center text-xs font-bold whitespace-nowrap text-slate-700 dark:text-slate-300">
                        ${formatNum(m.plannedQty)} / ${formatNum(m.actualQty)}
                    </td>
                    <td class="py-3.5 px-3 text-center text-xs font-bold text-amber-600 dark:text-amber-400">${m.unplannedRate}%</td>
                    <td class="py-3.5 px-3 text-center text-xs font-bold whitespace-nowrap">
                        <span class="text-emerald-600 dark:text-emerald-400">${m.approvedOk}</span>
                        <span class="text-slate-300 mx-0.5">/</span>
                        <span class="${m.needsFix > 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-400"}">${m.needsFix}</span>
                    </td>
                    <td class="py-3.5 px-4 text-right whitespace-nowrap">
                        <span class="px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider ${rating.cls}">${rating.label}</span>
                    </td>
                </tr>`;
            }).join("");
        }
    }

    renderAnalyticsVisuals(tasks, memberRows);
}

// ===== CHARTS & CATEGORY BREAKDOWN =====

function renderAnalyticsVisuals(tasks, memberRows) {
    renderCategoryStats(tasks);
    if (typeof window.Chart !== "function") return;

    const isDark = document.documentElement.classList.contains("dark");
    const tickColor = isDark ? "#94a3b8" : "#64748b";

    // 1. Member Stacked Workload Chart
    const workloadCanvas = document.getElementById("chartMemberWorkload");
    if (workloadCanvas) {
        if (state.charts.workload) state.charts.workload.destroy();
        const activeMembers = memberRows.filter(m => m.total > 0).slice(0, 10);
        state.charts.workload = new window.Chart(workloadCanvas.getContext("2d"), {
            type: "bar",
            data: {
                labels: activeMembers.map(m => m.name),
                datasets: [
                    { label: "Hoàn thành", data: activeMembers.map(m => m.completed), backgroundColor: "#10b981", borderRadius: 4 },
                    { label: "Đang làm", data: activeMembers.map(m => m.inProgress), backgroundColor: "#f59e0b", borderRadius: 4 },
                    { label: "Chưa bắt đầu", data: activeMembers.map(m => m.notStarted), backgroundColor: "#94a3b8", borderRadius: 4 },
                    { label: "Dời / Tạm dừng", data: activeMembers.map(m => m.deferred + m.paused), backgroundColor: "#fb7185", borderRadius: 4 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: "bottom", labels: { color: tickColor, boxWidth: 12, font: { size: 11, weight: "bold" } } } },
                scales: {
                    x: { stacked: true, ticks: { color: tickColor }, grid: { display: false } },
                    y: { stacked: true, beginAtZero: true, ticks: { color: tickColor, stepSize: 5 }, grid: { color: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)" } }
                }
            }
        });
    }

    // 2. Daily Progress Chart (Month days)
    const dailyCanvas = document.getElementById("chartDailyProgress");
    if (dailyCanvas) {
        if (state.charts.daily) state.charts.daily.destroy();
        const year = state.anchorDate.getFullYear();
        const month = state.anchorDate.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const labels = [];
        const totalByDay = [];
        const doneByDay = [];

        for (let d = 1; d <= daysInMonth; d++) {
            const ymd = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
            const dayTasks = tasks.filter(t => t.date === ymd);
            labels.push(String(d));
            totalByDay.push(dayTasks.length);
            doneByDay.push(dayTasks.filter(t => t.status === "Hoàn thành").length);
        }

        state.charts.daily = new window.Chart(dailyCanvas.getContext("2d"), {
            type: "bar",
            data: {
                labels,
                datasets: [
                    { label: "Tổng việc trong ngày", data: totalByDay, backgroundColor: "rgba(184, 0, 53, 0.25)", borderColor: "#b80035", borderWidth: 1, borderRadius: 4 },
                    { label: "Hoàn thành", data: doneByDay, type: "line", borderColor: "#10b981", backgroundColor: "#10b981", tension: 0.35, borderWidth: 2, pointRadius: 2.5 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: "bottom", labels: { color: tickColor, boxWidth: 12, font: { size: 11, weight: "bold" } } } },
                scales: {
                    x: { ticks: { color: tickColor, maxRotation: 0 }, grid: { display: false } },
                    y: { beginAtZero: true, ticks: { color: tickColor, precision: 0 }, grid: { color: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)" } }
                }
            }
        });
    }
}

export function renderCategoryStats(tasksOverride) {
    const container = document.getElementById("categoryStatsList");
    if (!container) return;

    const tasks = tasksOverride || getMeasurementTasksScope().tasks;
    const total = tasks.length;
    if (total === 0) {
        container.innerHTML = `<div class="text-slate-400 text-center py-8 text-xs font-bold uppercase tracking-widest">Chưa có công việc trong kỳ</div>`;
        return;
    }

    const counts = {};
    tasks.forEach(t => {
        const c = t.category || "Khác";
        counts[c] = (counts[c] || 0) + 1;
    });

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    container.innerHTML = sorted.map(([name, count]) => {
        const pct = Math.round((count / total) * 100);
        const barCls = (CATEGORY_COLORS[name] || CATEGORY_COLORS["Khác"]).bar;
        return `<div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs">
                <span class="font-bold text-slate-200">${escapeHtml(name)}</span>
                <span class="font-black text-white">${count} việc <span class="text-white/50">(${pct}%)</span></span>
            </div>
            <div class="h-2 w-full bg-white/10 rounded-full overflow-hidden">
                <div class="h-full ${barCls} rounded-full transition-all duration-700" style="width: ${pct}%"></div>
            </div>
        </div>`;
    }).join("");
}

function renderDeptPerformance() {
    const deptBody = document.getElementById("deptPerformanceBody");
    if (!deptBody || !window.allOrdersData) return;

    const depts = [...new Set(window.allOrdersData.map(o => o.department).filter(Boolean))].sort();
    deptBody.innerHTML = depts.map(d => {
        const dOrders = window.allOrdersData.filter(o => o.department === d);
        const dCompleted = dOrders.filter(o => o.status === "Hoàn thành").length;
        const dRate = dOrders.length > 0 ? Math.round((dCompleted / dOrders.length) * 100) : 0;
        const dOnTimeOrders = dOrders.filter(o => {
            if (o.status !== "Hoàn thành") return false;
            if (!o.deadline) return true;
            const deadline = new Date(o.deadline);
            const updated = o.updatedAt ? (o.updatedAt.toDate ? o.updatedAt.toDate() : new Date(o.updatedAt)) : new Date();
            return updated <= deadline;
        });
        const dOnTimeRate = dCompleted > 0 ? Math.round((dOnTimeOrders.length / dCompleted) * 100) : 0;

        return `<tr class="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all">
            <td class="py-4 px-6 font-bold text-sm text-slate-700 dark:text-slate-200">${escapeHtml(d)}</td>
            <td class="py-4 px-4 text-center font-bold text-slate-600 dark:text-slate-300">${dOrders.length}</td>
            <td class="py-4 px-4 text-center font-bold text-emerald-600">${dCompleted}</td>
            <td class="py-4 px-4">
                <div class="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                    <div class="h-full bg-emerald-500" style="width: ${dOnTimeRate}%"></div>
                </div>
            </td>
            <td class="py-4 px-6 text-right font-black text-rose-500 text-sm">${dRate}%</td>
        </tr>`;
    }).join("");
}

// ===== MAIN PAGE RENDER =====

export function renderReports() {
    refreshScheduleFilters();
    switchScheduleView(state.currentView);
    renderSummaryAndMemberMeasurement();
    renderDeptPerformance();
}

// ===== NATIVE DIALOGS & CRUD OPERATIONS =====

function initNativeDialogs() {
    if (state.dialogsInitialized) return;
    state.dialogsInitialized = true;

    const lightDismissIds = ["scheduleTaskDialog", "memberScorecardDialog"];
    const supportsClosedBy = "closedBy" in HTMLDialogElement.prototype;

    const isOutside = (e, dialog) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };

    lightDismissIds.forEach(id => {
        const dialog = document.getElementById(id);
        if (!dialog) return;

        dialog.addEventListener("close", () => {
            dialog.returnValue = "";
        });

        if (!supportsClosedBy) {
            let pressedOutside = false;
            dialog.addEventListener("pointerdown", (e) => {
                pressedOutside = e.target === dialog && isOutside(e, dialog);
            });
            dialog.addEventListener("pointerup", (e) => {
                if (pressedOutside && e.target === dialog && isOutside(e, dialog)) {
                    dialog.close();
                }
                pressedOutside = false;
            });
        }
    });

    const bulkDialog = document.getElementById("bulkScheduleDialog");
    if (bulkDialog) {
        bulkDialog.addEventListener("close", () => {
            bulkDialog.returnValue = "";
        });
        bulkDialog.addEventListener("cancel", (e) => {
            if (hasUnsavedBulkRows() && !window.confirm("Bạn đang có dữ liệu chưa lưu trong bảng. Đóng hộp thoại?")) {
                e.preventDefault();
            }
        });
    }
}

function updateHoursDiffHint() {
    const p = parseHours(document.getElementById("taskPlannedHours")?.value);
    const a = parseHours(document.getElementById("taskActualHours")?.value);
    const hintEl = document.getElementById("taskHoursDiffHint");
    if (!hintEl) return;
    const diff = round2(a - p);
    const sign = diff > 0 ? "+" : "";
    hintEl.textContent = `Chênh lệch: ${sign}${formatNum(diff)} giờ`;
}

export function openScheduleTaskModal(taskId = null, prefill = {}) {
    initNativeDialogs();
    refreshScheduleFilters();

    const dialog = document.getElementById("scheduleTaskDialog");
    const form = document.getElementById("scheduleTaskForm");
    if (!dialog || !form) return;

    const me = getCurrentUser();
    const canManage = canManageAll();
    const task = taskId ? state.tasks.find(t => t.id === taskId) : null;
    const isCreate = !task;
    const editable = isCreate ? canCreateOwn() : canEditTask(task);

    document.getElementById("scheduleTaskDialogTitle").textContent = isCreate
        ? "Thêm công việc mới vào Lịch"
        : (editable ? "Chi tiết & Cập nhật công việc" : "Xem thông tin công việc");

    document.getElementById("taskEditId").value = task ? task.id : "";

    const defaultDate = task?.date || prefill.date || toYMD(new Date());
    const dateInput = document.getElementById("taskDate");
    dateInput.value = defaultDate;
    const weekdayEl = document.getElementById("taskWeekdayBadge");
    if (weekdayEl) weekdayEl.textContent = getWeekdayLabel(defaultDate);

    const assigneeEl = document.getElementById("taskAssignee");
    const targetAssignee = task?.assignee || prefill.assignee || canonicalName(me.name);
    if (targetAssignee && !Array.from(assigneeEl.options).some(o => o.value === targetAssignee)) {
        const opt = document.createElement("option");
        opt.value = targetAssignee;
        opt.textContent = targetAssignee;
        assigneeEl.appendChild(opt);
    }
    assigneeEl.value = targetAssignee;
    assigneeEl.disabled = !editable || !canManage;

    // Multi-assign checkboxes only for Managers/Admins creating a new task
    const multiWrap = document.getElementById("taskMultiAssignWrapper");
    const multiList = document.getElementById("taskMultiAssignList");
    if (multiWrap && multiList) {
        if (isCreate && canManage) {
            multiWrap.classList.remove("hidden");
            const others = Array.from(assigneeEl.options)
                .map(o => o.value)
                .filter(name => name && name !== targetAssignee);
            multiList.innerHTML = others.map(name => `
                <label class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-semibold cursor-pointer">
                    <input type="checkbox" name="taskExtraAssignees" value="${escapeHtml(name)}" class="rounded text-primary">
                    <span>${escapeHtml(name)}</span>
                </label>`).join("");
        } else {
            multiWrap.classList.add("hidden");
            multiList.innerHTML = "";
        }
    }

    document.getElementById("taskApprover").value = task?.approver || "";
    document.getElementById("taskTitle").value = task?.title || prefill.title || "";
    const catEl = document.getElementById("taskCategory");
    const targetCat = task?.category || prefill.category || "Hình ảnh AI";
    if (catEl) {
        if (!Array.from(catEl.options).some(o => o.value === targetCat)) {
            const opt = document.createElement("option");
            opt.value = targetCat;
            opt.textContent = targetCat;
            catEl.appendChild(opt);
        }
        catEl.value = targetCat;
    }
    document.getElementById("taskSource").value = task?.source || "Trong KH tháng";
    document.getElementById("taskTimeSlot").value = task?.timeSlot || "Linh hoạt";
    document.getElementById("taskDeadline").value = task?.deadline || prefill.deadline || "";
    document.getElementById("taskPriority").value = task?.priority || "Trung bình";
    document.getElementById("taskPlannedHours").value = task?.plannedHours || "";
    document.getElementById("taskPlannedQty").value = task?.plannedQtyRaw || "";
    document.getElementById("taskUnit").value = task?.unit || "Việc";
    document.getElementById("taskLinkedOrder").value = task?.linkedOrderCode || prefill.linkedOrderCode || "";
    document.getElementById("taskDescription").value = task?.description || prefill.description || "";

    document.getElementById("taskStatus").value = task?.status || "Chưa bắt đầu";
    const pct = task?.progress ?? 0;
    document.getElementById("taskProgress").value = pct;
    document.getElementById("taskProgressRange").value = pct;
    document.getElementById("taskActualHours").value = task?.actualHours || "";
    document.getElementById("taskActualQty").value = task?.actualQtyRaw || "";
    document.getElementById("taskCompletedDate").value = task?.completedDate || "";
    document.getElementById("taskResultLink").value = task?.resultLink || "";
    document.getElementById("taskBlocker").value = task?.blocker || "";
    document.getElementById("taskNextStep").value = task?.nextStep || "";

    const approvalEl = document.getElementById("taskApprovalStatus");
    const approvalHint = document.getElementById("taskApprovalHint");
    approvalEl.value = task?.approvalStatus || "Chưa duyệt";
    approvalEl.disabled = !editable || !canManage;
    if (approvalHint) approvalHint.classList.toggle("hidden", canManage);

    updateHoursDiffHint();

    // Disable form inputs if user is viewing a teammate's task without manage_all permission
    const controls = form.querySelectorAll("input, select, textarea");
    controls.forEach(ctrl => {
        if (ctrl.id === "taskAssignee" || ctrl.id === "taskApprovalStatus") return;
        ctrl.disabled = !editable;
    });

    const delBtn = document.getElementById("btnDeleteScheduleTask");
    const deferBtn = document.getElementById("btnDeferScheduleTask");
    const saveContBtn = document.getElementById("btnSaveAndContinueTask");
    const saveBtn = document.getElementById("btnSaveScheduleTask");
    const deferBox = document.getElementById("taskDeferBox");
    const singleOrderToggle = document.getElementById("btnToggleSingleOrderPicker");
    const singleOrderBox = document.getElementById("singleOrderPickerBox");

    if (deferBox) deferBox.classList.add("hidden");
    if (singleOrderBox) singleOrderBox.classList.add("hidden");
    if (singleOrderToggle) singleOrderToggle.classList.toggle("hidden", !editable);
    if (delBtn) delBtn.classList.toggle("hidden", isCreate || !editable);
    if (deferBtn) deferBtn.classList.toggle("hidden", isCreate || !editable);
    if (saveContBtn) saveContBtn.classList.toggle("hidden", !isCreate || !editable);
    if (saveBtn) saveBtn.classList.toggle("hidden", !editable);

    dialog.showModal();
}

function renderSingleOrderPicker() {
    const listEl = document.getElementById("singleOrderPickerList");
    const assignee = document.getElementById("taskAssignee")?.value || canonicalName(getCurrentUser().name);
    if (!listEl) return;
    const orders = getAssignedActiveOrders(assignee, canManageAll());
    if (orders.length === 0) {
        listEl.innerHTML = `<span class="text-[11px] text-slate-400">Không có đơn hàng đang mở cho ${escapeHtml(assignee)}.</span>`;
        return;
    }
    listEl.innerHTML = orders.slice(0, 30).map(o => `
        <button type="button" data-single-order-id="${escapeHtml(o.id)}"
            class="px-2.5 py-1 rounded-lg bg-white dark:bg-slate-800 border border-rose-200 dark:border-rose-800 text-[11px] font-bold text-slate-700 dark:text-slate-200 hover:border-primary hover:text-primary transition-colors text-left">
            <span class="text-primary font-black">#${escapeHtml(o.code || "")}</span> · ${escapeHtml((o.title || "").slice(0, 42))}
        </button>`).join("");
}

export function closeScheduleTaskModal() {
    document.getElementById("scheduleTaskDialog")?.close();
}

export async function saveScheduleTask(event, keepOpen = false) {
    if (event) event.preventDefault();
    const editId = document.getElementById("taskEditId").value;
    const me = getCurrentUser();
    const canManage = canManageAll();

    if (editId) {
        const existing = state.tasks.find(t => t.id === editId);
        if (!existing || !canEditTask(existing)) {
            showToast("Từ chối!", "Bạn không có quyền chỉnh sửa công việc này.", "block", "error");
            return;
        }
    } else if (!canCreateOwn()) {
        showToast("Từ chối!", "Bạn không có quyền thêm công việc mới.", "block", "error");
        return;
    }

    const title = document.getElementById("taskTitle").value.trim();
    const date = document.getElementById("taskDate").value;
    if (!title || !date) {
        showToast("Thiếu thông tin", "Vui lòng nhập ngày và tên công việc.", "warning", "warning");
        return;
    }

    const rawAssignee = canManage
        ? document.getElementById("taskAssignee").value
        : canonicalName(me.name);
    const assigneeInfo = resolveMemberInfo(rawAssignee);

    const status = document.getElementById("taskStatus").value;
    let progress = Number(document.getElementById("taskProgress").value || 0);
    if (status === "Hoàn thành" && progress < 100) progress = 100;
    if (status === "Chưa bắt đầu" && progress === 100) progress = 0;

    let completedDate = document.getElementById("taskCompletedDate").value;
    if (status === "Hoàn thành" && !completedDate) {
        completedDate = toYMD(new Date());
    } else if (status !== "Hoàn thành" && !editId) {
        completedDate = "";
    }

    const plannedHours = parseHours(document.getElementById("taskPlannedHours").value);
    const actualHours = parseHours(document.getElementById("taskActualHours").value);
    const plannedQtyRaw = document.getElementById("taskPlannedQty").value.trim();
    const actualQtyRaw = document.getElementById("taskActualQty").value.trim();

    const basePayload = {
        date,
        weekday: getWeekdayLabel(date),
        assignee: assigneeInfo.name,
        assigneeId: assigneeInfo.empId,
        department: assigneeInfo.dept,
        approver: document.getElementById("taskApprover").value.trim(),
        title,
        category: document.getElementById("taskCategory").value,
        source: document.getElementById("taskSource").value,
        timeSlot: document.getElementById("taskTimeSlot").value,
        deadline: document.getElementById("taskDeadline").value || "",
        priority: document.getElementById("taskPriority").value,
        plannedHours,
        plannedQtyRaw,
        plannedQty: parseQty(plannedQtyRaw),
        unit: document.getElementById("taskUnit").value,
        linkedOrderCode: document.getElementById("taskLinkedOrder").value.trim(),
        description: document.getElementById("taskDescription").value.trim(),
        status,
        progress: Math.max(0, Math.min(100, progress)),
        actualHours,
        hoursDiff: round2(actualHours - plannedHours),
        actualQtyRaw,
        actualQty: parseQty(actualQtyRaw),
        completedDate,
        resultLink: document.getElementById("taskResultLink").value.trim(),
        blocker: document.getElementById("taskBlocker").value.trim(),
        nextStep: document.getElementById("taskNextStep").value.trim(),
        updatedAt: serverTimestamp(),
        updatedBy: me.name || "Hệ thống"
    };

    if (canManage) {
        basePayload.approvalStatus = document.getElementById("taskApprovalStatus").value;
    } else if (!editId) {
        basePayload.approvalStatus = "Chưa duyệt";
    }

    const saveBtn = document.getElementById("btnSaveScheduleTask");
    const saveContBtn = document.getElementById("btnSaveAndContinueTask");
    if (saveBtn) saveBtn.disabled = true;
    if (saveContBtn) saveContBtn.disabled = true;

    try {
        if (editId) {
            await updateDoc(doc(db, "schedule_tasks", editId), basePayload);
            showToast("Đã cập nhật!", `Công việc "${title}" đã được lưu.`, "check_circle", "success");
            if (window.logActivity) {
                window.logActivity("update", "Cập nhật lịch làm việc", `${me.name} cập nhật việc "${title}" (${status})`);
            }
            closeScheduleTaskModal();
        } else {
            const extraChecked = Array.from(document.querySelectorAll('input[name="taskExtraAssignees"]:checked'))
                .map(el => el.value)
                .filter(Boolean);
            const targetNames = [assigneeInfo.name, ...extraChecked.filter(n => n !== assigneeInfo.name)];

            await Promise.all(targetNames.map(name => {
                const info = resolveMemberInfo(name);
                return addDoc(collection(db, "schedule_tasks"), {
                    ...basePayload,
                    assignee: info.name,
                    assigneeId: info.empId,
                    department: info.dept,
                    createdBy: me.name || info.name,
                    createdAt: serverTimestamp()
                });
            }));

            showToast("Đã thêm việc!", `Đã lưu lịch cho ${targetNames.length} thành viên.`, "check_circle", "success");
            if (window.logActivity) {
                window.logActivity("create", "Thêm việc vào lịch", `${me.name} thêm "${title}" cho ${targetNames.join(", ")}`);
            }

            if (keepOpen) {
                ["taskTitle", "taskPlannedHours", "taskPlannedQty", "taskLinkedOrder", "taskDescription", "taskResultLink", "taskBlocker", "taskNextStep"].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.value = "";
                });
                document.getElementById("taskStatus").value = "Chưa bắt đầu";
                document.getElementById("taskProgress").value = 0;
                document.getElementById("taskProgressRange").value = 0;
                updateHoursDiffHint();
                document.getElementById("taskTitle")?.focus();
            } else {
                closeScheduleTaskModal();
            }
        }
    } catch (err) {
        console.error("[ScheduleManager] Save error:", err);
        showToast("Lỗi lưu dữ liệu", err.message || "Không thể kết nối Firestore", "error", "error");
    } finally {
        if (saveBtn) saveBtn.disabled = false;
        if (saveContBtn) saveContBtn.disabled = false;
    }
}

export async function quickCycleTaskStatus(taskId, event) {
    if (event) event.stopPropagation();
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || !canEditTask(task)) {
        showToast("Chỉ xem", "Bạn chỉ có thể đổi trạng thái công việc của mình.", "lock", "warning");
        return;
    }

    const cycle = ["Chưa bắt đầu", "Đang làm", "Hoàn thành"];
    const nextIdx = (cycle.indexOf(task.status) + 1) % cycle.length;
    const nextStatus = cycle[nextIdx];
    const updates = {
        status: nextStatus,
        progress: nextStatus === "Hoàn thành" ? 100 : nextStatus === "Đang làm" ? Math.max(task.progress || 0, 50) : 0,
        completedDate: nextStatus === "Hoàn thành" ? (task.completedDate || toYMD(new Date())) : "",
        updatedAt: serverTimestamp()
    };

    try {
        await updateDoc(doc(db, "schedule_tasks", taskId), updates);
        showToast("Đã cập nhật", `"${task.title}" → ${nextStatus}`, "task_alt", "success");
    } catch (err) {
        console.error(err);
        showToast("Lỗi cập nhật", err.message, "error", "error");
    }
}

export async function inlineUpdateTaskField(taskId, field, rawValue) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    if (field === "approvalStatus" && !canManageAll()) {
        showToast("Từ chối", "Chỉ Quản lý hoặc Admin mới được duyệt nghiệm thu.", "block", "error");
        renderListSchedule();
        return;
    }
    if (field !== "approvalStatus" && !canEditTask(task)) {
        showToast("Từ chối", "Bạn không có quyền sửa công việc của thành viên khác.", "block", "error");
        renderListSchedule();
        return;
    }

    const updates = { updatedAt: serverTimestamp() };
    if (field === "actualHours") {
        const hrs = parseHours(rawValue);
        updates.actualHours = hrs;
        updates.hoursDiff = round2(hrs - (task.plannedHours || 0));
    } else if (field === "actualQty") {
        updates.actualQtyRaw = String(rawValue || "").trim();
        updates.actualQty = parseQty(rawValue);
    } else if (field === "status") {
        updates.status = rawValue;
        if (rawValue === "Hoàn thành") {
            updates.progress = 100;
            if (!task.completedDate) updates.completedDate = toYMD(new Date());
        } else if (rawValue === "Chưa bắt đầu") {
            updates.progress = 0;
        }
    } else if (field === "approvalStatus") {
        updates.approvalStatus = rawValue;
    }

    try {
        await updateDoc(doc(db, "schedule_tasks", taskId), updates);
        showToast("Đã lưu thay đổi", `${task.title}`, "check_circle", "success");
    } catch (err) {
        console.error(err);
        showToast("Lỗi lưu", err.message, "error", "error");
    }
}

export async function confirmDeferTask() {
    const editId = document.getElementById("taskEditId").value;
    const targetDate = document.getElementById("taskDeferDate")?.value;
    const task = state.tasks.find(t => t.id === editId);
    if (!task || !canEditTask(task)) return;
    if (!targetDate) {
        showToast("Thiếu ngày dời", "Vui lòng chọn ngày muốn chuyển việc sang.", "warning", "warning");
        return;
    }

    const me = getCurrentUser();
    try {
        await updateDoc(doc(db, "schedule_tasks", editId), {
            status: "Chưa xong — dời sang ngày khác",
            updatedAt: serverTimestamp(),
            updatedBy: me.name || "Hệ thống"
        });

        await addDoc(collection(db, "schedule_tasks"), {
            date: targetDate,
            weekday: getWeekdayLabel(targetDate),
            assignee: task.assignee,
            assigneeId: task.assigneeId || "",
            department: task.department || "",
            approver: task.approver || "",
            title: task.title,
            category: task.category || "Khác",
            source: task.source || "Trong KH tháng",
            timeSlot: task.timeSlot || "Linh hoạt",
            deadline: task.deadline || "",
            priority: task.priority || "Trung bình",
            plannedHours: task.plannedHours || 0,
            plannedQtyRaw: task.plannedQtyRaw || "",
            plannedQty: task.plannedQty || 0,
            unit: task.unit || "Việc",
            linkedOrderCode: task.linkedOrderCode || "",
            description: task.description || "",
            status: "Chưa bắt đầu",
            progress: 0,
            actualHours: 0,
            hoursDiff: round2(-(task.plannedHours || 0)),
            actualQtyRaw: "",
            actualQty: 0,
            completedDate: "",
            resultLink: "",
            approvalStatus: "Chưa duyệt",
            blocker: task.blocker || "",
            nextStep: `Dời từ ngày ${formatDisplayDate(task.date)}`,
            createdBy: me.name || task.assignee,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        showToast("Đã dời lịch!", `Đã chuyển "${task.title}" sang ${formatDisplayDate(targetDate)}.`, "event_repeat", "success");
        closeScheduleTaskModal();
    } catch (err) {
        console.error(err);
        showToast("Lỗi dời lịch", err.message, "error", "error");
    }
}

export async function deleteScheduleTask() {
    const editId = document.getElementById("taskEditId").value;
    const task = state.tasks.find(t => t.id === editId);
    if (!task || !canEditTask(task)) {
        showToast("Từ chối", "Bạn không có quyền xóa công việc này.", "block", "error");
        return;
    }

    let confirmed = false;
    if (window.Swal) {
        const res = await window.Swal.fire({
            title: "Xóa công việc?",
            text: `Bạn chắc chắn muốn xóa "${task.title}" (${formatDisplayDate(task.date)})?`,
            icon: "warning",
            showCancelButton: true,
            confirmButtonColor: "#b80035",
            confirmButtonText: "Xóa việc",
            cancelButtonText: "Hủy"
        });
        confirmed = Boolean(res.isConfirmed);
    } else {
        confirmed = window.confirm(`Xóa công việc "${task.title}"?`);
    }
    if (!confirmed) return;

    try {
        await deleteDoc(doc(db, "schedule_tasks", editId));
        showToast("Đã xóa", `Đã xóa công việc "${task.title}".`, "delete", "info");
        if (window.logActivity) {
            window.logActivity("delete", "Xóa công việc trên lịch", `${getCurrentUser().name} đã xóa "${task.title}"`);
        }
        closeScheduleTaskModal();
    } catch (err) {
        console.error(err);
        showToast("Lỗi xóa", err.message, "error", "error");
    }
}

// ===== MEMBER SCORECARD MODAL =====

export function openMemberScorecard(rawName) {
    initNativeDialogs();
    const dialog = document.getElementById("memberScorecardDialog");
    if (!dialog) return;

    const info = resolveMemberInfo(rawName);
    const today = new Date();
    const todayYMD = toYMD(today);
    const plus7YMD = toYMD(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7));
    const { label, tasks } = getMeasurementTasksScope();
    const memberTasks = tasks.filter(t => canonicalName(t.assignee) === info.name);
    const m = computeTaskMetrics(memberTasks, todayYMD, plus7YMD);

    document.getElementById("memberScorecardDialogTitle").textContent = info.name;
    document.getElementById("scorecardSubtitle").textContent = `${info.dept} · Kỳ đo lường: ${label}`;
    document.getElementById("scorecardAvatar").textContent = info.initials;

    const kpiGrid = document.getElementById("scorecardKpiGrid");
    if (kpiGrid) {
        const tiles = [
            { label: "Tổng việc", val: m.total, sub: `Xong ${m.completed} · Làm ${m.inProgress}` },
            { label: "% Hoàn thành", val: `${m.completionRate}%`, sub: `Phát sinh ${m.unplanned} việc (${m.unplannedRate}%)` },
            { label: "Kỷ luật Deadline", val: `${m.onTime} / ${m.late}`, sub: `Quá hạn: ${m.overdue} việc` },
            { label: "Giờ công (TT / DK)", val: `${formatNum(m.actualHours)} / ${formatNum(m.plannedHours)}h`, sub: `Lệch ${m.hoursDiff > 0 ? "+" : ""}${formatNum(m.hoursDiff)}h` },
            { label: "Sản lượng (TT / KH)", val: `${formatNum(m.actualQty)} / ${formatNum(m.plannedQty)}`, sub: `Nghiệm thu Đạt: ${m.approvedOk}` },
            { label: "Vướng mắc / Sửa lại", val: `${m.blockers} / ${m.needsFix}`, sub: m.blockers > 0 ? "Cần hỗ trợ tháo gỡ" : "Không có vướng mắc" }
        ];
        kpiGrid.innerHTML = tiles.map(tile => `
            <div class="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/70 border border-slate-100 dark:border-slate-700">
                <div class="text-[10px] font-black uppercase tracking-wider text-slate-400">${tile.label}</div>
                <div class="text-lg font-black text-slate-800 dark:text-slate-100 mt-1">${tile.val}</div>
                <div class="text-[10px] font-semibold text-slate-500 dark:text-slate-400 mt-0.5">${tile.sub}</div>
            </div>`).join("");
    }

    // Category Breakdown
    const catEl = document.getElementById("scorecardCategories");
    if (catEl) {
        const cats = {};
        memberTasks.forEach(t => { cats[t.category] = (cats[t.category] || 0) + 1; });
        const entries = Object.entries(cats).sort((a, b) => b[1] - a[1]);
        catEl.innerHTML = entries.length === 0
            ? `<p class="text-xs text-slate-400">Chưa có công việc trong kỳ.</p>`
            : entries.map(([cat, count]) => {
                const pct = m.total > 0 ? Math.round((count / m.total) * 100) : 0;
                const barCls = (CATEGORY_COLORS[cat] || CATEGORY_COLORS["Khác"]).bar;
                return `<div class="space-y-1">
                    <div class="flex justify-between text-xs font-bold">
                        <span>${escapeHtml(cat)}</span>
                        <span>${count} việc (${pct}%)</span>
                    </div>
                    <div class="h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                        <div class="h-full ${barCls}" style="width: ${pct}%"></div>
                    </div>
                </div>`;
            }).join("");
    }

    // Active Blockers & Links
    const blockersEl = document.getElementById("scorecardBlockers");
    if (blockersEl) {
        const blockerTasks = memberTasks.filter(t => t.blocker && t.blocker.trim());
        blockersEl.innerHTML = blockerTasks.length === 0
            ? `<p class="text-xs text-slate-400">Không có vướng mắc nào được ghi nhận.</p>`
            : blockerTasks.map(t => `<div class="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-xs">
                <div class="font-bold text-rose-800 dark:text-rose-200">${escapeHtml(formatDisplayDate(t.date))} · ${escapeHtml(t.title)}</div>
                <div class="text-rose-700 dark:text-rose-300 mt-0.5">${escapeHtml(t.blocker)}</div>
            </div>`).join("");
    }

    const linksEl = document.getElementById("scorecardLinks");
    if (linksEl) {
        const linkedTasks = memberTasks.filter(t => safeUrl(t.resultLink));
        linksEl.innerHTML = linkedTasks.length === 0
            ? `<p class="text-xs text-slate-400">Chưa có link sản phẩm bàn giao.</p>`
            : linkedTasks.map(t => `<a href="${escapeHtml(safeUrl(t.resultLink))}" target="_blank" rel="noopener noreferrer"
                class="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200/60 dark:border-blue-800/50 text-xs font-bold text-blue-700 dark:text-blue-300 hover:bg-blue-100 transition-colors">
                <span class="truncate">${escapeHtml(formatDisplayDate(t.date))} · ${escapeHtml(t.title)}</span>
                <span class="material-symbols-outlined text-[15px] shrink-0">open_in_new</span>
            </a>`).join("");
    }

    // Member Task List
    const listEl = document.getElementById("scorecardTaskList");
    if (listEl) {
        listEl.innerHTML = memberTasks.length === 0
            ? `<p class="text-xs text-slate-400 py-4 text-center">Chưa có công việc nào.</p>`
            : memberTasks.map(t => {
                const st = getStatusBadgeStyle(t.status, isOverdue(t, todayYMD));
                return `<div onclick="window.closeMemberScorecard(); window.openScheduleTaskModal('${escapeHtml(t.id)}')"
                    class="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer transition-colors">
                    <div class="min-w-0">
                        <div class="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">${escapeHtml(t.title)}</div>
                        <div class="text-[10px] text-slate-400">${escapeHtml(formatDisplayDate(t.date))} · ${escapeHtml(t.timeSlot)} · ${escapeHtml(t.category)}</div>
                    </div>
                    <span class="px-2 py-0.5 rounded-md text-[10px] font-bold shrink-0 ${st.pill}">${escapeHtml(t.status)}</span>
                </div>`;
            }).join("");
    }

    const filterBtn = document.getElementById("btnScorecardFilterCalendar");
    if (filterBtn) {
        filterBtn.onclick = () => {
            const userEl = document.getElementById("scheduleUserFilter");
            if (userEl) userEl.value = info.name;
            state.myTasksOnly = canonicalName(getCurrentUser().name) === info.name;
            closeMemberScorecard();
            renderReports();
        };
    }

    dialog.showModal();
}

export function closeMemberScorecard() {
    document.getElementById("memberScorecardDialog")?.close();
}

// ===== EXCEL EXPORT & IMPORT (SHEETJS) =====

export function exportScheduleExcel() {
    if (!window.XLSX) {
        showToast("Đang tải thư viện Excel", "Vui lòng thử lại sau giây lát.", "hourglass_empty", "warning");
        return;
    }

    const { label, tasks } = getMeasurementTasksScope();
    const today = new Date();
    const todayYMD = toYMD(today);
    const plus7YMD = toYMD(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7));

    // Sheet 1: 23-column detailed plan matching team's Google Sheet structure
    const detailHeaders = [
        "Ngày", "Thứ", "Người thực hiện", "Người giao / duyệt", "Tên công việc",
        "Hạng mục / dự án", "Mô tả / kết quả bàn giao dự kiến", "Nguồn việc",
        "Khung giờ phải làm", "Deadline", "Mức ưu tiên", "Thời gian dự kiến (giờ)",
        "Số lượng kế hoạch", "Đơn vị tính", "Trạng thái", "% hoàn thành",
        "Số lượng thực tế", "Thời gian thực tế (giờ)", "Chênh lệch giờ",
        "Ngày hoàn thành thực tế", "Kết quả duyệt", "Vướng mắc cần hỗ trợ",
        "Việc tiếp theo / ngày mai"
    ];

    const detailRows = tasks.map(t => [
        formatDisplayDate(t.date),
        getWeekdayLabel(t.date),
        t.assignee,
        t.approver || "",
        t.title,
        t.category,
        t.description || t.resultLink || "",
        t.source,
        t.timeSlot,
        t.deadline ? formatDisplayDate(t.deadline) : (t.deadlineNote || ""),
        t.priority,
        t.plannedHours || 0,
        t.plannedQtyRaw || t.plannedQty || 0,
        t.unit || "",
        t.status,
        `${t.progress || 0}%`,
        t.actualQtyRaw || t.actualQty || 0,
        t.actualHours || 0,
        t.hoursDiff || 0,
        t.completedDate ? formatDisplayDate(t.completedDate) : "",
        t.approvalStatus || "Chưa duyệt",
        t.blocker || "",
        t.nextStep || ""
    ]);

    // Sheet 2: 14-column Member Measurement Dashboard
    const memberNames = [...new Set(tasks.map(t => canonicalName(t.assignee)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "vi"));
    const memberHeaders = [
        "Thành viên", "Tổng việc", "Hoàn thành", "Đang làm", "Chưa bắt đầu",
        "Quá hạn chưa xong", "Đúng hạn", "Trễ hạn", "% hoàn thành",
        "Giờ dự kiến", "Giờ thực tế", "Chênh lệch giờ", "SL kế hoạch", "SL thực tế"
    ];
    const memberRows = memberNames.map(name => {
        const m = computeTaskMetrics(tasks.filter(t => canonicalName(t.assignee) === name), todayYMD, plus7YMD);
        return [
            name, m.total, m.completed, m.inProgress, m.notStarted,
            m.overdue, m.onTime, m.late, `${m.completionRate}%`,
            m.plannedHours, m.actualHours, m.hoursDiff, m.plannedQty, m.actualQty
        ];
    });

    const wb = window.XLSX.utils.book_new();
    const ws1 = window.XLSX.utils.aoa_to_sheet([detailHeaders, ...detailRows]);
    const ws2 = window.XLSX.utils.aoa_to_sheet([memberHeaders, ...memberRows]);
    window.XLSX.utils.book_append_sheet(wb, ws1, "Ke_hoach_chi_tiet");
    window.XLSX.utils.book_append_sheet(wb, ws2, "Do_luong_thanh_vien");

    const safeFileLabel = label.replace(/[\/\s]+/g, "_");
    window.XLSX.writeFile(wb, `NEVO_Lich_Lam_Viec_${safeFileLabel}.xlsx`);
    showToast("Đã xuất Excel!", `Xuất thành công ${tasks.length} công việc (${label}).`, "download_done", "success");
}

export function triggerScheduleExcelImport() {
    if (!canCreateOwn()) {
        showToast("Từ chối", "Bạn không có quyền nhập công việc.", "block", "error");
        return;
    }
    document.getElementById("scheduleExcelInput")?.click();
}

async function handleScheduleExcelFile(file) {
    if (!file || !window.XLSX) return;
    try {
        const buffer = await file.arrayBuffer();
        const wb = window.XLSX.read(buffer, { type: "array" });
        const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes("kế hoạch") || n.toLowerCase().includes("ke_hoach")) || wb.SheetNames[0];
        const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" });

        // Find header row starting with "Ngày"
        let headerIdx = rows.findIndex(r => String(r[0] || "").trim().toLowerCase() === "ngày");
        if (headerIdx === -1) headerIdx = 0;

        const me = getCurrentUser();
        const canManage = canManageAll();
        const docsToAdd = [];

        for (let i = headerIdx + 1; i < rows.length; i++) {
            const r = rows[i];
            const title = String(r[4] || "").trim();
            const dateYMD = normalizeDateYMD(r[0]);
            if (!title || !dateYMD) continue;

            const rawAssignee = canManage ? String(r[2] || "").trim() : me.name;
            const info = resolveMemberInfo(rawAssignee || me.name);
            const desc = String(r[6] || "").trim();
            const urlMatch = desc.match(/https?:\/\/\S+/);
            const rawSource = String(r[7] || "").trim();
            const source = rawSource.toLowerCase().includes("phát sinh") ? "Việc phát sinh" : "Trong KH tháng";
            const deadlineRaw = String(r[9] || "").trim();
            const deadlineYMD = normalizeDateYMD(deadlineRaw);
            const plannedHours = parseHours(r[11]);
            const actualHours = parseHours(r[17]);
            const plannedQtyRaw = String(r[12] || "").trim();
            const actualQtyRaw = String(r[16] || "").trim();
            const status = SCHEDULE_STATUSES.includes(String(r[14] || "").trim())
                ? String(r[14]).trim()
                : "Chưa bắt đầu";

            docsToAdd.push({
                date: dateYMD,
                weekday: getWeekdayLabel(dateYMD),
                assignee: info.name,
                assigneeId: info.empId,
                department: info.dept,
                approver: String(r[3] || "").trim(),
                title,
                category: SCHEDULE_CATEGORIES.includes(String(r[5] || "").trim()) ? String(r[5]).trim() : "Khác",
                description: desc,
                resultLink: urlMatch ? urlMatch[0] : "",
                source,
                timeSlot: String(r[8] || "").trim() || "Linh hoạt",
                deadline: deadlineYMD,
                deadlineNote: deadlineYMD ? "" : deadlineRaw,
                priority: SCHEDULE_PRIORITIES.includes(String(r[10] || "").trim()) ? String(r[10]).trim() : "Trung bình",
                plannedHours,
                plannedQtyRaw,
                plannedQty: parseQty(plannedQtyRaw),
                unit: String(r[13] || "").trim() || "Việc",
                status,
                progress: status === "Hoàn thành" ? 100 : (parseInt(String(r[15] || "0").replace("%", ""), 10) || 0),
                actualQtyRaw,
                actualQty: parseQty(actualQtyRaw),
                actualHours,
                hoursDiff: round2(actualHours - plannedHours),
                completedDate: normalizeDateYMD(r[19]),
                approvalStatus: canManage && SCHEDULE_APPROVALS.includes(String(r[20] || "").trim())
                    ? String(r[20]).trim()
                    : "Chưa duyệt",
                blocker: String(r[21] || "").trim(),
                nextStep: String(r[22] || "").trim(),
                createdBy: me.name || "Import Excel",
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        }

        if (docsToAdd.length === 0) {
            showToast("Không có dữ liệu hợp lệ", "File Excel cần cột A là Ngày và cột E là Tên công việc.", "warning", "warning");
            return;
        }

        for (let i = 0; i < docsToAdd.length; i += 10) {
            const chunk = docsToAdd.slice(i, i + 10);
            await Promise.all(chunk.map(payload => addDoc(collection(db, "schedule_tasks"), payload)));
        }

        showToast("Nhập Excel thành công!", `Đã thêm ${docsToAdd.length} công việc vào Lịch làm việc.`, "upload_file", "success");
        if (window.logActivity) {
            window.logActivity("create", "Nhập lịch từ Excel", `${me.name} vừa import ${docsToAdd.length} công việc.`);
        }
    } catch (err) {
        console.error("[ScheduleManager] Excel import error:", err);
        showToast("Lỗi nhập Excel", err.message || "Không đọc được file", "error", "error");
    }
}

// ===== BULK SCHEDULE ENGINE (DAY & WEEK BATCH ENTRY) =====

const bulkState = {
    mode: "day",
    targetDate: toYMD(new Date()),
    weekAnchor: toYMD(new Date()),
    nextUid: 1,
    rows: []
};

function makeEmptyBulkRow(overrides = {}) {
    return {
        uid: bulkState.nextUid++,
        date: overrides.date || bulkState.targetDate || toYMD(new Date()),
        timeSlot: overrides.timeSlot || "Linh hoạt",
        title: overrides.title || "",
        category: overrides.category || "Hình ảnh AI",
        priority: overrides.priority || "Trung bình",
        plannedHours: overrides.plannedHours ?? "",
        plannedQtyRaw: overrides.plannedQtyRaw || "",
        unit: overrides.unit || "Ảnh",
        linkedOrderCode: overrides.linkedOrderCode || "",
        description: overrides.description || ""
    };
}

function hasUnsavedBulkRows() {
    return bulkState.rows.some(r => String(r.title || "").trim() !== "");
}

function getBulkWeekDates() {
    const [y, m, d] = (bulkState.weekAnchor || toYMD(new Date())).split("-").map(Number);
    return getWeekDates(new Date(y, m - 1, d));
}

function updateBulkFooterSummary() {
    const summaryEl = document.getElementById("bulkFooterSummary");
    if (!summaryEl) return;

    const validRows = bulkState.rows.filter(r => String(r.title || "").trim() !== "");
    let repeatMultiplier = 1;
    if (bulkState.mode === "day") {
        const checkedRepeats = Array.from(document.querySelectorAll('input[name="bulkRepeatDate"]:checked'))
            .map(el => el.value)
            .filter(v => v && v !== bulkState.targetDate);
        repeatMultiplier = 1 + new Set(checkedRepeats).size;
    }

    const extraMembers = canManageAll()
        ? Array.from(document.querySelectorAll('input[name="bulkExtraAssignees"]:checked')).length
        : 0;
    const memberMultiplier = 1 + extraMembers;

    const totalTasks = validRows.length * repeatMultiplier * memberMultiplier;
    const totalHours = round2(
        validRows.reduce((s, r) => s + parseHours(r.plannedHours), 0) * repeatMultiplier * memberMultiplier
    );

    summaryEl.textContent = `Sẽ tạo: ${totalTasks} công việc · Tổng ${formatNum(totalHours)} giờ dự kiến`;
}

function renderBulkRepeatAndWeekUI() {
    const dayCfg = document.getElementById("bulkDayConfig");
    const weekCfg = document.getElementById("bulkWeekConfig");
    const repeatWrap = document.getElementById("bulkRepeatWrap");
    const repeatBox = document.getElementById("bulkRepeatWeekdays");
    const quickWeekBtns = document.getElementById("bulkQuickWeekdayBtns");
    const btnDay = document.getElementById("btnBulkModeDay");
    const btnWeek = document.getElementById("btnBulkModeWeek");
    const isWeek = bulkState.mode === "week";

    if (btnDay && btnWeek) {
        btnDay.classList.toggle("bg-primary", !isWeek);
        btnDay.classList.toggle("text-white", !isWeek);
        btnDay.classList.toggle("text-slate-500", isWeek);
        btnWeek.classList.toggle("bg-primary", isWeek);
        btnWeek.classList.toggle("text-white", isWeek);
        btnWeek.classList.toggle("text-slate-500", !isWeek);
    }

    if (dayCfg) dayCfg.classList.toggle("hidden", isWeek);
    if (weekCfg) weekCfg.classList.toggle("hidden", !isWeek);
    if (repeatWrap) repeatWrap.classList.toggle("hidden", isWeek);
    if (quickWeekBtns) quickWeekBtns.classList.toggle("hidden", !isWeek);
    if (quickWeekBtns && isWeek) quickWeekBtns.classList.add("flex");

    const dayWdEl = document.getElementById("bulkDayWeekday");
    if (dayWdEl) dayWdEl.textContent = getWeekdayLabel(bulkState.targetDate);

    // Build week dates from targetDate (Day mode) or weekAnchor (Week mode)
    const anchorStr = isWeek ? bulkState.weekAnchor : bulkState.targetDate;
    const [ay, am, ad] = (anchorStr || toYMD(new Date())).split("-").map(Number);
    const weekDates = getWeekDates(new Date(ay, am - 1, ad));
    const shortLabels = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];

    const rangeEl = document.getElementById("bulkWeekRangeLabel");
    if (rangeEl) {
        rangeEl.textContent = `${weekDates[0].getDate()}/${weekDates[0].getMonth() + 1} – ${weekDates[6].getDate()}/${weekDates[6].getMonth() + 1}`;
    }

    if (repeatBox && !isWeek) {
        repeatBox.innerHTML = weekDates.map((dt, idx) => {
            const ymd = toYMD(dt);
            const isMain = ymd === bulkState.targetDate;
            return `<label class="inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-bold cursor-pointer ${isMain ? "bg-primary/10 border-primary/30 text-primary" : "bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"}">
                <input type="checkbox" name="bulkRepeatDate" value="${ymd}" ${isMain ? "checked disabled" : ""} class="rounded text-primary"/>
                <span>${shortLabels[idx]} (${dt.getDate()}/${dt.getMonth() + 1})</span>
            </label>`;
        }).join("");
    }

    if (quickWeekBtns && isWeek) {
        quickWeekBtns.innerHTML = weekDates.map((dt, idx) => {
            const ymd = toYMD(dt);
            return `<button type="button" data-quick-day="${ymd}"
                class="px-2 py-1 rounded-lg bg-rose-50 dark:bg-rose-950/40 text-primary hover:bg-primary hover:text-white text-[10px] font-black transition-colors">
                + ${shortLabels[idx]}
            </button>`;
        }).join("");
    }
}

function renderBulkDraftTable() {
    const headEl = document.getElementById("bulkDraftHead");
    const bodyEl = document.getElementById("bulkDraftBody");
    if (!headEl || !bodyEl) return;

    const isWeek = bulkState.mode === "week";
    const weekDates = getBulkWeekDates();
    const weekDayOpts = weekDates.map(dt => {
        const ymd = toYMD(dt);
        return { ymd, label: `${getWeekdayLabel(ymd)} (${dt.getDate()}/${dt.getMonth() + 1})` };
    });

    headEl.innerHTML = `<tr class="bg-slate-50 dark:bg-slate-800 text-[10px] font-black text-slate-500 uppercase tracking-wider border-b border-slate-200 dark:border-slate-700">
        <th scope="col" class="py-2.5 px-2 text-center w-8">#</th>
        ${isWeek ? `<th scope="col" class="py-2.5 px-2 min-w-[138px]">Ngày / Thứ</th>` : ""}
        <th scope="col" class="py-2.5 px-2 min-w-[115px]">Khung giờ</th>
        <th scope="col" class="py-2.5 px-2 min-w-[230px]">Tên công việc *</th>
        <th scope="col" class="py-2.5 px-2 min-w-[145px]">Hạng mục</th>
        <th scope="col" class="py-2.5 px-2 min-w-[100px]">Ưu tiên</th>
        <th scope="col" class="py-2.5 px-2 w-20">Giờ DK</th>
        <th scope="col" class="py-2.5 px-2 w-24">SL KH</th>
        <th scope="col" class="py-2.5 px-2 min-w-[110px]">Đơn vị</th>
        <th scope="col" class="py-2.5 px-2 min-w-[105px]">Mã đơn</th>
        <th scope="col" class="py-2.5 px-2 min-w-[160px]">Mô tả / Link</th>
        <th scope="col" class="py-2.5 px-2 text-center w-16">Thao tác</th>
    </tr>`;

    bodyEl.innerHTML = bulkState.rows.map((r, idx) => {
        if (isWeek && !weekDayOpts.some(o => o.ymd === r.date)) {
            r.date = weekDayOpts[0].ymd;
        }
        return `<tr data-row-idx="${idx}" class="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
            <td class="py-1.5 px-2 text-center text-[11px] font-black text-slate-400">${idx + 1}</td>
            ${isWeek ? `<td class="py-1.5 px-1.5">
                <select data-field="date" class="bulk-grid-input">
                    ${weekDayOpts.map(o => `<option value="${o.ymd}" ${r.date === o.ymd ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
                </select>
            </td>` : ""}
            <td class="py-1.5 px-1.5">
                <select data-field="timeSlot" class="bulk-grid-input">
                    ${SCHEDULE_TIME_SLOTS.map(ts => `<option value="${escapeHtml(ts)}" ${r.timeSlot === ts ? "selected" : ""}>${escapeHtml(ts)}</option>`).join("")}
                </select>
            </td>
            <td class="py-1.5 px-1.5">
                <input type="text" data-field="title" value="${escapeHtml(r.title)}" placeholder="Nhập tên công việc..." class="bulk-grid-input"/>
            </td>
            <td class="py-1.5 px-1.5">
                <select data-field="category" class="bulk-grid-input">
                    ${SCHEDULE_CATEGORIES.map(c => `<option value="${escapeHtml(c)}" ${r.category === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}
                </select>
            </td>
            <td class="py-1.5 px-1.5">
                <select data-field="priority" class="bulk-grid-input">
                    ${SCHEDULE_PRIORITIES.map(p => `<option value="${escapeHtml(p)}" ${r.priority === p ? "selected" : ""}>${escapeHtml(p)}</option>`).join("")}
                </select>
            </td>
            <td class="py-1.5 px-1.5">
                <input type="number" step="0.25" min="0" data-field="plannedHours" value="${escapeHtml(r.plannedHours)}" placeholder="1.5" class="bulk-grid-input text-right"/>
            </td>
            <td class="py-1.5 px-1.5">
                <input type="text" data-field="plannedQtyRaw" value="${escapeHtml(r.plannedQtyRaw)}" placeholder="10" class="bulk-grid-input text-right"/>
            </td>
            <td class="py-1.5 px-1.5">
                <select data-field="unit" class="bulk-grid-input">
                    ${SCHEDULE_UNITS.map(u => `<option value="${escapeHtml(u)}" ${r.unit === u ? "selected" : ""}>${escapeHtml(u)}</option>`).join("")}
                </select>
            </td>
            <td class="py-1.5 px-1.5">
                <input type="text" data-field="linkedOrderCode" list="scheduleOrdersDatalist" value="${escapeHtml(r.linkedOrderCode)}" placeholder="NV-..." class="bulk-grid-input"/>
            </td>
            <td class="py-1.5 px-1.5">
                <input type="text" data-field="description" value="${escapeHtml(r.description)}" placeholder="Mô tả / link..." class="bulk-grid-input"/>
            </td>
            <td class="py-1.5 px-1.5 text-center whitespace-nowrap">
                <button type="button" data-action="duplicate" title="Nhân bản dòng" class="p-1 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors">
                    <span class="material-symbols-outlined text-[15px]">content_copy</span>
                </button>
                <button type="button" data-action="remove" title="Xóa dòng" class="p-1 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors">
                    <span class="material-symbols-outlined text-[15px]">close</span>
                </button>
            </td>
        </tr>`;
    }).join("");

    updateBulkFooterSummary();
}

function renderBulkMultiAssign() {
    const wrap = document.getElementById("bulkMultiAssignWrapper");
    const list = document.getElementById("bulkMultiAssignList");
    const assigneeEl = document.getElementById("bulkAssignee");
    if (!wrap || !list || !assigneeEl) return;

    if (!canManageAll()) {
        wrap.classList.add("hidden");
        wrap.classList.remove("flex");
        list.innerHTML = "";
        return;
    }

    const mainAssignee = assigneeEl.value;
    const others = Array.from(assigneeEl.options).map(o => o.value).filter(n => n && n !== mainAssignee);
    wrap.classList.remove("hidden");
    wrap.classList.add("flex");
    list.innerHTML = others.map(name => `
        <label class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] font-semibold cursor-pointer">
            <input type="checkbox" name="bulkExtraAssignees" value="${escapeHtml(name)}" class="rounded text-primary"/>
            <span>${escapeHtml(name)}</span>
        </label>`).join("");
}

function renderBulkOrderPicker() {
    const listEl = document.getElementById("bulkOrderPickerList");
    const badgeEl = document.getElementById("bulkOrderCountBadge");
    const showAllWrap = document.getElementById("bulkShowAllOrdersWrap");
    const showAllToggle = document.getElementById("bulkShowAllOrdersToggle");
    const searchVal = (document.getElementById("bulkOrderSearchInput")?.value || "").trim().toLowerCase();
    const assignee = document.getElementById("bulkAssignee")?.value || canonicalName(getCurrentUser().name);

    const canManage = canManageAll();
    if (showAllWrap) showAllWrap.classList.toggle("hidden", !canManage);

    const allOrdersForUser = getAssignedActiveOrders(assignee, canManage && Boolean(showAllToggle?.checked));
    if (badgeEl) badgeEl.textContent = String(getAssignedActiveOrders(assignee, false).length);
    if (!listEl) return;

    const filtered = allOrdersForUser.filter(o => {
        if (!searchVal) return true;
        return `${o.code || ""} ${o.title || ""} ${o.department || ""}`.toLowerCase().includes(searchVal);
    });

    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="col-span-full py-4 text-center text-xs text-slate-400">Không có đơn hàng mở phù hợp cho ${escapeHtml(assignee)}.</div>`;
        return;
    }

    listEl.innerHTML = filtered.slice(0, 45).map(o => `
        <label class="flex items-start gap-2 p-2.5 rounded-xl bg-white dark:bg-slate-800 border border-rose-200/60 dark:border-slate-700 hover:border-primary/50 cursor-pointer transition-colors">
            <input type="checkbox" name="bulkOrderPick" value="${escapeHtml(o.id)}" class="mt-0.5 rounded text-primary"/>
            <div class="min-w-0">
                <div class="flex items-center gap-1.5 text-[10px] font-black text-primary">
                    <span>#${escapeHtml(o.code || "")}</span>
                    <span class="px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-bold">${escapeHtml(o.category || "Khác")}</span>
                </div>
                <p class="text-xs font-bold text-slate-800 dark:text-slate-100 line-clamp-1">${escapeHtml(o.title || "")}</p>
                <p class="text-[10px] text-slate-400">${o.deadline ? `Hạn: ${escapeHtml(formatDisplayDate(normalizeDateYMD(o.deadline)))}` : escapeHtml(o.status || "")}</p>
            </div>
        </label>`).join("");
}

function appendParsedOrPickedRows(newRows) {
    if (!newRows || newRows.length === 0) return;
    // Strip trailing completely blank rows before appending, or replace if all empty
    while (
        bulkState.rows.length > 0 &&
        !String(bulkState.rows[bulkState.rows.length - 1].title || "").trim()
    ) {
        bulkState.rows.pop();
    }
    bulkState.rows.push(...newRows);
    renderBulkDraftTable();
}

export function openBulkScheduleModal(opts = {}) {
    if (!canCreateOwn()) {
        showToast("Từ chối", "Bạn không có quyền thêm công việc vào lịch.", "block", "error");
        return;
    }
    initNativeDialogs();
    refreshScheduleFilters();

    const dialog = document.getElementById("bulkScheduleDialog");
    if (!dialog) return;

    const me = getCurrentUser();
    const canManage = canManageAll();
    const mode = opts.mode === "week" ? "week" : "day";
    const fallbackDate = toYMD(state.anchorDate || new Date());
    const initDate = normalizeDateYMD(opts.date) || fallbackDate;

    bulkState.mode = mode;
    bulkState.targetDate = initDate;
    bulkState.weekAnchor = initDate;
    bulkState.rows = Array.from({ length: 5 }, () => makeEmptyBulkRow({ date: initDate }));

    const assigneeEl = document.getElementById("bulkAssignee");
    const targetAssignee = opts.assignee || (document.getElementById("scheduleUserFilter")?.value !== "all"
        ? document.getElementById("scheduleUserFilter").value
        : canonicalName(me.name));
    if (assigneeEl) {
        if (targetAssignee && !Array.from(assigneeEl.options).some(o => o.value === targetAssignee)) {
            const opt = document.createElement("option");
            opt.value = targetAssignee;
            opt.textContent = targetAssignee;
            assigneeEl.appendChild(opt);
        }
        assigneeEl.value = targetAssignee;
        assigneeEl.disabled = !canManage;
    }

    const targetDateEl = document.getElementById("bulkTargetDate");
    if (targetDateEl) targetDateEl.value = bulkState.targetDate;
    const weekAnchorEl = document.getElementById("bulkWeekAnchorDate");
    if (weekAnchorEl) weekAnchorEl.value = bulkState.weekAnchor;

    document.getElementById("bulkOrderPickerPanel")?.classList.add("hidden");
    document.getElementById("bulkPastePanel")?.classList.add("hidden");

    renderBulkMultiAssign();
    renderBulkRepeatAndWeekUI();
    renderBulkOrderPicker();
    renderBulkDraftTable();

    dialog.showModal();
    document.querySelector('#bulkDraftBody input[data-field="title"]')?.focus();
}

export function closeBulkScheduleModal(force = false) {
    const dialog = document.getElementById("bulkScheduleDialog");
    if (!dialog || !dialog.open) return;
    if (!force && hasUnsavedBulkRows()) {
        if (!window.confirm("Bạn đang có công việc đã nhập chưa lưu. Đóng hộp thoại?")) return;
    }
    dialog.close();
}

export function setBulkScheduleMode(mode) {
    bulkState.mode = mode === "week" ? "week" : "day";
    if (bulkState.mode === "week") {
        bulkState.weekAnchor = bulkState.targetDate || bulkState.weekAnchor || toYMD(new Date());
        const weekEl = document.getElementById("bulkWeekAnchorDate");
        if (weekEl) weekEl.value = bulkState.weekAnchor;
    }
    renderBulkRepeatAndWeekUI();
    renderBulkDraftTable();
}

export function addBulkDraftRows(count = 1, presetDate = "") {
    const dateVal = presetDate || (bulkState.mode === "week" ? toYMD(getBulkWeekDates()[0]) : bulkState.targetDate);
    for (let i = 0; i < count; i++) {
        bulkState.rows.push(makeEmptyBulkRow({ date: dateVal }));
    }
    renderBulkDraftTable();
}

export function resetBulkDraftRows() {
    if (hasUnsavedBulkRows() && !window.confirm("Xóa toàn bộ nội dung đang nhập để làm mới 5 dòng trống?")) return;
    const defaultDate = bulkState.mode === "week" ? toYMD(getBulkWeekDates()[0]) : bulkState.targetDate;
    bulkState.rows = Array.from({ length: 5 }, () => makeEmptyBulkRow({ date: defaultDate }));
    renderBulkDraftTable();
}

function parseWeekdayToken(token, weekDates) {
    const t = String(token || "").trim().toLowerCase();
    const map = { "t2": 0, "thứ 2": 0, "t3": 1, "thứ 3": 1, "t4": 2, "thứ 4": 2, "t5": 3, "thứ 5": 3, "t6": 4, "thứ 6": 4, "t7": 5, "thứ 7": 5, "cn": 6, "chủ nhật": 6 };
    if (map[t] !== undefined && weekDates[map[t]]) return toYMD(weekDates[map[t]]);
    return "";
}

function parseBulkPasteText() {
    const raw = document.getElementById("bulkPasteInput")?.value || "";
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) {
        showToast("Chưa có nội dung", "Hãy dán ít nhất 1 dòng công việc trước khi tách.", "warning", "warning");
        return;
    }

    const weekDates = getBulkWeekDates();
    const defaultDate = bulkState.mode === "week" ? toYMD(weekDates[0]) : bulkState.targetDate;
    const parsedRows = [];

    lines.forEach(line => {
        // Strip leading bullets like "- ", "* ", "1. "
        let clean = line.replace(/^([-*•]|\d+[.)])\s+/, "").trim();
        let rowDate = defaultDate;

        // Check weekday prefix like "T2:" or "Thứ 4:"
        const wdMatch = clean.match(/^(t[2-7]|cn|thứ\s*[2-7]|chủ\s*nhật)\s*[:\-–]\s*(.+)$/i);
        if (wdMatch) {
            const matchedYmd = parseWeekdayToken(wdMatch[1].replace(/\s+/g, " "), weekDates);
            if (matchedYmd) rowDate = matchedYmd;
            clean = wdMatch[2].trim();
        }

        // Split by tab (Excel/Sheet paste) or pipe "|"
        const parts = clean.includes("\t")
            ? clean.split("\t").map(s => s.trim())
            : clean.split("|").map(s => s.trim());

        let titlePart = parts[0] || "";
        let timeSlot = "Linh hoạt";
        const timePrefix = titlePart.match(/^(\d{1,2}[:h]\d{0,2}\s*[-–]\s*\d{1,2}[:h]\d{0,2}|cả\s*ngày)\s+(.+)$/i);
        if (timePrefix) {
            const normSlot = timePrefix[1].replace(/h/g, ":").replace(/\s*[-–]\s*/g, "–").trim();
            const foundSlot = SCHEDULE_TIME_SLOTS.find(s => s.toLowerCase() === normSlot.toLowerCase());
            if (foundSlot) timeSlot = foundSlot;
            titlePart = timePrefix[2].trim();
        }

        if (!titlePart) return;
        const catGuess = SCHEDULE_CATEGORIES.find(c => c.toLowerCase() === (parts[1] || "").toLowerCase()) || "Hình ảnh AI";
        const hrs = parts[2] ? parseHours(parts[2]) : "";
        const qty = parts[3] || "";
        const unit = SCHEDULE_UNITS.find(u => u.toLowerCase() === (parts[4] || "").toLowerCase()) || "Ảnh";
        const desc = parts[5] || "";

        parsedRows.push(makeEmptyBulkRow({
            date: rowDate,
            timeSlot,
            title: titlePart,
            category: catGuess,
            plannedHours: hrs || "",
            plannedQtyRaw: qty,
            unit,
            description: desc
        }));
    });

    if (parsedRows.length === 0) {
        showToast("Không tách được dòng nào", "Vui lòng kiểm tra lại định dạng văn bản vừa dán.", "warning", "warning");
        return;
    }

    appendParsedOrPickedRows(parsedRows);
    document.getElementById("bulkPasteInput").value = "";
    document.getElementById("bulkPastePanel")?.classList.add("hidden");
    showToast("Đã đưa vào bảng!", `Đã tách ${parsedRows.length} công việc vào bảng nhập liệu.`, "content_paste_go", "success");
}

function loadPrevWeekTemplate() {
    const assignee = canonicalName(document.getElementById("bulkAssignee")?.value || getCurrentUser().name);
    if (bulkState.mode !== "week") {
        bulkState.mode = "week";
        bulkState.weekAnchor = bulkState.targetDate || toYMD(new Date());
        const weekEl = document.getElementById("bulkWeekAnchorDate");
        if (weekEl) weekEl.value = bulkState.weekAnchor;
        renderBulkRepeatAndWeekUI();
    }

    const targetWeek = getBulkWeekDates();
    const prevWeekStart = new Date(targetWeek[0]);
    prevWeekStart.setDate(prevWeekStart.getDate() - 7);
    const prevWeekDates = getWeekDates(prevWeekStart);
    const prevWeekYmds = prevWeekDates.map(toYMD);

    const prevTasks = state.tasks.filter(
        t => canonicalName(t.assignee) === assignee && prevWeekYmds.includes(t.date)
    );

    if (prevTasks.length === 0) {
        showToast("Không có dữ liệu tuần trước", `${assignee} chưa có công việc nào trong tuần trước để sao chép.`, "info", "info");
        return;
    }

    const clonedRows = prevTasks.map(t => {
        const dayIdx = prevWeekYmds.indexOf(t.date);
        const mappedDate = toYMD(targetWeek[dayIdx >= 0 ? dayIdx : 0]);
        return makeEmptyBulkRow({
            date: mappedDate,
            timeSlot: t.timeSlot || "Linh hoạt",
            title: t.title,
            category: t.category || "Hình ảnh AI",
            priority: t.priority || "Trung bình",
            plannedHours: t.plannedHours || "",
            plannedQtyRaw: t.plannedQtyRaw || "",
            unit: t.unit || "Việc",
            linkedOrderCode: t.linkedOrderCode || "",
            description: t.description || ""
        });
    });

    appendParsedOrPickedRows(clonedRows);
    showToast("Đã sao chép khung tuần!", `Đã nạp ${clonedRows.length} việc từ tuần trước của ${assignee}.`, "history", "success");
}

function insertSelectedOrdersToBulk() {
    const pickedIds = Array.from(document.querySelectorAll('input[name="bulkOrderPick"]:checked')).map(el => el.value);
    if (pickedIds.length === 0) {
        showToast("Chưa chọn đơn hàng", "Hãy tick ít nhất 1 đơn hàng muốn đưa vào lịch.", "warning", "warning");
        return;
    }

    const normFn = window._normalizeDateToYMD || normalizeDateYMD;
    const weekYmds = getBulkWeekDates().map(toYMD);
    const fallbackDate = bulkState.mode === "week" ? weekYmds[0] : bulkState.targetDate;

    const pickedRows = pickedIds.map(id => {
        const o = (window.allOrdersData || []).find(x => x.id === id);
        if (!o) return null;
        const orderDate = normFn(o.deployDate) || normFn(o.deadline);
        const rowDate = bulkState.mode === "week"
            ? (weekYmds.includes(orderDate) ? orderDate : fallbackDate)
            : bulkState.targetDate;

        return makeEmptyBulkRow({
            date: rowDate,
            timeSlot: "Linh hoạt",
            title: o.title || `Đơn #${o.code || ""}`,
            category: mapOrderCategoryToSchedule(o.category),
            priority: "Cao",
            unit: "Việc",
            linkedOrderCode: o.code || "",
            description: o.content ? String(o.content).slice(0, 200) : ""
        });
    }).filter(Boolean);

    appendParsedOrPickedRows(pickedRows);
    document.getElementById("bulkOrderPickerPanel")?.classList.add("hidden");
    showToast("Đã thêm đơn vào bảng!", `Đã đưa ${pickedRows.length} đơn hàng vào bảng lập lịch.`, "assignment_add", "success");
}

export async function submitBulkScheduleTasks() {
    if (!canCreateOwn()) {
        showToast("Từ chối", "Bạn không có quyền thêm công việc mới.", "block", "error");
        return;
    }

    const validRows = bulkState.rows.filter(r => String(r.title || "").trim() !== "");
    if (validRows.length === 0) {
        showToast("Bảng chưa có việc", "Vui lòng nhập ít nhất 1 tên công việc trước khi lưu.", "warning", "warning");
        return;
    }

    const me = getCurrentUser();
    const canManage = canManageAll();
    const rawAssignee = canManage
        ? (document.getElementById("bulkAssignee")?.value || me.name)
        : canonicalName(me.name);
    const extraAssignees = canManage
        ? Array.from(document.querySelectorAll('input[name="bulkExtraAssignees"]:checked')).map(el => el.value).filter(Boolean)
        : [];
    const targetMembers = [...new Set([canonicalName(rawAssignee), ...extraAssignees.map(canonicalName)])].filter(Boolean);

    const defaultSource = document.getElementById("bulkDefaultSource")?.value || "Trong KH tháng";
    const approver = (document.getElementById("bulkApprover")?.value || "").trim();

    let repeatDates = [bulkState.targetDate];
    if (bulkState.mode === "day") {
        const extraDates = Array.from(document.querySelectorAll('input[name="bulkRepeatDate"]:checked')).map(el => el.value).filter(Boolean);
        repeatDates = [...new Set([bulkState.targetDate, ...extraDates])].sort();
    }

    const payloads = [];
    targetMembers.forEach(memberName => {
        const info = resolveMemberInfo(memberName);
        validRows.forEach(r => {
            const datesForRow = bulkState.mode === "week" ? [r.date || bulkState.weekAnchor] : repeatDates;
            const plannedHours = parseHours(r.plannedHours);
            const plannedQtyRaw = String(r.plannedQtyRaw || "").trim();
            const desc = String(r.description || "").trim();
            const urlMatch = desc.match(/https?:\/\/\S+/);

            datesForRow.forEach(dateYMD => {
                payloads.push({
                    date: dateYMD,
                    weekday: getWeekdayLabel(dateYMD),
                    assignee: info.name,
                    assigneeId: info.empId,
                    department: info.dept,
                    approver,
                    title: String(r.title).trim(),
                    category: r.category || "Hình ảnh AI",
                    source: defaultSource,
                    timeSlot: r.timeSlot || "Linh hoạt",
                    deadline: "",
                    priority: r.priority || "Trung bình",
                    plannedHours,
                    plannedQtyRaw,
                    plannedQty: parseQty(plannedQtyRaw),
                    unit: r.unit || "Việc",
                    linkedOrderCode: String(r.linkedOrderCode || "").trim(),
                    description: desc,
                    resultLink: urlMatch ? urlMatch[0] : "",
                    status: "Chưa bắt đầu",
                    progress: 0,
                    actualHours: 0,
                    hoursDiff: round2(-plannedHours),
                    actualQtyRaw: "",
                    actualQty: 0,
                    completedDate: "",
                    approvalStatus: "Chưa duyệt",
                    blocker: "",
                    nextStep: "",
                    createdBy: me.name || info.name,
                    updatedBy: me.name || info.name,
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                });
            });
        });
    });

    const submitBtn = document.getElementById("btnSubmitBulkTasks");
    if (submitBtn) submitBtn.disabled = true;

    try {
        for (let i = 0; i < payloads.length; i += 10) {
            const chunk = payloads.slice(i, i + 10);
            await Promise.all(chunk.map(p => addDoc(collection(db, "schedule_tasks"), p)));
        }

        showToast("Đã lưu hàng loạt!", `Đã tạo thành công ${payloads.length} công việc lên Lịch làm việc.`, "playlist_add_check", "success");
        if (window.logActivity) {
            window.logActivity("create", "Thêm hàng loạt lịch làm việc", `${me.name} vừa thêm ${payloads.length} công việc (${bulkState.mode === "week" ? "Theo Tuần" : "Theo Ngày"}).`);
        }
        bulkState.rows = [];
        closeBulkScheduleModal(true);
    } catch (err) {
        console.error("[ScheduleManager] Bulk save error:", err);
        showToast("Lỗi lưu hàng loạt", err.message || "Không thể ghi lên Firestore", "error", "error");
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

// ===== EVENT BINDINGS & GLOBAL EXPORTS =====

function bindScheduleUIEvents() {
    const filterIds = [
        "scheduleDeptFilter",
        "scheduleUserFilter",
        "scheduleCategoryFilter",
        "scheduleStatusFilter",
        "scheduleSourceFilter",
        "kpiScopeSelect"
    ];
    filterIds.forEach(id => {
        document.getElementById(id)?.addEventListener("change", () => {
            if (id === "scheduleDeptFilter") refreshScheduleFilters();
            if (id === "scheduleUserFilter") {
                const me = canonicalName(getCurrentUser().name);
                state.myTasksOnly = document.getElementById(id).value === me;
                updateMyTasksButtonUI();
            }
            renderReports();
        });
    });

    document.getElementById("scheduleSearchInput")?.addEventListener("input", () => renderReports());

    document.getElementById("btnScheduleMyTasks")?.addEventListener("click", () => {
        state.myTasksOnly = !state.myTasksOnly;
        const userEl = document.getElementById("scheduleUserFilter");
        const myName = canonicalName(getCurrentUser().name);
        if (userEl) {
            if (state.myTasksOnly && myName) {
                if (!Array.from(userEl.options).some(o => o.value === myName)) {
                    const opt = document.createElement("option");
                    opt.value = myName;
                    opt.textContent = myName;
                    userEl.appendChild(opt);
                }
                userEl.value = myName;
            } else {
                userEl.value = "all";
            }
        }
        updateMyTasksButtonUI();
        renderReports();
    });

    document.getElementById("btnResetScheduleFilters")?.addEventListener("click", () => {
        state.myTasksOnly = false;
        ["scheduleDeptFilter", "scheduleUserFilter", "scheduleCategoryFilter", "scheduleStatusFilter", "scheduleSourceFilter"].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = "all";
        });
        const searchEl = document.getElementById("scheduleSearchInput");
        if (searchEl) searchEl.value = "";
        updateMyTasksButtonUI();
        refreshScheduleFilters();
        renderReports();
    });

    // Single modal form controls
    document.getElementById("scheduleTaskForm")?.addEventListener("submit", (e) => saveScheduleTask(e, false));
    document.getElementById("btnSaveAndContinueTask")?.addEventListener("click", () => {
        const form = document.getElementById("scheduleTaskForm");
        if (form && !form.reportValidity()) return;
        saveScheduleTask(null, true);
    });
    document.getElementById("btnToggleSingleOrderPicker")?.addEventListener("click", () => {
        const box = document.getElementById("singleOrderPickerBox");
        if (!box) return;
        box.classList.toggle("hidden");
        if (!box.classList.contains("hidden")) renderSingleOrderPicker();
    });
    document.getElementById("singleOrderPickerList")?.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-single-order-id]");
        if (!btn) return;
        const order = (window.allOrdersData || []).find(o => o.id === btn.dataset.singleOrderId);
        if (!order) return;
        const normFn = window._normalizeDateToYMD || normalizeDateYMD;
        document.getElementById("taskTitle").value = order.title || `Đơn #${order.code || ""}`;
        document.getElementById("taskCategory").value = mapOrderCategoryToSchedule(order.category);
        document.getElementById("taskLinkedOrder").value = order.code || "";
        if (order.deadline) document.getElementById("taskDeadline").value = normFn(order.deadline);
        if (order.content && !document.getElementById("taskDescription").value) {
            document.getElementById("taskDescription").value = order.content;
        }
        document.getElementById("singleOrderPickerBox")?.classList.add("hidden");
    });

    document.getElementById("taskDate")?.addEventListener("change", (e) => {
        const w = document.getElementById("taskWeekdayBadge");
        if (w) w.textContent = getWeekdayLabel(e.target.value);
    });
    document.getElementById("taskStatus")?.addEventListener("change", (e) => {
        const st = e.target.value;
        const pInput = document.getElementById("taskProgress");
        const pRange = document.getElementById("taskProgressRange");
        const compInput = document.getElementById("taskCompletedDate");
        if (st === "Hoàn thành") {
            if (pInput) pInput.value = 100;
            if (pRange) pRange.value = 100;
            if (compInput && !compInput.value) compInput.value = toYMD(new Date());
        } else if (st === "Chưa bắt đầu") {
            if (pInput) pInput.value = 0;
            if (pRange) pRange.value = 0;
        }
    });
    document.getElementById("taskProgressRange")?.addEventListener("input", (e) => {
        const pInput = document.getElementById("taskProgress");
        if (pInput) pInput.value = e.target.value;
    });
    document.getElementById("taskProgress")?.addEventListener("input", (e) => {
        const pRange = document.getElementById("taskProgressRange");
        if (pRange) pRange.value = e.target.value;
    });
    document.getElementById("taskPlannedHours")?.addEventListener("input", updateHoursDiffHint);
    document.getElementById("taskActualHours")?.addEventListener("input", updateHoursDiffHint);

    document.getElementById("btnDeferScheduleTask")?.addEventListener("click", () => {
        const box = document.getElementById("taskDeferBox");
        const dateEl = document.getElementById("taskDeferDate");
        const curDate = document.getElementById("taskDate")?.value || toYMD(new Date());
        if (dateEl && !dateEl.value) {
            const [y, m, d] = curDate.split("-").map(Number);
            dateEl.value = toYMD(new Date(y, m - 1, d + 1));
        }
        box?.classList.toggle("hidden");
    });
    document.getElementById("btnConfirmDeferTask")?.addEventListener("click", confirmDeferTask);
    document.getElementById("btnDeleteScheduleTask")?.addEventListener("click", deleteScheduleTask);

    document.getElementById("scheduleExcelInput")?.addEventListener("change", (e) => {
        const file = e.target.files?.[0];
        if (file) handleScheduleExcelFile(file);
        e.target.value = "";
    });

    // Bulk modal controls & delegated table events (preserves focus + Vietnamese IME)
    document.getElementById("bulkAssignee")?.addEventListener("change", () => {
        renderBulkMultiAssign();
        renderBulkOrderPicker();
    });
    document.getElementById("bulkTargetDate")?.addEventListener("change", (e) => {
        bulkState.targetDate = e.target.value || toYMD(new Date());
        renderBulkRepeatAndWeekUI();
        updateBulkFooterSummary();
    });
    document.getElementById("bulkWeekAnchorDate")?.addEventListener("change", (e) => {
        bulkState.weekAnchor = e.target.value || toYMD(new Date());
        renderBulkRepeatAndWeekUI();
        renderBulkDraftTable();
    });
    document.getElementById("btnBulkThisWeek")?.addEventListener("click", () => {
        bulkState.weekAnchor = toYMD(new Date());
        const el = document.getElementById("bulkWeekAnchorDate");
        if (el) el.value = bulkState.weekAnchor;
        renderBulkRepeatAndWeekUI();
        renderBulkDraftTable();
    });
    document.getElementById("btnBulkNextWeek")?.addEventListener("click", () => {
        const now = new Date();
        now.setDate(now.getDate() + 7);
        bulkState.weekAnchor = toYMD(now);
        const el = document.getElementById("bulkWeekAnchorDate");
        if (el) el.value = bulkState.weekAnchor;
        renderBulkRepeatAndWeekUI();
        renderBulkDraftTable();
    });
    document.getElementById("bulkRepeatWeekdays")?.addEventListener("change", updateBulkFooterSummary);
    document.getElementById("bulkMultiAssignList")?.addEventListener("change", updateBulkFooterSummary);
    document.getElementById("bulkQuickWeekdayBtns")?.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-quick-day]");
        if (!btn) return;
        addBulkDraftRows(1, btn.dataset.quickDay);
        const rows = document.querySelectorAll('#bulkDraftBody input[data-field="title"]');
        rows[rows.length - 1]?.focus();
    });

    document.getElementById("btnToggleBulkOrderPicker")?.addEventListener("click", () => {
        const panel = document.getElementById("bulkOrderPickerPanel");
        if (!panel) return;
        panel.classList.toggle("hidden");
        if (!panel.classList.contains("hidden")) renderBulkOrderPicker();
    });
    document.getElementById("bulkOrderSearchInput")?.addEventListener("input", renderBulkOrderPicker);
    document.getElementById("bulkShowAllOrdersToggle")?.addEventListener("change", renderBulkOrderPicker);
    document.getElementById("btnInsertSelectedOrdersToBulk")?.addEventListener("click", insertSelectedOrdersToBulk);

    document.getElementById("btnToggleBulkPaste")?.addEventListener("click", () => {
        const panel = document.getElementById("bulkPastePanel");
        if (!panel) return;
        panel.classList.toggle("hidden");
        if (!panel.classList.contains("hidden")) document.getElementById("bulkPasteInput")?.focus();
    });
    document.getElementById("btnParseBulkPaste")?.addEventListener("click", parseBulkPasteText);
    document.getElementById("btnLoadPrevWeekTemplate")?.addEventListener("click", loadPrevWeekTemplate);

    const bulkBody = document.getElementById("bulkDraftBody");
    if (bulkBody) {
        const syncField = (e) => {
            const target = e.target;
            const field = target?.dataset?.field;
            const tr = target?.closest("tr[data-row-idx]");
            if (!field || !tr) return;
            const idx = Number(tr.dataset.rowIdx);
            if (!bulkState.rows[idx]) return;
            bulkState.rows[idx][field] = target.value;
            updateBulkFooterSummary();
        };
        bulkBody.addEventListener("input", syncField);
        bulkBody.addEventListener("change", syncField);

        bulkBody.addEventListener("keydown", (e) => {
            if (e.key !== "Enter" || e.target?.dataset?.field !== "title") return;
            e.preventDefault();
            const tr = e.target.closest("tr[data-row-idx]");
            const idx = Number(tr?.dataset?.rowIdx ?? -1);
            const allTitleInputs = bulkBody.querySelectorAll('input[data-field="title"]');
            if (idx >= 0 && idx + 1 < allTitleInputs.length) {
                allTitleInputs[idx + 1].focus();
            } else {
                const prevDate = bulkState.rows[idx]?.date || "";
                addBulkDraftRows(1, prevDate);
                const updatedInputs = bulkBody.querySelectorAll('input[data-field="title"]');
                updatedInputs[updatedInputs.length - 1]?.focus();
            }
        });

        bulkBody.addEventListener("click", (e) => {
            const btn = e.target.closest("button[data-action]");
            if (!btn) return;
            const tr = btn.closest("tr[data-row-idx]");
            const idx = Number(tr?.dataset?.rowIdx ?? -1);
            if (idx < 0 || !bulkState.rows[idx]) return;

            if (btn.dataset.action === "duplicate") {
                const clone = { ...bulkState.rows[idx], uid: bulkState.nextUid++ };
                bulkState.rows.splice(idx + 1, 0, clone);
                renderBulkDraftTable();
            } else if (btn.dataset.action === "remove") {
                if (bulkState.rows.length <= 1) {
                    bulkState.rows = [makeEmptyBulkRow({ date: bulkState.rows[0].date })];
                } else {
                    bulkState.rows.splice(idx, 1);
                }
                renderBulkDraftTable();
            }
        });
    }
}

function updateMyTasksButtonUI() {
    const btn = document.getElementById("btnScheduleMyTasks");
    if (!btn) return;
    btn.classList.toggle("bg-primary", state.myTasksOnly);
    btn.classList.toggle("text-white", state.myTasksOnly);
    btn.classList.toggle("border-primary", state.myTasksOnly);
    btn.classList.toggle("bg-white", !state.myTasksOnly);
    btn.classList.toggle("text-slate-600", !state.myTasksOnly);
}

// Register globals for HTML onclick attributes & cross-module callbacks
window.switchScheduleView = switchScheduleView;
window.renderWeeklySchedule = renderWeeklySchedule;
window.renderMonthlyCalendar = renderMonthlyCalendar;
window.renderListSchedule = renderListSchedule;
window.renderCategoryStats = renderCategoryStats;
window.renderReports = renderReports;
window.changeWeek = changeWeek;
window.changeMonth = changeMonth;
window.navigateSchedulePeriod = navigateSchedulePeriod;
window.refreshScheduleFilters = refreshScheduleFilters;
window.openScheduleTaskModal = openScheduleTaskModal;
window.closeScheduleTaskModal = closeScheduleTaskModal;
window.openBulkScheduleModal = openBulkScheduleModal;
window.closeBulkScheduleModal = closeBulkScheduleModal;
window.setBulkScheduleMode = setBulkScheduleMode;
window.addBulkDraftRows = addBulkDraftRows;
window.resetBulkDraftRows = resetBulkDraftRows;
window.submitBulkScheduleTasks = submitBulkScheduleTasks;
window.openMemberScorecard = openMemberScorecard;
window.closeMemberScorecard = closeMemberScorecard;
window.quickCycleTaskStatus = quickCycleTaskStatus;
window.inlineUpdateTaskField = inlineUpdateTaskField;
window.jumpToOrderByCode = jumpToOrderByCode;
window.openScheduleFromOrder = openScheduleFromOrder;
window.exportScheduleExcel = exportScheduleExcel;
window.triggerScheduleExcelImport = triggerScheduleExcelImport;

function initScheduleManager() {
    initNativeDialogs();
    bindScheduleUIEvents();
    startTasksListener();
    if (canViewSchedule() && window.currentPage === "reports") {
        renderReports();
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initScheduleManager);
} else {
    initScheduleManager();
}
