/*
  COLLABORATION, KANBAN, SLA ANALYTICS, WORKLOAD HEATMAP & 4-WAY CROSS-MODULE SYNC
  Connects Orders <-> Schedule Tasks <-> Models Directory <-> New Products
*/

import {
    db, collection, addDoc, getDocs, doc, updateDoc,
    query, where, onSnapshot, serverTimestamp
} from "./firebase-service.js";
import { checkPermission, getCurrentUser } from "./auth-service.js";
import {
    escapeHtml, escapeJsStr, safeUrl, parseCurrencyNumber,
    toLocalYMD, isCompletedOnTimeLocal, toEpochMs, stripHtmlToText
} from "./security-utils.js";
import { showToast, navigateTo } from "./ui-service.js";
import { createAppNotification } from "./notifications-palette.js";

const collabState = {
    models: [],
    unsubModels: null,
    unsubComments: null,
    currentOrderId: null,
    comments: [],
    analyticsDays: 30,
    charts: { trend: null, category: null, staff: null }
};

window.allModelsData = [];

// =====================================================================
// 1. LIVE MODELS SYNC & BOOKING CONFLICT / COST INTEGRATION
// =====================================================================

function startModelsSync() {
    if (!db || collabState.unsubModels) return;
    collabState.unsubModels = onSnapshot(collection(db, 'models'), (snap) => {
        const list = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() }));
        list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'vi'));
        collabState.models = list;
        window.allModelsData = list;
        if (collabState.currentOrderId) {
            const ord = (window.allOrdersData || []).find(o => o.id === collabState.currentOrderId);
            if (ord) renderOrderModelBookingPanel(ord);
        }
    }, () => {});
}

export function getModelConflictsForDate(modelName, deployDateYMD, excludeOrderId = '') {
    if (!modelName || !deployDateYMD) return [];
    return (window.allOrdersData || []).filter(o => {
        if (!o || o.id === excludeOrderId) return false;
        if (['Hoàn thành', 'Hủy', 'Từ chối'].includes(o.status)) return false;
        const d = toLocalYMD(o.deployDate);
        if (d !== deployDateYMD) return false;
        return Array.isArray(o.bookedModels) && o.bookedModels.includes(modelName);
    });
}

export function renderOrderModelBookingPanel(order) {
    const container = document.getElementById('editOrderModelsPanel');
    if (!container) return;

    const selected = new Set(Array.isArray(order?.bookedModels) ? order.bookedModels : []);
    const deployDate = document.getElementById('editOrderDeployDate')?.value || toLocalYMD(order?.deployDate);
    const canEdit = checkPermission('stylist') || checkPermission('costs') || checkPermission('orders_edit_any');

    if (collabState.models.length === 0) {
        container.innerHTML = `<p class="text-xs text-slate-400 italic">Chưa có hồ sơ Model trong danh bạ (<a href="model.html" class="text-primary underline">Mở trang Model</a>).</p>`;
        return;
    }

    const chipsHtml = collabState.models.map(m => {
        const name = m.name || 'Model';
        const isChecked = selected.has(name);
        const conflicts = getModelConflictsForDate(name, deployDate, order?.id);
        const priceStr = m.pricePerDay ? `${(parseCurrencyNumber(m.pricePerDay) / 1000).toLocaleString('vi-VN')}k` : '0đ';
        const conflictBadge = conflicts.length > 0
            ? `<span title="Trùng lịch ngày ${deployDate} với đơn ${conflicts.map(c => '#' + c.code).join(', ')}" class="text-[9px] font-black text-amber-600">⚠ Trùng ${conflicts.length} đơn</span>`
            : '';

        return `
            <label class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-bold cursor-pointer transition-all ${isChecked ? 'bg-rose-50 border-primary text-primary dark:bg-rose-950/40' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'}">
                <input type="checkbox" name="editOrderBookedModel" value="${escapeHtml(name)}" data-price="${parseCurrencyNumber(m.pricePerDay)}"
                    ${isChecked ? 'checked' : ''} ${canEdit ? '' : 'disabled'}
                    onchange="window.onBookedModelToggle()" class="rounded text-primary"/>
                <span>${escapeHtml(name)}</span>
                <span class="text-[10px] text-slate-400">(${escapeHtml(priceStr)})</span>
                ${conflictBadge}
            </label>
        `;
    }).join('');

    container.innerHTML = `
        <div class="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto pr-1">${chipsHtml}</div>
        <div class="flex items-center justify-between gap-2 pt-2">
            <span id="bookedModelsSummaryText" class="text-[11px] font-bold text-slate-500">Đã chọn: ${selected.size} người mẫu</span>
            ${checkPermission('costs') ? `<button type="button" onclick="window.applyBookedModelsCost()" class="px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 text-[11px] font-extrabold hover:bg-emerald-100 transition-colors">⚡ Nạp cát-xê vào Chi phí</button>` : ''}
        </div>
    `;
    window.onBookedModelToggle();
}

window.onBookedModelToggle = function() {
    const checked = Array.from(document.querySelectorAll('input[name="editOrderBookedModel"]:checked'));
    const totalFee = checked.reduce((sum, el) => sum + (Number(el.dataset.price) || 0), 0);
    const sumEl = document.getElementById('bookedModelsSummaryText');
    if (sumEl) {
        sumEl.textContent = checked.length > 0
            ? `Đã chọn: ${checked.length} mẫu · Dự tính cát-xê: ${totalFee.toLocaleString('vi-VN')} đ`
            : 'Chưa chọn người mẫu cho đơn này';
    }
};

window.getSelectedBookedModels = function() {
    return Array.from(document.querySelectorAll('input[name="editOrderBookedModel"]:checked')).map(el => el.value);
};

window.applyBookedModelsCost = async function() {
    const orderId = document.getElementById('editOrderId')?.value;
    if (!orderId || !checkPermission('costs')) return;
    const checked = Array.from(document.querySelectorAll('input[name="editOrderBookedModel"]:checked'));
    const modelFee = checked.reduce((sum, el) => sum + (Number(el.dataset.price) || 0), 0);
    const existing = (window.allOrdersData || []).find(o => o.id === orderId);
    if (!existing) return;

    const costs = { ...(existing.costs || {}), model: modelFee };
    const fields = ['model', 'makeup', 'studio', 'travel', 'video', 'photo', 'stylist', 'assistant', 'other'];
    const totalCost = fields.reduce((s, f) => s + parseCurrencyNumber(costs[f]), 0);

    await window.updateOrderWithHistory(orderId, {
        bookedModels: checked.map(c => c.value),
        costs,
        totalCost
    });
    const valEl = document.getElementById('editOrderTotalCostValue');
    if (valEl) valEl.textContent = window.formatCurrency(totalCost);
    showToast('Đã đồng bộ Cát-xê!', `Chi phí Model (${modelFee.toLocaleString('vi-VN')} đ) đã được cộng vào dự toán đơn.`, 'payments', 'success');
};

// =====================================================================
// 2. WORKLOAD HEATMAP FOR STAFF ASSIGNMENT
// =====================================================================

export function getMemberWeeklyWorkload(memberName, refDateYMD = '') {
    if (!memberName || memberName === '-') return { hours: 0, tasks: 0, level: 'free', label: '0h/tuần 🟢' };
    const base = refDateYMD && /^\d{4}-\d{2}-\d{2}$/.test(refDateYMD)
        ? new Date(...refDateYMD.split('-').map((n, i) => i === 1 ? Number(n) - 1 : Number(n)))
        : new Date();
    const day = base.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mon = new Date(base.getFullYear(), base.getMonth(), base.getDate() + diff);
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    const startYMD = toLocalYMD(mon);
    const endYMD = toLocalYMD(sun);

    const targetLower = String(memberName).trim().toLowerCase();
    const weekTasks = (window.allScheduleTasks || []).filter(t =>
        String(t.assignee || '').trim().toLowerCase() === targetLower &&
        t.date >= startYMD &&
        t.date <= endYMD
    );
    const hours = Math.round(weekTasks.reduce((s, t) => s + (Number(t.plannedHours) || 0), 0) * 10) / 10;
    if (hours >= 40) return { hours, tasks: weekTasks.length, level: 'overloaded', label: `${hours}h/tuần 🔴 Quá tải` };
    if (hours >= 28) return { hours, tasks: weekTasks.length, level: 'busy', label: `${hours}h/tuần 🟡 Sát tải` };
    return { hours, tasks: weekTasks.length, level: 'free', label: `${hours}h/tuần 🟢 Trống` };
}

export function renderEditModalWorkloadHints() {
    const deployDate = document.getElementById('editOrderDeployDate')?.value || toLocalYMD(new Date());
    const pairs = [
        { selectId: 'editOrderStylist', roleLabel: 'Stylist' },
        { selectId: 'editOrderVideo', roleLabel: 'Video' },
        { selectId: 'editOrderPhoto', roleLabel: 'Photo' },
        { selectId: 'editOrderDesign', roleLabel: 'Design' }
    ];

    const box = document.getElementById('editOrderWorkloadHeatmap');
    if (!box) return;

    const badges = pairs.map(({ selectId, roleLabel }) => {
        const el = document.getElementById(selectId);
        const val = el?.value || '';
        if (!val || val === '-') return '';
        const w = getMemberWeeklyWorkload(val, deployDate);
        const cls = w.level === 'overloaded'
            ? 'bg-rose-100 text-rose-700 border-rose-300 dark:bg-rose-950/60 dark:text-rose-300'
            : w.level === 'busy'
                ? 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/60 dark:text-amber-300'
                : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300';
        return `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[10px] font-extrabold ${cls}">
            <span>${escapeHtml(roleLabel)}: ${escapeHtml(val)}</span>
            <span>· ${escapeHtml(w.label)}</span>
        </span>`;
    }).filter(Boolean);

    box.innerHTML = badges.length > 0
        ? `<div class="flex flex-wrap gap-1.5">${badges.join('')}</div>`
        : `<p class="text-[11px] text-slate-400">Chọn nhân sự phụ trách để xem cảnh báo tải công việc trong tuần.</p>`;
}

// =====================================================================
// 3. ORDER <-> SCHEDULE 2-WAY SYNC & REVERSE PRODUCT SYNC
// =====================================================================

export function getLinkedScheduleProgress(orderCode) {
    const clean = String(orderCode || '').replace(/^#/, '').trim().toUpperCase();
    if (!clean) return { total: 0, done: 0, pct: 0, tasks: [] };
    const matched = (window.allScheduleTasks || []).filter(
        t => String(t.linkedOrderCode || '').replace(/^#/, '').trim().toUpperCase() === clean
    );
    const done = matched.filter(t => t.status === 'Hoàn thành').length;
    return {
        total: matched.length,
        done,
        pct: matched.length > 0 ? Math.round((done / matched.length) * 100) : 0,
        tasks: matched
    };
}

export function renderOrderScheduleSyncBar(order) {
    const container = document.getElementById('editOrderScheduleSyncBar');
    if (!container || !order) return;
    const prog = getLinkedScheduleProgress(order.code);

    container.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
                <div class="text-[11px] font-extrabold text-slate-700 dark:text-slate-200">
                    Tiến độ Lịch làm việc: <span class="text-primary">${prog.done}/${prog.total} việc hoàn thành (${prog.pct}%)</span>
                </div>
                <div class="w-48 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden mt-1">
                    <div class="h-full bg-emerald-500 transition-all" style="width:${prog.pct}%"></div>
                </div>
            </div>
            <button type="button" onclick="window.syncCurrentOrderToSchedule()"
                class="px-3 py-1.5 rounded-xl bg-primary text-white text-[11px] font-black hover:opacity-90 transition-all flex items-center gap-1">
                <span class="material-symbols-outlined text-[15px]">sync_saved_locally</span>
                Đẩy lịch cho Ekip
            </button>
        </div>
    `;
}

window.syncCurrentOrderToSchedule = async function() {
    const orderId = document.getElementById('editOrderId')?.value;
    const order = (window.allOrdersData || []).find(o => o.id === orderId);
    if (!order) return;

    const code = order.code || '';
    const title = document.getElementById('editOrderTitle')?.value || order.title || `Đơn #${code}`;
    const deployDate = document.getElementById('editOrderDeployDate')?.value || toLocalYMD(order.deployDate) || toLocalYMD(order.deadline) || toLocalYMD(new Date());
    const deadline = document.getElementById('editOrderDeadline')?.value || toLocalYMD(order.deadline) || '';
    const plainDesc = stripHtmlToText(document.getElementById('editOrderContent')?.innerHTML || order.content || '').slice(0, 300);

    const assignments = [
        { name: document.getElementById('editOrderStylist')?.value || order.stylist, category: 'Styling mixmatch', roleTitle: 'Styling' },
        { name: document.getElementById('editOrderVideo')?.value || order.assignedVideo, category: 'Quay / dựng video', roleTitle: 'Video' },
        { name: document.getElementById('editOrderPhoto')?.value || order.assignedPhoto, category: 'Chụp / hậu kỳ ảnh', roleTitle: 'Photo' },
        { name: document.getElementById('editOrderDesign')?.value || order.assignedDesign, category: 'Thiết kế', roleTitle: 'Design' }
    ].filter(a => a.name && a.name !== '-');

    if (assignments.length === 0) {
        showToast('Chưa chọn nhân sự', 'Hãy chọn ít nhất 1 Stylist / Video / Photo / Design trước khi đẩy sang Lịch làm việc.', 'warning', 'warning');
        return;
    }

    const existing = getLinkedScheduleProgress(code).tasks;
    const me = getCurrentUser();
    const weekdays = ['Chủ Nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
    const [yy, mm, dd] = deployDate.split('-').map(Number);
    const weekday = weekdays[new Date(yy, mm - 1, dd).getDay()] || '';

    let createdCount = 0;
    for (const a of assignments) {
        const already = existing.some(t => String(t.assignee || '').trim().toLowerCase() === String(a.name).trim().toLowerCase());
        if (already) continue;

        const userDoc = (window.allUsersData || []).find(u => String(u.name || '').trim().toLowerCase() === String(a.name).trim().toLowerCase());
        await addDoc(collection(db, 'schedule_tasks'), {
            date: deployDate,
            weekday,
            assignee: a.name,
            assigneeId: userDoc?.empId || userDoc?.id || '',
            department: userDoc?.dept || 'Creative',
            approver: me.name || '',
            title: `[${a.roleTitle}] #${code} - ${title}`,
            category: a.category,
            source: 'Trong KH tháng',
            timeSlot: 'Linh hoạt',
            deadline,
            priority: 'Cao',
            plannedHours: 4,
            plannedQtyRaw: '1',
            plannedQty: 1,
            unit: 'Việc',
            linkedOrderCode: code,
            description: plainDesc,
            status: 'Chưa bắt đầu',
            progress: 0,
            actualHours: 0,
            hoursDiff: -4,
            actualQtyRaw: '',
            actualQty: 0,
            completedDate: '',
            resultLink: '',
            approvalStatus: 'Chưa duyệt',
            blocker: '',
            nextStep: '',
            createdBy: me.name || 'Hệ thống',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        createdCount++;

        createAppNotification({
            title: `Bạn được phân công lịch từ đơn #${code}`,
            body: `${title} · Ngày triển khai: ${deployDate.split('-').reverse().join('/')}`,
            type: 'create',
            orderId: order.id,
            orderCode: code,
            recipientName: a.name,
            linkPage: 'reports'
        });
    }

    if (createdCount === 0) {
        showToast('Lịch đã đồng bộ sẵn', 'Tất cả nhân sự phụ trách đơn này đều đã có đầu việc trên Lịch làm việc.', 'info', 'info');
    } else {
        showToast('Đã đẩy sang Lịch làm việc!', `Đã tạo tự động ${createdCount} đầu việc cho ekip đơn #${code}.`, 'event_available', 'success');
    }
    setTimeout(() => renderOrderScheduleSyncBar(order), 300);
};

/** Reverse sync: when an order linked to New Products (`products.html`) completes, mark product media statuses "Hoàn tất" */
export async function syncCompletedOrderToProducts(order, deliverableUrl = '') {
    if (!db || !order || !Array.isArray(order.linkedProducts) || order.linkedProducts.length === 0) return;
    const catLower = String(order.category || '').toLowerCase();
    const isVideo = catLower.includes('video') || catLower.includes('live');

    for (const item of order.linkedProducts) {
        if (!item?.collection || !item?.docId) continue;
        try {
            const updates = { updatedAt: serverTimestamp() };
            if (isVideo) {
                updates.videoModelTrangThai = 'Hoàn tất';
                if (deliverableUrl) updates.linkVideo = deliverableUrl;
            } else {
                updates.anhModelTrangThai = 'Hoàn tất';
                updates.anhTraiSanTrangThai = 'Hoàn tất';
                if (deliverableUrl) updates.linkAnhModel = deliverableUrl;
            }
            await updateDoc(doc(db, item.collection, item.docId), updates);
        } catch (err) {
            console.warn('Reverse sync to product warning:', err);
        }
    }
}

// =====================================================================
// 4. COMMENTS, @MENTIONS & CREATIVE FILE PROOFING (ROUND APPROVALS)
// =====================================================================

export function openOrderCollaborationPanel(order) {
    if (!order || !order.id) return;
    collabState.currentOrderId = order.id;

    renderOrderModelBookingPanel(order);
    renderOrderScheduleSyncBar(order);
    renderEditModalWorkloadHints();

    if (collabState.unsubComments) {
        collabState.unsubComments();
        collabState.unsubComments = null;
    }

    const q = query(collection(db, 'order_comments'), where('orderId', '==', order.id));
    collabState.unsubComments = onSnapshot(q, (snap) => {
        const list = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() }));
        list.sort((a, b) => toEpochMs(a.createdAt) - toEpochMs(b.createdAt));
        collabState.comments = list;
        renderOrderProofingAndComments(order);
    }, () => {
        renderOrderProofingAndComments(order);
    });
}

function renderOrderProofingAndComments(orderSnapshot) {
    const latestOrder = (window.allOrdersData || []).find(o => o.id === orderSnapshot.id) || orderSnapshot;
    const containers = [
        document.getElementById('editOrderCollabContainer'),
        document.getElementById('viewOrderCollabContainer')
    ].filter(Boolean);
    if (containers.length === 0) return;

    const me = getCurrentUser();
    const canApproveProof = checkPermission('status') || (me.name && me.name === latestOrder.requester);
    const proofRound = Number(latestOrder.proofRound || 0);
    const proofStatus = latestOrder.proofStatus || 'none';
    const deliverableHref = safeUrl(latestOrder.deliverableUrl);

    const statusBadgeMap = {
        pending_review: '<span class="px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 text-[10px] font-black uppercase">⏳ Chờ duyệt sản phẩm</span>',
        approved: '<span class="px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-black uppercase">✅ Đã duyệt Final</span>',
        changes_requested: '<span class="px-2.5 py-1 rounded-full bg-rose-100 text-rose-700 text-[10px] font-black uppercase">🔄 Yêu cầu chỉnh sửa</span>',
        none: '<span class="px-2.5 py-1 rounded-full bg-slate-100 text-slate-500 text-[10px] font-bold uppercase">Chưa gửi bản duyệt</span>'
    };

    const staffOptions = (window.allUsersData || [])
        .filter(u => u.name)
        .map(u => `<option value="@${escapeHtml(u.name)}">${escapeHtml(u.name)} (${escapeHtml(u.dept || '-')})</option>`)
        .join('');

    const commentsHtml = collabState.comments.length === 0
        ? `<div class="py-6 text-center text-xs text-slate-400 italic">Chưa có bình luận hoặc lịch sử gửi duyệt file nào. Hãy gõ @Tên để tag đồng nghiệp!</div>`
        : collabState.comments.map(c => {
            const timeStr = c.createdAt ? new Date(toEpochMs(c.createdAt)).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : 'Vừa xong';
            const fileHref = safeUrl(c.attachmentUrl);
            const roundTag = c.round ? `<span class="px-2 py-0.5 rounded bg-indigo-100 text-indigo-700 text-[10px] font-black">Vòng duyệt #${Number(c.round)}</span>` : '';
            const decisionTag = c.decision === 'approved'
                ? `<span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-black">✅ ĐÃ DUYỆT FINAL</span>`
                : c.decision === 'changes_requested'
                    ? `<span class="px-2 py-0.5 rounded bg-rose-100 text-rose-700 text-[10px] font-black">🔄 CẦN CHỈNH SỬA</span>`
                    : '';

            // Highlight @Mentions safely after HTML-escaping
            const escapedMsg = escapeHtml(c.message || '').replace(/@([\p{L}\p{N}_ ]{2,30})/gu, (match) =>
                `<span class="text-primary font-extrabold bg-rose-50 dark:bg-rose-950/60 px-1 rounded">${match}</span>`
            );

            return `
                <div class="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200/70 dark:border-slate-700 space-y-1.5">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="flex items-center gap-2">
                            <span class="w-6 h-6 rounded-full bg-primary/15 text-primary text-[10px] font-black flex items-center justify-center">${escapeHtml((c.authorName || 'NV').slice(0, 2).toUpperCase())}</span>
                            <span class="text-xs font-extrabold text-slate-800 dark:text-slate-100">${escapeHtml(c.authorName || 'Thành viên')}</span>
                            ${roundTag}
                            ${decisionTag}
                        </div>
                        <span class="text-[10px] font-bold text-slate-400">${escapeHtml(timeStr)}</span>
                    </div>
                    ${escapedMsg ? `<p class="text-xs text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-wrap">${escapedMsg}</p>` : ''}
                    ${fileHref ? `<a href="${escapeHtml(fileHref)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 text-xs font-bold hover:underline">
                        <span class="material-symbols-outlined text-[16px]">attach_file</span> Mở File / Link Sản Phẩm Bàn Giao
                    </a>` : ''}
                </div>
            `;
        }).join('');

    const html = `
        <div class="mt-6 pt-6 border-t border-slate-200 dark:border-slate-700 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                    <span class="material-symbols-outlined text-primary text-[20px]">rate_review</span>
                    <h4 class="text-sm font-black uppercase tracking-wider text-slate-800 dark:text-slate-100">Trao đổi, @Tag & Duyệt File (Creative Proofing)</h4>
                </div>
                <div class="flex items-center gap-2">
                    ${proofRound > 0 ? `<span class="text-xs font-extrabold text-indigo-600">Round #${proofRound}</span>` : ''}
                    ${statusBadgeMap[proofStatus] || statusBadgeMap.none}
                </div>
            </div>

            ${deliverableHref ? `
                <div class="p-3.5 rounded-2xl bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800 flex flex-wrap items-center justify-between gap-3">
                    <div class="min-w-0">
                        <div class="text-[10px] font-black uppercase tracking-wider text-indigo-600 dark:text-indigo-300">Link Sản Phẩm Bàn Giao Mới Nhất (Vòng #${proofRound || 1})</div>
                        <a href="${escapeHtml(deliverableHref)}" target="_blank" rel="noopener noreferrer" class="text-xs font-bold text-blue-700 dark:text-blue-300 underline truncate block max-w-md">${escapeHtml(deliverableHref)}</a>
                    </div>
                    ${canApproveProof ? `
                        <div class="flex items-center gap-2">
                            <button type="button" onclick="window.handleProofDecision('${escapeJsStr(latestOrder.id)}', 'approved')" class="px-3 py-1.5 rounded-xl bg-emerald-600 text-white text-xs font-black hover:bg-emerald-700 transition-colors">✅ Duyệt Final</button>
                            <button type="button" onclick="window.handleProofDecision('${escapeJsStr(latestOrder.id)}', 'changes_requested')" class="px-3 py-1.5 rounded-xl bg-rose-600 text-white text-xs font-black hover:bg-rose-700 transition-colors">🔄 Yêu cầu sửa</button>
                        </div>
                    ` : ''}
                </div>
            ` : ''}

            <div class="max-h-60 overflow-y-auto space-y-2.5 pr-1">${commentsHtml}</div>

            <div class="p-3.5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 space-y-2.5">
                <div class="flex flex-wrap items-center gap-2">
                    <select onchange="if(this.value){ const ta=this.closest('.space-y-2\\.5').querySelector('textarea'); ta.value += (ta.value ? ' ' : '') + this.value + ' '; ta.focus(); this.value=''; }"
                        class="text-xs font-bold rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800">
                        <option value="">+ @Tag nhanh thành viên...</option>
                        ${staffOptions}
                    </select>
                    <input type="url" data-collab-link placeholder="Dán link Google Drive / Frame.io / Ảnh sản phẩm để gửi duyệt..."
                        class="flex-1 min-w-[210px] text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 bg-slate-50 dark:bg-slate-800"/>
                </div>
                <div class="flex items-end gap-2">
                    <textarea rows="2" data-collab-msg placeholder="Nhập trao đổi, ghi chú chỉnh sửa hoặc thuyết minh sản phẩm..."
                        class="flex-1 text-xs font-medium rounded-xl border border-slate-200 dark:border-slate-700 p-2.5 bg-slate-50 dark:bg-slate-800 resize-none"></textarea>
                    <button type="button" onclick="window.submitOrderCommentOrProof(this, '${escapeJsStr(latestOrder.id)}')"
                        class="px-4 py-2.5 rounded-xl bg-primary text-white text-xs font-black hover:opacity-95 shrink-0 flex items-center gap-1">
                        <span class="material-symbols-outlined text-[16px]">send</span> Gửi
                    </button>
                </div>
            </div>
        </div>
    `;

    containers.forEach(c => { c.innerHTML = html; });
}

function extractMentionedUsers(text) {
    const users = window.allUsersData || [];
    const lower = String(text || '').toLowerCase();
    return users.filter(u => u.name && lower.includes(`@${u.name.toLowerCase()}`)).map(u => u.name);
}

window.submitOrderCommentOrProof = async function(btnEl, orderId) {
    const box = btnEl?.closest('.space-y-2\\.5');
    if (!box || !orderId) return;
    const msgEl = box.querySelector('[data-collab-msg]');
    const linkEl = box.querySelector('[data-collab-link]');
    const message = (msgEl?.value || '').trim();
    const rawLink = (linkEl?.value || '').trim();
    const validLink = rawLink ? safeUrl(rawLink) : '';

    if (rawLink && !validLink) {
        showToast('Link không hợp lệ', 'Vui lòng nhập đường dẫn bắt đầu bằng https:// hoặc http://', 'warning', 'warning');
        return;
    }
    if (!message && !validLink) {
        showToast('Chưa nhập nội dung', 'Hãy nhập bình luận hoặc dán link sản phẩm.', 'info', 'info');
        return;
    }

    const order = (window.allOrdersData || []).find(o => o.id === orderId);
    const me = getCurrentUser();
    const nextRound = validLink ? (Number(order?.proofRound || 0) + 1) : 0;

    btnEl.disabled = true;
    try {
        await addDoc(collection(db, 'order_comments'), {
            orderId,
            orderCode: order?.code || '',
            authorName: me.name || 'Thành viên',
            authorEmpId: me.empId || '',
            message,
            attachmentUrl: validLink,
            round: nextRound || null,
            decision: null,
            createdAt: serverTimestamp()
        });

        if (validLink && order) {
            await window.updateOrderWithHistory(orderId, {
                deliverableUrl: validLink,
                proofRound: nextRound,
                proofStatus: 'pending_review'
            });
            createAppNotification({
                title: `📦 Đơn #${order.code} đã nộp sản phẩm Vòng #${nextRound}`,
                body: message || `${me.name} vừa gửi link nghiệm thu sản phẩm.`,
                type: 'proofing',
                orderId,
                orderCode: order.code,
                recipientName: order.requester || '',
                webhookEvent: 'proofing'
            });
        }

        const mentioned = extractMentionedUsers(message);
        mentioned.forEach(targetName => {
            createAppNotification({
                title: `💬 ${me.name} đã nhắc tới bạn ở đơn #${order?.code || ''}`,
                body: message,
                type: 'mention',
                orderId,
                orderCode: order?.code || '',
                recipientName: targetName,
                webhookEvent: 'mention'
            });
        });

        if (msgEl) msgEl.value = '';
        if (linkEl) linkEl.value = '';
        showToast(validLink ? `Đã nộp duyệt Vòng #${nextRound}!` : 'Đã gửi bình luận!', '', 'check_circle', 'success');
    } catch (err) {
        console.error(err);
        showToast('Lỗi gửi trao đổi', err.message, 'error', 'error');
    } finally {
        btnEl.disabled = false;
    }
};

window.handleProofDecision = async function(orderId, decision) {
    const order = (window.allOrdersData || []).find(o => o.id === orderId);
    if (!order) return;
    const me = getCurrentUser();

    let note = '';
    if (decision === 'changes_requested') {
        note = prompt('Nhập nội dung / điểm cần chỉnh sửa cho ekip Creative:') || '';
        if (!note.trim()) return;
    }

    const updates = {
        proofStatus: decision,
        approvedBy: decision === 'approved' ? (me.name || 'Quản lý') : (order.approvedBy || '')
    };
    if (decision === 'approved' && order.status !== 'Hoàn thành' && checkPermission('status')) {
        updates.status = 'Hoàn thành';
        updates.completedAt = new Date().toISOString();
    }

    await window.updateOrderWithHistory(orderId, updates);
    await addDoc(collection(db, 'order_comments'), {
        orderId,
        orderCode: order.code || '',
        authorName: me.name || 'Quản lý',
        authorEmpId: me.empId || '',
        message: decision === 'approved'
            ? `Đã nghiệm thu ĐẠT (Final) cho Vòng #${order.proofRound || 1}.`
            : `Yêu cầu chỉnh sửa Vòng #${order.proofRound || 1}: ${note}`,
        attachmentUrl: '',
        round: order.proofRound || 1,
        decision,
        createdAt: serverTimestamp()
    });

    const teamTargets = [order.stylist, order.assignedVideo, order.assignedPhoto, order.assignedDesign]
        .filter(x => x && x !== '-');

    if (teamTargets.length > 0) {
        createAppNotification({
            title: decision === 'approved'
                ? `✅ Sản phẩm đơn #${order.code} ĐÃ ĐƯỢC DUYỆT FINAL!`
                : `🔄 Đơn #${order.code} cần chỉnh sửa Vòng #${order.proofRound || 1}`,
            body: note || order.title || '',
            type: decision === 'approved' ? 'approved' : 'proofing',
            orderId,
            orderCode: order.code,
            recipients: teamTargets,
            webhookEvent: 'proofing'
        });
    }

    if (decision === 'approved') {
        await syncCompletedOrderToProducts(order, order.deliverableUrl || '');
    }

    showToast(
        decision === 'approved' ? 'Đã duyệt Final!' : 'Đã gửi yêu cầu chỉnh sửa',
        `Đơn #${order.code}`,
        decision === 'approved' ? 'verified' : 'edit_note',
        decision === 'approved' ? 'success' : 'warning'
    );
};

// =====================================================================
// 5. KANBAN DRAG-AND-DROP BOARD + SLA TRACKING
// =====================================================================

function computeOrderElapsedDays(order) {
    const startMs = toEpochMs(order.orderDate || order.createdAt);
    if (!startMs) return null;
    const endMs = order.status === 'Hoàn thành'
        ? (toEpochMs(order.completedAt || order.updatedAt) || Date.now())
        : Date.now();
    const days = Math.max(0.1, (endMs - startMs) / 86400000);
    return Math.round(days * 10) / 10;
}

export function renderKanbanBoard() {
    const wrapper = document.getElementById('ordersKanbanWrapper');
    if (!wrapper) return;

    const statuses = (window.orderStatusesData && window.orderStatusesData.length > 0)
        ? window.orderStatusesData.map(s => s.name)
        : ['Chờ duyệt', 'Đang sản xuất', 'Đang hậu kỳ', 'Hoàn thành', 'Hủy'];

    // Ensure any custom status existing on orders is also shown
    const sourceOrders = Array.isArray(window.currentFilteredOrders) && window.currentFilteredOrders.length > 0
        ? window.currentFilteredOrders
        : (() => {
            const qSearch = (document.getElementById('filterSearch')?.value || '').trim().toLowerCase();
            const qStatus = document.getElementById('filterStatus')?.value || '';
            return (window.allOrdersData || []).filter(o => {
                if (qStatus && o.status !== qStatus) return false;
                if (qSearch) {
                    const hay = `${o.code || ''} ${o.title || ''} ${o.requester || ''} ${o.department || ''}`.toLowerCase();
                    if (!hay.includes(qSearch)) return false;
                }
                return true;
            });
        })();

    sourceOrders.forEach(o => {
        const st = o.status || 'Chờ duyệt';
        if (!statuses.includes(st)) statuses.push(st);
    });

    const canDragStatus = checkPermission('status');
    const summaryTop = document.getElementById('tableResultsSummaryTop');
    if (summaryTop) {
        summaryTop.textContent = `Kanban: ${sourceOrders.length} đơn hàng`;
    }

    const colsHtml = statuses.map(statusName => {
        const colOrders = sourceOrders.filter(o => (o.status || 'Chờ duyệt') === statusName);
        const colCost = colOrders.reduce((s, o) => s + parseCurrencyNumber(o.totalCost), 0);

        const cardsHtml = colOrders.length === 0
            ? `<div class="py-10 text-center text-xs text-slate-400 border-2 border-dashed border-slate-200/70 dark:border-slate-700/70 rounded-xl">Kéo thả đơn vào đây</div>`
            : colOrders.map(order => {
                const elapsed = computeOrderElapsedDays(order);
                const schedProg = getLinkedScheduleProgress(order.code);
                const dataStr = encodeURIComponent(JSON.stringify({
                    id: order.id,
                    code: order.code,
                    status: order.status,
                    title: order.title,
                    requester: order.requester,
                    department: order.department,
                    deadline: order.deadline,
                    deployDate: order.deployDate,
                    orderDate: order.orderDate || order.createdAt,
                    content: order.content,
                    category: order.category,
                    stylist: order.stylist,
                    assignedVideo: order.assignedVideo,
                    assignedPhoto: order.assignedPhoto,
                    assignedDesign: order.assignedDesign,
                    bookedModels: order.bookedModels || [],
                    costs: order.costs || {},
                    totalCost: order.totalCost || 0,
                    note: order.note || ''
                })).replace(/'/g, '%27');

                const proofPill = order.proofStatus === 'approved'
                    ? `<span class="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[9px] font-black">✓ Final</span>`
                    : order.proofStatus === 'pending_review'
                        ? `<span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[9px] font-black">⏳ Chờ duyệt file</span>`
                        : order.proofStatus === 'changes_requested'
                            ? `<span class="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-[9px] font-black">🔄 Sửa file</span>`
                            : '';

                return `
                    <div class="kanban-card space-y-2"
                         draggable="${canDragStatus ? 'true' : 'false'}"
                         data-kanban-order-id="${escapeHtml(order.id)}"
                         onclick="window.openEditModal('${dataStr}')">
                        <div class="flex items-center justify-between gap-1">
                            <span class="font-headline font-black text-xs text-primary hover:underline"
                                  onclick="event.stopPropagation(); window.openHistoryDrawer('${escapeJsStr(order.id)}', '${escapeJsStr(order.code || '')}')">
                                #${escapeHtml(order.code || '-')}
                            </span>
                            <div class="flex items-center gap-1">
                                ${proofPill}
                                ${elapsed !== null ? `<span class="text-[10px] font-bold text-slate-400" title="Thời gian lưu chuyển SLA">⏱ ${elapsed}d</span>` : ''}
                            </div>
                        </div>
                        <p class="text-xs font-extrabold text-slate-800 dark:text-slate-100 line-clamp-2 leading-snug">${escapeHtml(order.title || 'Không tiêu đề')}</p>
                        <div class="flex flex-wrap items-center gap-1 text-[10px] font-bold text-slate-500">
                            <span class="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800">${escapeHtml(order.category || 'Khác')}</span>
                            ${order.deadline ? `<span class="text-rose-600">Hạn: ${escapeHtml(toLocalYMD(order.deadline).split('-').slice(1).reverse().join('/'))}</span>` : ''}
                            ${schedProg.total > 0 ? `<span class="px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600">📋 ${schedProg.done}/${schedProg.total}</span>` : ''}
                        </div>
                        <div class="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[10px] text-slate-500 font-semibold">
                            <span class="truncate max-w-[150px]">👤 ${escapeHtml(order.requester || '-')}</span>
                            <span class="font-extrabold text-emerald-600">${parseCurrencyNumber(order.totalCost) > 0 ? `${(parseCurrencyNumber(order.totalCost) / 1000).toLocaleString('vi-VN')}k` : ''}</span>
                        </div>
                    </div>
                `;
            }).join('');

        return `
            <div class="kanban-column" data-kanban-status="${escapeHtml(statusName)}">
                <div class="p-3.5 border-b border-slate-200/80 dark:border-slate-700/80 flex items-center justify-between shrink-0">
                    <div>
                        <h4 class="text-xs font-black uppercase tracking-wider text-slate-700 dark:text-slate-200">${escapeHtml(statusName)}</h4>
                        ${colCost > 0 ? `<div class="text-[10px] font-bold text-emerald-600 mt-0.5">${colCost.toLocaleString('vi-VN')} đ</div>` : ''}
                    </div>
                    <span class="px-2.5 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-black">${colOrders.length}</span>
                </div>
                <div class="flex-1 overflow-y-auto p-2.5 space-y-2.5">${cardsHtml}</div>
            </div>
        `;
    }).join('');

    wrapper.innerHTML = `<div class="kanban-board-scroll">${colsHtml}</div>`;

    if (canDragStatus) {
        let draggedOrderId = null;
        wrapper.querySelectorAll('.kanban-card[draggable="true"]').forEach(card => {
            card.addEventListener('dragstart', (e) => {
                draggedOrderId = card.dataset.kanbanOrderId;
                card.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', draggedOrderId);
            });
            card.addEventListener('dragend', () => {
                card.classList.remove('dragging');
            });
        });

        wrapper.querySelectorAll('.kanban-column').forEach(col => {
            col.addEventListener('dragover', (e) => {
                e.preventDefault();
                col.classList.add('drag-over');
            });
            col.addEventListener('dragleave', () => {
                col.classList.remove('drag-over');
            });
            col.addEventListener('drop', async (e) => {
                e.preventDefault();
                col.classList.remove('drag-over');
                const id = draggedOrderId || e.dataTransfer.getData('text/plain');
                const nextStatus = col.dataset.kanbanStatus;
                if (!id || !nextStatus) return;
                const ord = (window.allOrdersData || []).find(o => o.id === id);
                if (!ord || ord.status === nextStatus) return;

                const stageTimestamps = { ...(ord.stageTimestamps || {}), [nextStatus]: new Date().toISOString() };
                const updates = { status: nextStatus, stageTimestamps };
                if (nextStatus === 'Hoàn thành') updates.completedAt = new Date().toISOString();

                await window.updateOrderWithHistory(id, updates);
                if (nextStatus === 'Hoàn thành') {
                    await syncCompletedOrderToProducts(ord, ord.deliverableUrl || '');
                }
                showToast('Đã chuyển trạng thái!', `Đơn #${ord.code || ''} → ${nextStatus}`, 'swap_horiz', 'success');
            });
        });
    }
}

// =====================================================================
// 6. DYNAMIC SLA & DETAILED ANALYTICS REPORT (#page-detailed-report)
// =====================================================================

export function renderDynamicDetailedReport(daysRange) {
    if (daysRange !== undefined) collabState.analyticsDays = Number(daysRange) || 30;
    const days = collabState.analyticsDays;

    const btnLabel = document.getElementById('detPeriodBtnLabel');
    if (btnLabel) {
        btnLabel.textContent = days >= 3650 ? 'Tất cả thời gian' : `${days} ngày qua`;
    }

    const allOrders = window.allOrdersData || [];
    const cutoffMs = days >= 3650 ? 0 : (Date.now() - days * 86400000);
    const scoped = allOrders.filter(o => {
        const ms = toEpochMs(o.orderDate || o.createdAt);
        return cutoffMs === 0 || !ms || ms >= cutoffMs;
    });

    const completedOrders = scoped.filter(o => o.status === 'Hoàn thành');

    // 1. Real Average Lead Time (days)
    const durations = completedOrders
        .map(o => {
            const start = toEpochMs(o.orderDate || o.createdAt);
            const end = toEpochMs(o.completedAt || o.updatedAt);
            if (!start || !end || end < start) return null;
            return (end - start) / 86400000;
        })
        .filter(d => d !== null);
    const avgDays = durations.length > 0
        ? (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1)
        : (completedOrders.length > 0 ? '1.0' : '0.0');

    // 2. Real Stylist / Creative Assignment Fulfillment Rate
    const assignedOrders = scoped.filter(o =>
        (o.stylist && o.stylist !== '-') ||
        (o.assignedVideo && o.assignedVideo !== '-') ||
        (o.assignedPhoto && o.assignedPhoto !== '-') ||
        (o.assignedDesign && o.assignedDesign !== '-')
    );
    const assignedDone = assignedOrders.filter(o => o.status === 'Hoàn thành').length;
    const stylistRate = assignedOrders.length > 0 ? Math.round((assignedDone / assignedOrders.length) * 100) : 0;

    // 3. Real On-Time Deadline Rate (UTC+7 safe)
    const onTimeCount = completedOrders.filter(o => isCompletedOnTimeLocal(o.deadline, o.completedAt || o.updatedAt)).length;
    const deadlineRate = completedOrders.length > 0 ? Math.round((onTimeCount / completedOrders.length) * 100) : 0;

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('det-total-done', String(completedOrders.length));
    setEl('det-avg-time', String(avgDays));
    setEl('det-stylist-rate', `${stylistRate}%`);
    setEl('det-deadline-rate', `${deadlineRate}%`);

    if (typeof window.Chart !== 'function') return;

    // Trend chart over min(days, 30) buckets
    const chartDays = Math.min(days >= 3650 ? 30 : days, 30);
    const labels = [];
    const createdCounts = [];
    const doneCounts = [];
    const now = new Date();

    for (let i = chartDays - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const ymd = toLocalYMD(d);
        labels.push(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`);
        createdCounts.push(allOrders.filter(o => toLocalYMD(o.orderDate || o.createdAt) === ymd).length);
        doneCounts.push(allOrders.filter(o => o.status === 'Hoàn thành' && toLocalYMD(o.completedAt || o.updatedAt || o.createdAt) === ymd).length);
    }

    const ctxTrend = document.getElementById('chartTrend')?.getContext('2d');
    if (ctxTrend) {
        if (collabState.charts.trend) collabState.charts.trend.destroy();
        collabState.charts.trend = new window.Chart(ctxTrend, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    { label: 'Đơn tạo mới', data: createdCounts, borderColor: '#b80035', backgroundColor: 'rgba(184,0,53,0.12)', fill: true, tension: 0.35 },
                    { label: 'Đơn hoàn thành', data: doneCounts, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.35 }
                ]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });
    }

    const catMap = {};
    scoped.forEach(o => { const c = o.category || 'Khác'; catMap[c] = (catMap[c] || 0) + 1; });
    const ctxCat = document.getElementById('chartCategory')?.getContext('2d');
    if (ctxCat) {
        if (collabState.charts.category) collabState.charts.category.destroy();
        collabState.charts.category = new window.Chart(ctxCat, {
            type: 'doughnut',
            data: {
                labels: Object.keys(catMap),
                datasets: [{
                    data: Object.values(catMap),
                    backgroundColor: ['#b80035', '#006855', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#64748b']
                }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });
    }

    const staffMap = {};
    completedOrders.forEach(o => {
        [o.stylist, o.assignedVideo, o.assignedPhoto, o.assignedDesign].forEach(s => {
            if (s && s !== '-') staffMap[s] = (staffMap[s] || 0) + 1;
        });
    });
    const sortedStaff = Object.entries(staffMap).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const ctxStaff = document.getElementById('chartStaff')?.getContext('2d');
    if (ctxStaff) {
        if (collabState.charts.staff) collabState.charts.staff.destroy();
        collabState.charts.staff = new window.Chart(ctxStaff, {
            type: 'bar',
            data: {
                labels: sortedStaff.map(x => x[0]),
                datasets: [{ label: 'Đơn hoàn thành', data: sortedStaff.map(x => x[1]), backgroundColor: '#b80035', borderRadius: 8 }]
            },
            options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y' }
        });
    }
}

window.cycleDetailedReportPeriod = function() {
    const seq = [7, 30, 90, 3650];
    const idx = seq.indexOf(collabState.analyticsDays);
    const next = seq[(idx + 1) % seq.length];
    renderDynamicDetailedReport(next);
};

// Expose globals
window.renderKanbanBoard = renderKanbanBoard;
window.openOrderCollaborationPanel = openOrderCollaborationPanel;
window.renderEditModalWorkloadHints = renderEditModalWorkloadHints;
window.getMemberWeeklyWorkload = getMemberWeeklyWorkload;
window.getLinkedScheduleProgress = getLinkedScheduleProgress;
window.syncCompletedOrderToProducts = syncCompletedOrderToProducts;
window.renderDetailedReport = renderDynamicDetailedReport;

function initCollabAndKanban() {
    startModelsSync();
    ['editOrderDeployDate', 'editOrderStylist', 'editOrderVideo', 'editOrderPhoto', 'editOrderDesign'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => {
            renderEditModalWorkloadHints();
            if (id === 'editOrderDeployDate' && collabState.currentOrderId) {
                const ord = (window.allOrdersData || []).find(o => o.id === collabState.currentOrderId);
                if (ord) renderOrderModelBookingPanel(ord);
            }
        });
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCollabAndKanban);
} else {
    initCollabAndKanban();
}
