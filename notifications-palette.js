/*
  NOTIFICATIONS CENTER, COMMAND PALETTE (CTRL+K), PWA INSTALL & WEBHOOK DISPATCHER
  Provides real-time Firestore notifications, GapoWork/Telegram webhooks, and global instant search
*/

import {
    db, collection, addDoc, doc, getDoc, updateDoc,
    query, orderBy, limit, onSnapshot, serverTimestamp, arrayUnion
} from "./firebase-service.js";
import { getCurrentUser } from "./auth-service.js";
import { escapeHtml, escapeJsStr, safeUrl, toEpochMs, attachDialogLightDismiss } from "./security-utils.js";
import { showToast, navigateTo, toggleDarkMode } from "./ui-service.js";

const notifState = {
    items: [],
    unsub: null,
    integrations: null,
    deferredInstallPrompt: null,
    cmdResults: [],
    cmdActiveIdx: 0
};

function isNotificationForMe(n, me) {
    if (!n) return false;
    const myEmpId = (me.empId || '').trim().toLowerCase();
    const myName = (me.name || '').trim().toLowerCase();
    const targetEmp = (n.recipientEmpId || '').trim().toLowerCase();
    const targetName = (n.recipientName || '').trim().toLowerCase();

    if (n.targetAll === true || targetName === 'all') {
        // Don't clutter with own broadcast unless targeted specifically
        return true;
    }
    if (myEmpId && targetEmp && myEmpId === targetEmp) return true;
    if (myName && targetName && myName === targetName) return true;
    if (Array.isArray(n.recipients)) {
        return n.recipients.some(r => String(r || '').trim().toLowerCase() === myName || String(r || '').trim().toLowerCase() === myEmpId);
    }
    return false;
}

function isNotificationRead(n, me) {
    const key = me.empId || me.name || 'anon';
    return Array.isArray(n.readBy) && n.readBy.includes(key);
}

function formatRelativeTime(ts) {
    const ms = toEpochMs(ts);
    if (!ms) return 'Vừa xong';
    const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diffSec < 60) return 'Vừa xong';
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `${mins} phút trước`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} giờ trước`;
    const days = Math.floor(hrs / 24);
    return `${days} ngày trước`;
}

export async function loadIntegrationConfig() {
    if (!db) return null;
    try {
        const snap = await getDoc(doc(db, 'settings', 'integrations'));
        notifState.integrations = snap.exists() ? snap.data() : null;
        return notifState.integrations;
    } catch (e) {
        console.warn('Integration config load warning:', e);
        return null;
    }
}

/**
 * Send formatted notification to GapoWork Incoming Webhook and/or Telegram Bot API
 */
export async function dispatchExternalWebhook({ eventType = 'general', title = '', lines = [], url = '' }) {
    const cfg = notifState.integrations || (await loadIntegrationConfig());
    if (!cfg || cfg.enabled === false) return { sent: false, reason: 'disabled' };

    if (Array.isArray(cfg.enabledEvents) && cfg.enabledEvents.length > 0 && eventType !== 'test') {
        if (!cfg.enabledEvents.includes(eventType)) return { sent: false, reason: 'event_filtered' };
    }

    const bodyLines = [
        `🔔 [NEVO-TASK] ${title}`,
        ...lines.filter(Boolean),
        url ? `🔗 Mở hệ thống: ${url}` : `🔗 Hệ thống: ${window.location.origin}`
    ];
    const plainText = bodyLines.join('\n');
    const results = [];

    if (cfg.gapoWebhookUrl && safeUrl(cfg.gapoWebhookUrl)) {
        try {
            await fetch(cfg.gapoWebhookUrl.trim(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: plainText })
            });
            results.push('GapoWork');
        } catch (err) {
            console.warn('GapoWork webhook error:', err);
        }
    }

    if (cfg.telegramBotToken && cfg.telegramChatId) {
        try {
            const tgUrl = `https://api.telegram.org/bot${encodeURIComponent(cfg.telegramBotToken.trim())}/sendMessage`;
            await fetch(tgUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: String(cfg.telegramChatId).trim(),
                    text: plainText,
                    disable_web_page_preview: true
                })
            });
            results.push('Telegram');
        } catch (err) {
            console.warn('Telegram webhook error:', err);
        }
    }

    return { sent: results.length > 0, channels: results };
}

/**
 * Create an in-app real-time notification in Firestore (+ optional external webhook)
 */
export async function createAppNotification({
    title,
    body = '',
    type = 'info',
    orderId = '',
    orderCode = '',
    taskId = '',
    recipientName = '',
    recipientEmpId = '',
    recipients = [],
    targetAll = false,
    linkPage = 'orders',
    webhookEvent = ''
}) {
    if (!db || !title) return;
    const me = getCurrentUser();
    try {
        await addDoc(collection(db, 'notifications'), {
            title: String(title).trim(),
            body: String(body || '').trim(),
            type,
            orderId: orderId || '',
            orderCode: orderCode || '',
            taskId: taskId || '',
            recipientName: recipientName || '',
            recipientEmpId: recipientEmpId || '',
            recipients: Array.isArray(recipients) ? recipients.filter(Boolean) : [],
            targetAll: Boolean(targetAll),
            linkPage: linkPage || 'orders',
            actorName: me.name || 'Hệ thống',
            readBy: me.empId ? [me.empId] : (me.name ? [me.name] : []),
            createdAt: serverTimestamp()
        });

        if (webhookEvent) {
            dispatchExternalWebhook({
                eventType: webhookEvent,
                title,
                lines: [body, orderCode ? `Mã đơn: #${orderCode}` : '', `Thực hiện bởi: ${me.name || 'Hệ thống'}`]
            });
        }
    } catch (err) {
        console.warn('Create notification error:', err);
    }
}

function renderNotificationDropdown() {
    const dropdown = document.getElementById('notifDropdown');
    const btn = document.getElementById('notifBtn');
    if (!dropdown || !btn) return;

    const me = getCurrentUser();
    const myItems = notifState.items.filter(n => isNotificationForMe(n, me)).slice(0, 30);
    const unreadCount = myItems.filter(n => !isNotificationRead(n, me)).length;

    // Update red badge on #notifBtn
    let badge = btn.querySelector('[data-notif-badge]');
    if (!badge) {
        const legacyDot = btn.querySelector('span.bg-primary');
        if (legacyDot) legacyDot.remove();
        badge = document.createElement('span');
        badge.dataset.notifBadge = '1';
        badge.className = 'absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-primary text-white text-[10px] font-black rounded-full border-2 border-white dark:border-slate-900 flex items-center justify-center leading-none';
        btn.appendChild(badge);
    }
    if (unreadCount > 0) {
        badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }

    const typeColors = {
        mention: 'bg-indigo-500',
        proofing: 'bg-amber-500',
        approved: 'bg-emerald-500',
        deadline: 'bg-rose-600',
        create: 'bg-primary',
        info: 'bg-blue-500'
    };

    const listHtml = myItems.length === 0
        ? `<div class="py-10 px-4 text-center text-slate-400">
                <span class="material-symbols-outlined text-3xl opacity-40 block mb-1">notifications_paused</span>
                <p class="text-xs font-semibold">Chưa có thông báo mới dành cho bạn</p>
           </div>`
        : myItems.map(n => {
            const unread = !isNotificationRead(n, me);
            const dotCls = typeColors[n.type] || 'bg-primary';
            return `
                <button type="button" onclick="window.handleNotificationClick('${escapeJsStr(n.id)}')"
                    class="w-full text-left p-3.5 hover:bg-slate-50 dark:hover:bg-slate-800/70 transition-colors border-b border-slate-100 dark:border-slate-800 flex items-start gap-3 ${unread ? 'bg-rose-50/40 dark:bg-rose-950/20' : ''}">
                    <span class="w-2.5 h-2.5 rounded-full ${unread ? dotCls : 'bg-slate-300 dark:bg-slate-600'} mt-1.5 shrink-0"></span>
                    <div class="min-w-0 flex-1">
                        <p class="text-xs ${unread ? 'font-extrabold text-slate-900 dark:text-white' : 'font-semibold text-slate-600 dark:text-slate-300'} leading-snug">${escapeHtml(n.title)}</p>
                        ${n.body ? `<p class="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 mt-0.5">${escapeHtml(n.body)}</p>` : ''}
                        <p class="text-[10px] font-bold text-slate-400 mt-1">${escapeHtml(formatRelativeTime(n.createdAt))}${n.orderCode ? ` · #${escapeHtml(n.orderCode)}` : ''}</p>
                    </div>
                </button>
            `;
        }).join('');

    dropdown.innerHTML = `
        <div class="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <div class="flex items-center gap-2">
                <h3 class="font-headline font-extrabold text-sm">Thông báo</h3>
                ${unreadCount > 0 ? `<span class="px-2 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950 text-primary text-[10px] font-black">${unreadCount} mới</span>` : ''}
            </div>
            ${unreadCount > 0 ? `<button type="button" onclick="window.markAllNotificationsRead(event)" class="text-[11px] font-bold text-primary hover:underline">Đọc tất cả</button>` : ''}
        </div>
        <div class="max-h-80 overflow-y-auto">${listHtml}</div>
        <div class="p-2.5 bg-slate-50 dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between px-4">
            <span class="text-[10px] font-bold text-slate-400">Phím tắt tìm nhanh: <kbd class="px-1.5 py-0.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">Ctrl+K</kbd></span>
            <button type="button" onclick="window.openCommandPalette()" class="text-[11px] font-extrabold text-primary hover:underline">Tìm kiếm toàn cục</button>
        </div>
    `;
}

window.handleNotificationClick = async function(notifId) {
    const item = notifState.items.find(x => x.id === notifId);
    const dropdown = document.getElementById('notifDropdown');
    if (dropdown) dropdown.classList.remove('open');
    if (!item) return;

    const me = getCurrentUser();
    const readerKey = me.empId || me.name;
    if (readerKey && !isNotificationRead(item, me)) {
        try {
            await updateDoc(doc(db, 'notifications', item.id), {
                readBy: arrayUnion(readerKey)
            });
        } catch (e) {}
    }

    if (item.orderId && typeof window.jumpToOrder === 'function') {
        window.jumpToOrder(item.orderId);
        return;
    }
    if (item.taskId && typeof window.openScheduleTaskModal === 'function') {
        navigateTo('reports');
        setTimeout(() => window.openScheduleTaskModal(item.taskId), 260);
        return;
    }
    if (item.linkPage) {
        navigateTo(item.linkPage);
    }
};

window.markAllNotificationsRead = async function(event) {
    if (event) event.stopPropagation();
    const me = getCurrentUser();
    const readerKey = me.empId || me.name;
    if (!readerKey) return;

    const unread = notifState.items.filter(n => isNotificationForMe(n, me) && !isNotificationRead(n, me));
    await Promise.all(unread.map(n =>
        updateDoc(doc(db, 'notifications', n.id), { readBy: arrayUnion(readerKey) }).catch(() => {})
    ));
    showToast('Đã đánh dấu đã đọc', `Đã cập nhật ${unread.length} thông báo.`, 'done_all', 'info');
};

function startNotificationsListener() {
    if (!db || notifState.unsub) return;
    const q = query(collection(db, 'notifications'), orderBy('createdAt', 'desc'), limit(60));
    notifState.unsub = onSnapshot(q, (snap) => {
        const list = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() }));
        notifState.items = list;
        renderNotificationDropdown();
    }, (err) => {
        console.warn('Notifications listener warning:', err);
        renderNotificationDropdown();
    });
}

// =====================================================================
// GLOBAL COMMAND PALETTE (CTRL/CMD + K)
// =====================================================================

function ensureCommandPaletteDialog() {
    let dlg = document.getElementById('nevoCommandPalette');
    if (dlg) return dlg;

    dlg = document.createElement('dialog');
    dlg.id = 'nevoCommandPalette';
    dlg.setAttribute('closedby', 'any');
    dlg.setAttribute('aria-labelledby', 'cmdPaletteTitle');
    dlg.innerHTML = `
        <div class="p-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center gap-3">
            <span class="material-symbols-outlined text-primary text-[22px]">manage_search</span>
            <h2 id="cmdPaletteTitle" class="sr-only">Tìm kiếm và Lệnh nhanh Toàn cục</h2>
            <input id="cmdPaletteInput" type="search" autofocus autocomplete="off"
                placeholder="Tìm mã đơn #NV, tên công việc, nhân sự KPI, Model, hoặc gõ lệnh nhanh..."
                class="flex-1 bg-transparent border-none outline-none focus:ring-0 text-sm font-semibold text-slate-800 dark:text-slate-100 placeholder-slate-400"/>
            <button type="button" onclick="document.getElementById('nevoCommandPalette').close()" aria-label="Đóng tìm kiếm"
                class="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-[10px] font-black text-slate-500 hover:text-slate-800 dark:hover:text-white">ESC</button>
        </div>
        <div id="cmdPaletteResults" class="max-h-[62vh] overflow-y-auto p-2 space-y-1"></div>
        <div class="px-4 py-2.5 bg-slate-50 dark:bg-slate-900/90 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[11px] text-slate-400 font-semibold">
            <div class="flex items-center gap-3">
                <span><kbd class="px-1.5 py-0.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-bold">↑↓</kbd> Di chuyển</span>
                <span><kbd class="px-1.5 py-0.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-bold">Enter</kbd> Mở nhanh</span>
            </div>
            <span class="font-bold text-primary">Nevo Command Center</span>
        </div>
    `;
    document.body.appendChild(dlg);
    attachDialogLightDismiss(dlg);

    const input = dlg.querySelector('#cmdPaletteInput');
    input.addEventListener('input', () => {
        notifState.cmdActiveIdx = 0;
        renderCommandResults(input.value);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (notifState.cmdResults.length > 0) {
                notifState.cmdActiveIdx = (notifState.cmdActiveIdx + 1) % notifState.cmdResults.length;
                highlightActiveCmdItem();
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (notifState.cmdResults.length > 0) {
                notifState.cmdActiveIdx = (notifState.cmdActiveIdx - 1 + notifState.cmdResults.length) % notifState.cmdResults.length;
                highlightActiveCmdItem();
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const chosen = notifState.cmdResults[notifState.cmdActiveIdx];
            if (chosen) executeCommandItem(chosen);
        }
    });

    return dlg;
}

function buildCommandCandidates(rawQuery) {
    const q = String(rawQuery || '').trim().toLowerCase();
    const results = [];

    const actions = [
        { group: 'Lệnh nhanh', icon: 'add_circle', title: 'Tạo đơn hàng Creative mới', sub: 'Mở trang khởi tạo đơn hàng NV-xxxx', run: () => navigateTo('create-order') },
        { group: 'Lệnh nhanh', icon: 'view_kanban', title: 'Mở Bảng Kanban Đơn hàng (Kéo-Thả)', sub: 'Xem & kéo thả tiến độ đơn hàng trực quan', run: () => { navigateTo('orders'); setTimeout(() => window.switchOrdersView?.('kanban'), 220); } },
        { group: 'Lệnh nhanh', icon: 'view_week', title: 'Mở Lưới Tuần Triển khai Đơn hàng', sub: 'Lịch triển khai Thứ 2 → Chủ Nhật', run: () => { navigateTo('orders'); setTimeout(() => window.switchOrdersView?.('weekly'), 220); } },
        { group: 'Lệnh nhanh', icon: 'calendar_month', title: 'Mở Lịch làm việc & KPI Thành viên', sub: 'Theo dõi lịch tuần, tháng & 14 chỉ số đo lường', run: () => navigateTo('reports') },
        { group: 'Lệnh nhanh', icon: 'playlist_add', title: 'Lập lịch làm việc hàng loạt (Ngày / Tuần)', sub: 'Nhập nhanh công việc theo bảng thông minh', run: () => { navigateTo('reports'); setTimeout(() => window.openBulkScheduleModal?.({ mode: 'week' }), 240); } },
        { group: 'Lệnh nhanh', icon: 'event_note', title: 'Mở Bảng Kế hoạch Chiến dịch Tháng', sub: 'So sánh Kế hoạch vs Thực tế phòng ban', run: () => navigateTo('planning') },
        { group: 'Lệnh nhanh', icon: 'payments', title: 'Mở Báo cáo Chi phí & Sổ cái Tài chính', sub: 'Quản lý dự toán sản xuất & thực chi', run: () => navigateTo('budgetReport') },
        { group: 'Lệnh nhanh', icon: 'analytics', title: 'Mở Báo cáo Phân tích SLA Chi tiết', sub: 'Thời gian xử lý TB, tỷ lệ đúng hạn, xu hướng', run: () => navigateTo('detailed-report') },
        { group: 'Lệnh nhanh', icon: 'inventory_2', title: 'Chuyển sang Trang Sản phẩm mới', sub: 'Quản lý Mã 10, Mã 16, Ảnh Trải sàn / Model & Ngày air', run: () => { window.location.href = 'products.html'; } },
        { group: 'Lệnh nhanh', icon: 'face_3', title: 'Chuyển sang Danh bạ Booking Model', sub: 'Tra cứu hồ sơ người mẫu & đơn giá cát-xê', run: () => { window.location.href = 'model.html'; } },
        { group: 'Lệnh nhanh', icon: 'contrast', title: 'Chuyển đổi Giao diện Sáng / Tối (Dark Mode)', sub: 'Đổi nhanh chế độ màu toàn ứng dụng', run: () => toggleDarkMode() }
    ];

    if (notifState.deferredInstallPrompt) {
        actions.unshift({
            group: 'Lệnh nhanh',
            icon: 'install_desktop',
            title: 'Cài đặt Ứng dụng Nevo-Task về máy (PWA)',
            sub: 'Mở nhanh từ màn hình chính như phần mềm độc lập',
            run: () => window.triggerPwaInstall?.()
        });
    }

    actions.forEach(a => {
        if (!q || `${a.title} ${a.sub}`.toLowerCase().includes(q)) {
            results.push(a);
        }
    });

    // Orders search
    (window.allOrdersData || []).forEach(o => {
        const hay = `${o.code || ''} ${o.title || ''} ${o.requester || ''} ${o.department || ''} ${o.category || ''}`.toLowerCase();
        if (q ? hay.includes(q) : results.length < 14) {
            if (!q && results.filter(x => x.group === 'Đơn hàng').length >= 4) return;
            results.push({
                group: 'Đơn hàng',
                icon: 'receipt_long',
                title: `#${o.code || 'ORD'} — ${o.title || 'Không tiêu đề'}`,
                sub: `${o.status || 'Chờ duyệt'} · ${o.department || '-'} · Yêu cầu: ${o.requester || '-'}`,
                run: () => window.jumpToOrder?.(o.id)
            });
        }
    });

    // Staff & KPI Scorecards
    if (q) {
        (window.allUsersData || []).forEach(u => {
            if (!u.name) return;
            const hay = `${u.name} ${u.empId || ''} ${u.dept || ''}`.toLowerCase();
            if (hay.includes(q)) {
                results.push({
                    group: 'Nhân sự & KPI',
                    icon: 'badge',
                    title: `${u.name} (${u.empId || 'NV'})`,
                    sub: `Phòng: ${u.dept || '-'} · Xem thẻ điểm hiệu suất KPI`,
                    run: () => {
                        navigateTo('reports');
                        setTimeout(() => window.openMemberScorecard?.(u.name), 240);
                    }
                });
            }
        });

        // Schedule tasks
        (window.allScheduleTasks || []).forEach(t => {
            const hay = `${t.title || ''} ${t.assignee || ''} ${t.linkedOrderCode || ''}`.toLowerCase();
            if (hay.includes(q)) {
                results.push({
                    group: 'Lịch làm việc',
                    icon: 'task_alt',
                    title: t.title || 'Công việc',
                    sub: `${t.assignee || '-'} · ${t.date || ''} · ${t.status || ''}`,
                    run: () => {
                        navigateTo('reports');
                        setTimeout(() => window.openScheduleTaskModal?.(t.id), 240);
                    }
                });
            }
        });

        // Models
        (window.allModelsData || []).forEach(m => {
            const hay = `${m.name || ''} ${(m.categories || []).join(' ')}`.toLowerCase();
            if (hay.includes(q)) {
                results.push({
                    group: 'Người mẫu (Model)',
                    icon: 'face_3',
                    title: m.name || 'Model',
                    sub: `Cát-xê: ${Number(m.pricePerDay || 0).toLocaleString('vi-VN')} đ/ngày`,
                    run: () => { window.location.href = 'model.html'; }
                });
            }
        });
    }

    return results.slice(0, 28);
}

function renderCommandResults(queryText) {
    const container = document.getElementById('cmdPaletteResults');
    if (!container) return;

    notifState.cmdResults = buildCommandCandidates(queryText);
    if (notifState.cmdResults.length === 0) {
        container.innerHTML = `<div class="py-10 text-center text-xs font-semibold text-slate-400">Không tìm thấy kết quả phù hợp cho "${escapeHtml(queryText)}"</div>`;
        return;
    }

    let currentGroup = '';
    let html = '';
    notifState.cmdResults.forEach((item, idx) => {
        if (item.group !== currentGroup) {
            currentGroup = item.group;
            html += `<div class="px-3 pt-2 pb-1 text-[10px] font-black uppercase tracking-widest text-slate-400">${escapeHtml(currentGroup)}</div>`;
        }
        const activeCls = idx === notifState.cmdActiveIdx ? 'active' : '';
        html += `
            <button type="button" data-cmd-idx="${idx}"
                class="cmd-item ${activeCls} w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-3 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                <span class="w-8 h-8 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-primary flex items-center justify-center shrink-0">
                    <span class="material-symbols-outlined text-[18px]">${escapeHtml(item.icon)}</span>
                </span>
                <div class="min-w-0 flex-1">
                    <div class="text-xs font-extrabold truncate">${escapeHtml(item.title)}</div>
                    <div class="text-[11px] text-slate-400 truncate">${escapeHtml(item.sub)}</div>
                </div>
                <span class="material-symbols-outlined text-[16px] opacity-40">keyboard_return</span>
            </button>
        `;
    });

    container.innerHTML = html;
    container.querySelectorAll('button[data-cmd-idx]').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = Number(btn.dataset.cmdIdx);
            const chosen = notifState.cmdResults[idx];
            if (chosen) executeCommandItem(chosen);
        });
    });
}

function highlightActiveCmdItem() {
    const container = document.getElementById('cmdPaletteResults');
    if (!container) return;
    container.querySelectorAll('button[data-cmd-idx]').forEach((btn, idx) => {
        const isActive = idx === notifState.cmdActiveIdx;
        btn.classList.toggle('active', isActive);
        if (isActive) btn.scrollIntoView({ block: 'nearest' });
    });
}

function executeCommandItem(item) {
    const dlg = document.getElementById('nevoCommandPalette');
    if (dlg?.open) dlg.close();
    if (typeof item.run === 'function') item.run();
}

export function openCommandPalette(prefill = '') {
    const dlg = ensureCommandPaletteDialog();
    const input = dlg.querySelector('#cmdPaletteInput');
    notifState.cmdActiveIdx = 0;
    if (input) input.value = prefill || '';
    renderCommandResults(prefill || '');
    if (!dlg.open) dlg.showModal();
    setTimeout(() => input?.focus(), 20);
}

function initPwaInstallHandling() {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        notifState.deferredInstallPrompt = e;
        const installBtn = document.getElementById('pwaInstallMenuBtn');
        if (installBtn) installBtn.classList.remove('hidden');
    });

    window.triggerPwaInstall = async function() {
        if (!notifState.deferredInstallPrompt) {
            showToast('Cài đặt Ứng dụng', 'Trên trình duyệt này, hãy chọn menu Chia sẻ / Thêm vào Màn hình chính.', 'install_mobile', 'info');
            return;
        }
        notifState.deferredInstallPrompt.prompt();
        const choice = await notifState.deferredInstallPrompt.userChoice;
        if (choice?.outcome === 'accepted') {
            showToast('Cài đặt thành công!', 'Nevo-Task đã được thêm vào thiết bị của bạn.', 'download_done', 'success');
        }
        notifState.deferredInstallPrompt = null;
    };
}

function initNotificationsAndPalette() {
    startNotificationsListener();
    loadIntegrationConfig();
    initPwaInstallHandling();

    // Wire #globalSearch to open Command Palette cleanly
    const searchInput = document.getElementById('globalSearch');
    if (searchInput && !searchInput.dataset.cmdBound) {
        searchInput.dataset.cmdBound = '1';
        searchInput.readOnly = true;
        searchInput.classList.add('cursor-pointer');
        searchInput.placeholder = 'Tìm nhanh... (Ctrl + K)';
        searchInput.addEventListener('click', () => openCommandPalette());
        searchInput.addEventListener('focus', () => {
            searchInput.blur();
            openCommandPalette();
        });
    }

    // Global Ctrl/Cmd + K shortcut
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            openCommandPalette();
        }
    });
}

window.openCommandPalette = openCommandPalette;
window.createAppNotification = createAppNotification;
window.dispatchExternalWebhook = dispatchExternalWebhook;
window.loadIntegrationConfig = loadIntegrationConfig;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNotificationsAndPalette);
} else {
    initNotificationsAndPalette();
}
