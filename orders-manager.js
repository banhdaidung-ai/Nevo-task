/* 
  ORDERS MANAGER MODULE
  Manages order tracking, inline edits, history, windows, and exports
*/

import { 
    db, collection, addDoc, getDocs, getDoc, doc, 
    updateDoc, deleteDoc, query, where, orderBy, onSnapshot, 
    serverTimestamp, limit, startAfter, setDoc, runTransaction, Timestamp 
} from "./firebase-service.js";
import { formatDate, sanitizeNumber } from "./utils.js";
import { checkPermission } from "./auth-service.js";
import { showToast, navigateTo } from "./ui-service.js";

// Set globals for legacy support
window.db = db;
window.formatCurrency = (val) => {
    return Number(val || 0).toLocaleString('vi-VN') + ' đ';
};
window.sanitizeNumber = sanitizeNumber;

// Load and Sync Roles for Permission Management
window.appRoles = {};
const qRoles = query(collection(db, "system_roles"));
onSnapshot(qRoles, (snap) => {
    const roles = {};
    snap.forEach(doc => {
        roles[doc.id] = doc.data();
    });
    window.appRoles = roles;
    console.log("Permissions system updated:", Object.keys(roles).length, "roles loaded");
    
    // Refresh UI elements that depend on permissions
    if (typeof window.refreshPermissionUI === 'function') window.refreshPermissionUI();
});

// Middleware: Cập nhật đơn hàng kèm lưu lịch sử thay đổi (order_history)
window.updateOrderWithHistory = async function(orderId, updateData) {
    if (!db) return;
    try {
        const orderRef = doc(db, "orders", orderId);
        const snap = await getDoc(orderRef);
        if (!snap.exists()) return;
        const oldData = snap.data();
        const userName = localStorage.getItem('nevo_user_name') || localStorage.getItem('nevo_user') || 'Hệ thống';
        const changes = {};
        const skipFields = ['updatedAt', 'lastUpdatedBy'];
        const fieldLabels = {
            'status': 'Trạng thái', 'title': 'Tiêu đề', 'requester': 'Người yêu cầu',
            'department': 'Phòng ban', 'content': 'Nội dung', 'deadline': 'Hạn chót',
            'deployDate': 'Ngày triển khai', 'category': 'Hạng mục', 'stylist': 'Stylist',
            'assignedVideo': 'Video Editor', 'assignedPhoto': 'Photographer', 'assignedDesign': 'Designer',
            'costs': 'Chi phí chi tiết', 'totalCost': 'Tổng chi phí', 'note': 'Ghi chú'
        };
        for (const key in updateData) {
            if (skipFields.includes(key)) continue;
            if (JSON.stringify(oldData[key]) !== JSON.stringify(updateData[key])) {
                changes[key] = {
                    label: fieldLabels[key] || key,
                    old_value: (oldData[key] === undefined || oldData[key] === null) ? 'Trống' : oldData[key],
                    new_value: (updateData[key] === undefined || updateData[key] === null) ? 'Trống' : updateData[key]
                };
            }
        }
        // Thực hiện cập nhật
        await updateDoc(orderRef, {
            ...updateData,
            updatedAt: serverTimestamp(),
            lastUpdatedBy: userName
        });
        // Nếu có thay đổi thực sự, lưu vào order_history
        const changeKeys = Object.keys(changes);
        if (changeKeys.length > 0) {
            await addDoc(collection(db, "order_history"), {
                orderId: orderId,
                orderCode: oldData.code || 'N/A',
                operator: userName,
                timestamp: serverTimestamp(),
                changes: changes
            });
            // Log activity
            if (window.logActivity) {
                window.logActivity('update', `Sửa đơn ${oldData.code}`, `Thay đổi ${changeKeys.length} trường`, orderId, oldData.code);
            }
        }
    } catch (e) { console.error("Order History Error:", e); }
};

window.openHistoryDrawer = async function(orderId, orderCode) {
    const drawer = document.getElementById('historyDrawer');
    const overlay = document.getElementById('historyDrawerOverlay');
    const content = document.getElementById('historyDrawerContent');
    const timeline = document.getElementById('historyTimeline');
    const title = document.getElementById('historyDrawerTitle');
    
    title.textContent = `Lịch sử: ${orderCode}`;
    timeline.innerHTML = `
        <div class="flex flex-col items-center justify-center py-20 text-slate-400">
            <div class="relative">
                <span class="material-symbols-outlined text-[48px] animate-spin text-primary/20">progress_activity</span>
                <span class="material-symbols-outlined text-[24px] absolute inset-0 flex items-center justify-center text-primary">history</span>
            </div>
            <p class="text-sm font-bold mt-4 tracking-wide text-slate-500">ĐANG TRUY XUẤT DỮ LIỆU...</p>
        </div>`;
    
    drawer.classList.remove('hidden');
    setTimeout(() => {
        overlay.classList.replace('opacity-0', 'opacity-100');
        content.classList.replace('translate-x-full', 'translate-x-0');
    }, 10);
    
    try {
        const historyRef = collection(db, "order_history");
        const q = query(historyRef, where("orderId", "==", orderId));
        const snap = await getDocs(q);
        
        if (snap.empty) {
            timeline.innerHTML = `
                <div class="flex flex-col items-center justify-center py-20 text-slate-300">
                    <span class="material-symbols-outlined text-[64px] mb-4 opacity-20">history_off</span>
                    <p class="text-sm font-bold uppercase tracking-widest">Chưa có dữ liệu lịch sử</p>
                </div>`;
            return;
        }
        
        // Chuyển dữ liệu sang mảng và sắp xếp thủ công (Mới nhất lên đầu)
        const historyData = [];
        snap.forEach(doc => historyData.push({ id: doc.id, ...doc.data() }));
        historyData.sort((a, b) => {
            const timeA = a.timestamp?.seconds || new Date(a.timestamp).getTime();
            const timeB = b.timestamp?.seconds || new Date(b.timestamp).getTime();
            return timeB - timeA;
        });
        // Lưu trữ lịch sử hiện tại để truy xuất khi khôi phục
        window.lastFetchedHistory = historyData;

        let html = '';
        historyData.forEach((h, index) => {
            const time = h.timestamp?.toDate ? h.timestamp.toDate() : new Date(h.timestamp);
            const timeStr = time.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
            const dateStr = time.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
            
            let changesHtml = '';
            Object.keys(h.changes || {}).forEach(key => {
                const c = h.changes[key];
                changesHtml += `
                    <div class="mt-3 p-3 bg-white rounded-xl border border-slate-100 shadow-sm transition-all hover:border-primary/20">
                        <div class="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2 flex items-center gap-1.5">
                            <span class="w-1.5 h-1.5 rounded-full bg-primary/40"></span> ${c.label || key}
                        </div>
                        <div class="flex items-center gap-3">
                            <div class="flex-1 min-w-0">
                                <div class="text-[11px] text-slate-400 font-medium truncate italic line-through decoration-slate-300">${c.old_value}</div>
                                <div class="text-[12px] text-slate-700 font-bold truncate mt-0.5">${c.new_value}</div>
                            </div>
                        </div>
                    </div>
                `;
            });
            
            html += `
                <div class="relative pl-10 pb-10 group/item">
                    <!-- Timeline Line -->
                    <div class="absolute left-[11px] top-0 bottom-0 w-0.5 bg-slate-200 group-last/item:bg-transparent"></div>
                    
                    <!-- Timeline Point -->
                    <div class="absolute left-0 top-0 w-6 h-6 rounded-full bg-white border-4 border-slate-200 shadow-sm z-10 transition-all group-hover/item:border-primary group-hover/item:scale-110 flex items-center justify-center">
                        <div class="w-1.5 h-1.5 rounded-full bg-slate-300 group-hover/item:bg-primary"></div>
                    </div>

                    <div class="flex flex-col">
                        <div class="flex items-center gap-2 mb-2">
                            <span class="text-[10px] font-black bg-primary text-white px-2 py-0.5 rounded shadow-sm">${timeStr}</span>
                            <span class="text-[10px] font-bold text-slate-400">${dateStr}</span>
                        </div>
                        
                        <div class="bg-white/80 backdrop-blur-sm rounded-2xl p-5 border border-slate-200 shadow-sm transition-all group-hover/item:shadow-lg group-hover/item:border-primary/20 group-hover/item:-translate-y-1">
                            <div class="flex items-center justify-between mb-3">
                                <div class="flex items-center gap-2">
                                    <div class="w-8 h-8 rounded-full bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center text-slate-600 font-black text-[10px] shadow-inner">${h.operator.substring(0,2).toUpperCase()}</div>
                                    <div>
                                        <div class="text-[13px] font-black text-slate-800">${h.operator}</div>
                                        <div class="text-[10px] font-bold text-primary/70 uppercase tracking-tighter">Cập nhật hệ thống</div>
                                    </div>
                                </div>
                                <!-- Nút Khôi phục -->
                                <button onclick="window.confirmRestoreOrder('${orderId}', '${h.id}', '${timeStr} ${dateStr}')" 
                                        class="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 hover:bg-rose-50 text-slate-400 hover:text-rose-600 rounded-xl transition-all active:scale-95 group/btn border border-slate-100 hover:border-rose-100" 
                                        title="Khôi phục về trước thời điểm này">
                                    <span class="text-[10px] font-bold uppercase tracking-widest hidden group-hover/btn:block">Khôi phục</span>
                                    <span class="material-symbols-outlined text-[18px] group-hover/btn:rotate-[-45deg] transition-transform">undo</span>
                                </button>
                            </div>
                            
                            <div class="space-y-1">
                                ${changesHtml}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });
        timeline.innerHTML = html;
    } catch (err) {
        console.error("Lỗi tải lịch sử:", err);
        timeline.innerHTML = `
            <div class="text-center py-10">
                <div class="text-red-500 font-bold uppercase tracking-widest text-xs mb-2">KHÔNG THỂ TẢI DỮ LIỆU LỊCH SỬ.</div>
                <div class="text-[10px] text-slate-400 bg-red-50 p-3 rounded-lg border border-red-100 break-words font-mono">${err.message}</div>
            </div>`;
    }
};

window.confirmRestoreOrder = function(orderId, historyId, timeLabel) {
    const isConfirmed = confirm(`BÁO CÁO SẾP:\n\nAnh có chắc chắn muốn khôi phục đơn hàng về trạng thái lúc [${timeLabel}] không?\n\nHệ thống sẽ sử dụng các giá trị cũ từ bản ghi này để ghi đè lên dữ liệu hiện tại.`);
    
    if (isConfirmed) {
        window.applyRestoreOrder(orderId, historyId, timeLabel);
    }
};

window.applyRestoreOrder = async function(orderId, historyId, timeLabel) {
    try {
        showToast('Đang truy xuất bản ghi lịch sử...', 'info');
        
        // Lấy bản ghi lịch sử theo ID
        const historySnap = await getDoc(doc(db, "order_history", historyId));
        if (!historySnap.exists()) throw new Error("Không tìm thấy bản ghi lịch sử.");
        const historyItem = historySnap.data();

        showToast('Đang khôi phục dữ liệu...', 'info');
        
        // Chuẩn bị dữ liệu khôi phục (lấy giá trị cũ)
        const restoreData = {};
        const changes = historyItem.changes || {};
        Object.keys(changes).forEach(key => {
            restoreData[key] = changes[key].old_value;
        });

        // Cập nhật đơn hàng gốc
        await updateDoc(doc(db, "orders", orderId), restoreData);

        // Tạo bản ghi lịch sử mới ghi nhận hành động khôi phục
        const userName = localStorage.getItem('nevo_user') || 'Hệ thống';
        const restoreChanges = {};
        Object.keys(changes).forEach(key => {
            restoreChanges[key] = {
                label: changes[key].label || key,
                old_value: 'Trạng thái hiện tại',
                new_value: changes[key].old_value
            };
        });

        await addDoc(collection(db, "order_history"), {
            orderId: orderId,
            orderCode: historyItem.orderCode || 'N/A',
            operator: userName,
            timestamp: serverTimestamp(),
            action: 'RESTORE',
            details: `Khôi phục dữ liệu về phiên bản của ngày ${timeLabel}`,
            changes: restoreChanges
        });
        
        showToast('Khôi phục dữ liệu thành công!', 'success');
        
        // Reload lại bảng chính và Refresh Timeline
        if (window.renderOrdersTable) window.renderOrdersTable();
        if (window.renderDashboardTable) window.renderDashboardTable();
        
        // Refresh lại Timeline trong Drawer
        window.openHistoryDrawer(orderId, historyItem.orderCode);
        
    } catch (err) {
        console.error("Lỗi khôi phục:", err);
        showToast('Lỗi khi khôi phục: ' + err.message, 'error');
    }
};

window.closeHistoryDrawer = function() {
    const drawer = document.getElementById('historyDrawer');
    const overlay = document.getElementById('historyDrawerOverlay');
    const content = document.getElementById('historyDrawerContent');
    
    overlay.classList.replace('opacity-100', 'opacity-0');
    content.classList.replace('translate-x-0', 'translate-x-full');
    
    setTimeout(() => {
        drawer.classList.add('hidden');
    }, 500);
};

// ===== ORDER WINDOW CHECK SYSTEM =====
let indexOwInterval = null;
window.checkOrderWindowOpen = async function(category) {
    const role = (localStorage.getItem('nevo_role') || 'user').toLowerCase();
    if (role === 'admin' || role === 'manager') return { allowed: true };
    if (!db) return { allowed: true };
    try {
        const userId = localStorage.getItem('nevo_user_id') || localStorage.getItem('nevo_user') || '';
        const now = new Date();
        const q = query(
            collection(db, 'order_window_sessions'),
            where('status', '==', 'active')
        );
        const snap = await getDocs(q);
        let found = null;
        let openCategories = [];
        let shortestEnd = new Date(2100, 0, 1);
        snap.forEach(d => {
            const s = d.data();
            const end = s.endTime?.toDate ? s.endTime.toDate() : new Date(s.endTime);
            if (end > now) {
                const targets = s.targetUsers || ['all'];
                if (targets.includes('all') || targets.includes(userId)) {
                    const cats = s.targetCategories || ['all'];
                    // Collect all open categories from all active sessions
                    if (cats.includes('all')) {
                        openCategories = ['all'];
                    } else {
                        cats.forEach(c => { if (!openCategories.includes(c) && !openCategories.includes('all')) openCategories.push(c); });
                    }
                    // Check if specific category is allowed
                    if (!category || cats.includes('all') || cats.includes(category)) {
                        if (end < shortestEnd) {
                            shortestEnd = end;
                            found = { allowed: true, endTime: end, reason: s.reason || '', targetCategories: cats };
                        }
                    }
                }
            }
        });
        if (found) {
            found.openCategories = openCategories;
            return found;
        }
        // If we have open categories but the specific category isn't in them
        if (openCategories.length > 0 && category) {
            return { allowed: false, openCategories: openCategories, categoryBlocked: true };
        }
        return { allowed: false, openCategories: [] };
    } catch (e) {
        console.error('Check OW error:', e);
        return { allowed: true };
    }
};

window.updateOrderCategoryDropdown = async function() {
    if (!window.orderCategoriesData) return;
    const result = await window.checkOrderWindowOpen();
    let allowedCats = window.orderCategoriesData;
    if (!result.allowed) {
        allowedCats = [];
    } else if (result.openCategories && !result.openCategories.includes('all')) {
        allowedCats = window.orderCategoriesData.filter(c => result.openCategories.includes(c.name));
    }
    
    const catEl = document.getElementById('orderCategory');
    if (catEl) {
        const currentVal = catEl.value;
        catEl.innerHTML = '<option value="">- Chọn thể loại -</option>';
        allowedCats.forEach(cat => {
            const opt = document.createElement('option');
            opt.value = cat.name;
            opt.textContent = cat.name;
            catEl.appendChild(opt);
        });
        if (allowedCats.some(c => c.name === currentVal)) {
            catEl.value = currentVal;
        }
    }
};

window.updateIndexOwBanner = async function() {
    const role = (localStorage.getItem('nevo_role') || 'user').toLowerCase();
    const openBanner = document.getElementById('indexOwBanner');
    const closedBanner = document.getElementById('indexOwClosedBanner');
    const createBtn = document.getElementById('createOrderBtn');
    if (!openBanner || !closedBanner) return;
    if (role === 'admin' || role === 'manager') { openBanner.classList.add('hidden'); closedBanner.classList.add('hidden'); return; }

    let upcomingText = '';
    try {
        const configSnap = await getDoc(doc(db, 'order_window_config', 'settings'));
        if (configSnap.exists()) {
            const config = configSnap.data();
            if (config.autoEnabled) {
                const dayNames = ['Chủ Nhật','Thứ Hai','Thứ Ba','Thứ Tư','Thứ Năm','Thứ Sáu','Thứ Bảy'];
                const dayName = config.scheduledDay === -1 ? 'Hằng ngày' : dayNames[config.scheduledDay];
                upcomingText = `Lịch tự động tiếp theo: ${dayName} (${config.startTime || '08:00'} - ${config.endTime || '17:00'})`;
                
                const nextOpenEl = document.getElementById('indexOwNextOpen');
                if (nextOpenEl) nextOpenEl.textContent = upcomingText;
            }
        }
    } catch(e) {}

    const result = await window.checkOrderWindowOpen();
    if (result.allowed && result.endTime) {
        openBanner.classList.remove('hidden');
        closedBanner.classList.add('hidden');
        if (createBtn) { createBtn.disabled = false; createBtn.style.opacity = '1'; createBtn.title = ''; }
        
        const cats = result.openCategories || result.targetCategories || ['all'];
        let catText = cats.includes('all') ? 'Tất cả thể loại' : cats.join(', ');
        
        document.getElementById('indexOwReason').textContent = (result.reason || '') + ' | ' + catText;
        
        const upcomingEl = document.getElementById('indexOwUpcoming');
        if (upcomingEl && upcomingText) {
            upcomingEl.textContent = upcomingText;
        }

        if (indexOwInterval) clearInterval(indexOwInterval);
        const tick = function() {
            const diff = result.endTime - new Date();
            if (diff <= 0) {
                openBanner.classList.add('hidden'); closedBanner.classList.remove('hidden'); clearInterval(indexOwInterval);
                if (createBtn) { createBtn.disabled = true; createBtn.style.opacity = '0.5'; createBtn.title = 'Bảng đơn đã đóng'; }
                return;
            }
            
            const timerEl = document.getElementById('indexOwTimer');
            const labelEl = document.getElementById('indexOwTimerLabel');
            
            if (diff > 30 * 24 * 60 * 60 * 1000) {
                timerEl.textContent = 'Mở 24/7';
                timerEl.classList.remove('text-2xl');
                timerEl.classList.add('text-lg');
                if (labelEl) labelEl.classList.add('hidden');
                clearInterval(indexOwInterval);
            } else {
                timerEl.classList.add('text-2xl');
                timerEl.classList.remove('text-lg');
                if (labelEl) labelEl.classList.remove('hidden');
                const h = String(Math.floor(diff/3600000)).padStart(2,'0');
                const m = String(Math.floor((diff%3600000)/60000)).padStart(2,'0');
                const s = String(Math.floor((diff%60000)/1000)).padStart(2,'0');
                timerEl.textContent = h+':'+m+':'+s;
            }
        }
        tick();
        indexOwInterval = setInterval(tick, 1000);
    } else if (!result.allowed) {
        openBanner.classList.add('hidden');
        closedBanner.classList.remove('hidden');
        if (createBtn) { createBtn.disabled = true; createBtn.style.opacity = '0.5'; createBtn.title = 'Bảng đơn đang đóng. Liên hệ quản trị viên.'; }
    } else {
        openBanner.classList.add('hidden');
        closedBanner.classList.add('hidden');
    }
};

// Auto-check & create scheduled session from index page
window.indexAutoSchedulerCheck = async function() {
    if (!db) return;
    try {
        const configSnap = await getDoc(doc(db, 'order_window_config', 'settings'));
        if (!configSnap.exists()) return;
        const config = configSnap.data();
        if (!config.autoEnabled) return;
        const now = new Date();
        if (now.getDay() !== config.scheduledDay && config.scheduledDay !== -1) return;
        const [sH, sM] = (config.startTime||'08:00').split(':').map(Number);
        const [eH, eM] = (config.endTime||'17:00').split(':').map(Number);
        const startD = new Date(now); startD.setHours(sH,sM,0,0);
        const endD = new Date(now); endD.setHours(eH,eM,0,0);
        if (now < startD || now > endD) return;
        const todayStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
        const q = query(
            collection(db, 'order_window_sessions'),
            where('type','==','scheduled'),
            where('dateKey','==',todayStr)
        );
        const ex = await getDocs(q);
        if (!ex.empty) return;
        await addDoc(collection(db, 'order_window_sessions'), {
            type:'scheduled', status:'active',
            startTime: Timestamp.fromDate(startD),
            endTime: Timestamp.fromDate(endD),
            targetUsers:['all'],
            targetCategories: config.allowedCategories || ['all'],
            reason:'Lịch tự động '+ (config.scheduledDay === -1 ? 'Hằng ngày' : ['CN','T2','T3','T4','T5','T6','T7'][config.scheduledDay]),
            dateKey:todayStr, createdBy:'Hệ thống (Auto)', createdAt:serverTimestamp()
        });
    } catch(e) { console.error('Index auto-scheduler error:', e); }
};

// Run checks periodically
setTimeout(() => { window.indexAutoSchedulerCheck(); window.updateIndexOwBanner(); }, 2000);
setInterval(() => { window.updateIndexOwBanner(); }, 30000);
setInterval(() => { window.indexAutoSchedulerCheck(); }, 60000);


// ===== CREATE ORDER HANDLER =====
window.handleCreateOrder = async function() {
    if (!checkPermission('create')) {
        showToast('Từ chối!', 'Bạn không có quyền tạo đơn hàng.', 'block', 'error');
        return;
    }

    const category = document.getElementById('orderCategory').value;
    if (!category || category === '- Chọn thể loại -') {
        showToast('Lỗi!', 'Vui lòng chọn thể loại cho đơn hàng.', 'error', 'error');
        return;
    }

    // Check Order Window with selected category
    const owResult = await window.checkOrderWindowOpen(category);
    if (!owResult.allowed) {
        if (owResult.categoryBlocked) {
            showToast('Thể loại bị khóa!', `Thể loại "${category}" hiện không được phép tạo đơn. Thể loại đang mở: ${(owResult.openCategories||[]).join(', ')}`, 'block', 'error');
        } else {
            showToast('Bảng đơn đang đóng!', 'Hiện tại chưa đến thời gian tạo đơn. Vui lòng liên hệ quản trị viên.', 'lock', 'error');
        }
        return;
    }
    const title = document.getElementById('orderTitle').value;
    let code = document.getElementById('orderCode').value;
    const department = document.getElementById('department').value;
    const requester = document.getElementById('requester').value;
    const deadline = document.getElementById('deadline').value;
    const content = document.getElementById('orderEditor').innerHTML;
    
    // Removed fields default to empty
    const deployDate = '';
    const stylist = '';
    const assignedVideo = '';
    const assignedPhoto = '';
    const assignedDesign = '';
    
    if (!title || !deadline) {
        showToast('Lỗi!', 'Vui lòng điền đủ tiêu đề và hạn chót.', 'error', 'error');
        return;
    }
    
    const btn = document.getElementById('submitOrderBtn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>Đang xử lý...';
    btn.disabled = true;
    
    try {
        if (db) {
            // Sử dụng Transaction để lấy số đếm mới nhất an toàn
            const counterRef = doc(db, "counters", "orders");
            code = await runTransaction(db, async (transaction) => {
                const sfDoc = await transaction.get(counterRef);
                let newCount = 1;
                if (sfDoc.exists()) {
                    newCount = sfDoc.data().count + 1;
                }
                // Cập nhật lại số đếm mới
                transaction.set(counterRef, { count: newCount }, { merge: true });
                return 'NV-' + newCount.toString().padStart(4, '0');
            });

            // Lưu dữ liệu vào mảng orders với mã vừa tạo
            await addDoc(collection(db, "orders"), {
                code: code,
                department: department,
                requester: requester,
                title: title,
                deadline: deadline,
                deployDate: deployDate,
                content: content,
                category: category,
                stylist: stylist,
                assignedVideo: assignedVideo,
                assignedPhoto: assignedPhoto,
                assignedDesign: assignedDesign,
                status: 'Chờ duyệt',
                createdAt: serverTimestamp()
            });
            
            // LOG ACTIVITY
            if (window.logActivity) {
                window.logActivity('create', `Đơn hàng mới ${code}`, `${requester || 'Ai đó'} vừa khởi tạo đơn hàng: ${title}`, null, code);
            }
        }
        
        btn.innerHTML = originalText;
        btn.disabled = false;
        showToast('Thành công!', `Đơn hàng ${code} đã được tự động cấp và lưu trên hệ thống.`, 'check_circle', 'success');
        
        setTimeout(() => {
            navigateTo('orders');
            document.getElementById('orderTitle').value = '';
            document.getElementById('orderContent').value = '';
            document.getElementById('orderDeployDate').value = '';
            document.getElementById('assignedStylist').value = '';
            document.getElementById('assignedVideo').value = '';
            document.getElementById('assignedPhoto').value = '';
        }, 1000);
    } catch (error) {
        console.error("Lỗi:", error);
        btn.innerHTML = originalText;
        btn.disabled = false;
        showToast('Lỗi!', 'Không thể lưu lên mạng. Kiểm tra kết nối.', 'error', 'error');
    }
};


// ===== Load online data into tables with Filters and Actions =====
window.allOrdersData = [];
window.departmentsData = [];
window.orderStatusesData = [];
window.allUsersData = [];
window.orderCategoriesData = [];
window.currentFilteredOrders = [];
window.allActivitiesData = [];

let currentTablePage = 0;
const itemsPerPage = 50;
let sortConfig = { key: 'createdAt', direction: 'desc' };
let isManualSortActive = false;
let columnFilters = {};

window.toggleSort = function(key) {
    if (sortConfig.key === key) {
        sortConfig.direction = sortConfig.direction === 'asc' ? 'desc' : 'asc';
    } else {
        sortConfig.key = key;
        sortConfig.direction = 'desc';
    }
    isManualSortActive = true;
    currentTablePage = 0;
    window.renderOrdersTable();
};

window.updateColumnFilter = function(key, val) {
    if (!val) delete columnFilters[key];
    else columnFilters[key] = val.toLowerCase();
    currentTablePage = 0; // Reset to page 1 on filter
    window.renderOrdersTable();
};

window.toggleColumnFilter = function(key, val, isChecked) {
    if (!columnFilters[key]) columnFilters[key] = [];
    if (!Array.isArray(columnFilters[key])) columnFilters[key] = []; // Safety

    if (val === 'ALL') {
        columnFilters[key] = [];
        // Uncheck other checkboxes in this specific menu
        const menu = document.getElementById(`menu-${key}`) || (key === 'assignedVideo' ? document.getElementById('menu-video') : null) || (key === 'assignedPhoto' ? document.getElementById('menu-photo') : null) || (key === 'assignedDesign' ? document.getElementById('menu-design') : null);
        if(menu) menu.querySelectorAll('input[type="checkbox"]').forEach(c => c.checked = false);
    } else {
        if (isChecked) {
            if (!columnFilters[key].includes(val)) columnFilters[key].push(val);
        } else {
            columnFilters[key] = columnFilters[key].filter(v => v !== val);
        }
    }

    if (columnFilters[key].length === 0) delete columnFilters[key];
    
    // Update Trigger Label
    const trigger = document.getElementById(`trigger-${key}`);
    if(trigger) {
        const count = columnFilters[key] ? columnFilters[key].length : 0;
        const originalLabel = trigger.getAttribute('data-label');
        trigger.textContent = count > 0 ? `${originalLabel} (${count})` : originalLabel;
    }

    // Highlight "All" option if no filters
    const allBtn = document.getElementById(`all-${key}`);
    if(allBtn) {
        if(!columnFilters[key] || columnFilters[key].length === 0) allBtn.classList.add('all-active');
        else allBtn.classList.remove('all-active');
    }

    currentTablePage = 0;
    window.renderOrdersTable();
};

window.clearAllFilters = function() {
    columnFilters = {};
    // Reset Search Inputs
    if (document.getElementById('filterSearch')) document.getElementById('filterSearch').value = '';
    if (document.getElementById('filterStatus')) document.getElementById('filterStatus').value = '';
    
    // Reset Filter Row Inputs
    document.querySelectorAll('.column-filter').forEach(input => {
        input.value = '';
    });
    
    // Uncheck all Multi-selects
    document.querySelectorAll('.multi-select-menu input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
    });
    
    // Reset Sort & Grouping
    sortConfig = { key: 'createdAt', direction: 'desc' };
    isManualSortActive = false;
    
    // Reset Sort Icons in Headers
    document.querySelectorAll('.sort-icon').forEach(icon => {
        icon.textContent = 'unfold_more';
        icon.classList.remove('active');
    });

    // Reset Multi-select Triggers
    document.querySelectorAll('.multi-select-trigger, .date-range-trigger').forEach(trigger => {
        trigger.textContent = trigger.getAttribute('data-label');
        trigger.classList.remove('active');
        trigger.style.color = '';
        trigger.style.borderColor = '';
        // Highlight "All" option
        const key = trigger.id.replace('trigger-', '');
        const allBtn = document.getElementById(`all-${key}`);
        if(allBtn) allBtn.classList.add('all-active');
    });

    // Also close all menus
    document.querySelectorAll('.multi-select-menu, .date-range-menu').forEach(m => m.classList.remove('show'));

    currentTablePage = 0;
    window.renderOrdersTable();
    showToast('Đã xóa bộ lọc', 'Bộ lọc và sắp xếp đã được đưa về mặc định', 'filter_list_off', 'info');
};

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.multi-select-container') && !e.target.closest('.date-range-container')) {
        document.querySelectorAll('.multi-select-menu, .date-range-menu').forEach(menu => menu.classList.remove('show'));
    }
});

window.toggleMultiSelect = function(id) {
    const menu = document.getElementById(id);
    if (!menu) return;
    const isShown = menu.classList.contains('show');
    document.querySelectorAll('.multi-select-menu, .date-range-menu').forEach(m => m.classList.remove('show'));
    if (!isShown) menu.classList.add('show');
};

window.toggleDateRange = function(id) {
    const menu = document.getElementById('menu-' + id);
    if (!menu) return;
    const isShown = menu.classList.contains('show');
    document.querySelectorAll('.multi-select-menu, .date-range-menu').forEach(m => m.classList.remove('show'));
    if (!isShown) menu.classList.add('show');
};

window.updateDateRangeFilter = function(baseKey, val, suffix) {
    const fullKey = baseKey + '_' + suffix;
    if (!val) delete columnFilters[fullKey];
    else columnFilters[fullKey] = val;
    
    // Update Trigger Label
    const start = columnFilters[baseKey + '_start'];
    const end = columnFilters[baseKey + '_end'];
    const trigger = document.getElementById(`trigger-${baseKey}`);
    if (trigger) {
        if (start || end) {
            const s = start ? start.split('-').slice(1).reverse().join('/') : '...';
            const e = end ? end.split('-').slice(1).reverse().join('/') : '...';
            trigger.textContent = `${s} - ${e}`;
            trigger.style.color = '#b80035';
            trigger.style.borderColor = '#b80035';
        } else {
            trigger.textContent = trigger.getAttribute('data-label');
            trigger.style.color = '';
            trigger.style.borderColor = '';
        }
    }
    
    currentTablePage = 0;
    window.renderOrdersTable();
};

// Close on escape
document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape') {
        document.querySelectorAll('.multi-select-menu, .date-range-menu').forEach(m => m.classList.remove('show'));
    }
});

// Global Badge Helpers
window.getCategoryBadge = function(cat) {
    if (!cat || cat === '-') return '<span class="text-slate-400">-</span>';
    let classes = 'bg-slate-100 text-slate-600';
    if (cat.includes('Video')) classes = 'bg-blue-100 text-blue-700 border-blue-200';
    if (cat.includes('Hình Ảnh')) classes = 'bg-emerald-100 text-emerald-700 border-emerald-200';
    if (cat.includes('Livestream')) classes = 'bg-rose-100 text-rose-700 border-rose-200';
    if (cat.includes('Giả Live')) classes = 'bg-amber-100 text-amber-700 border-amber-200';
    return `<span class="inline-flex items-center px-2.5 py-1 rounded-lg text-[10px] font-black border ${classes} uppercase tracking-widest shadow-sm">
        <span class="w-1.5 h-1.5 rounded-full mr-1.5 ${cat.includes('Video')?'bg-blue-400':cat.includes('Hình Ảnh')?'bg-emerald-400':cat.includes('Livestream')?'bg-rose-400':'bg-amber-400'}"></span>
        ${cat}
    </span>`;
};

// Safe encode for HTML attributes - escapes quotes, ampersands, angle brackets
function safeAttr(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, ' ').replace(/\r/g, '');
}

// Safe encode for use inside JS string in HTML attributes
function safeEncodeForAttr(str) {
    return encodeURIComponent(str || '').replace(/'/g, '%27');
}
window.safeEncodeForAttr = safeEncodeForAttr;

function formatDateDisplay(dateStr) {
    if (!dateStr) return '-';
    if (dateStr.toDate) { // Check for Firestore Timestamp
        const d = dateStr.toDate();
        return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    }
    if (typeof dateStr === 'string' && dateStr.includes('T')) {
        const d = new Date(dateStr);
        return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    }
    if (typeof dateStr === 'string' && dateStr.includes('-')) {
        return dateStr.split('-').reverse().join('/');
    }
    return dateStr;
}

function getDayOfWeekVN(date) {
    const days = ['CHỦ NHẬT', 'THỨ 2', 'THỨ 3', 'THỨ 4', 'THỨ 5', 'THỨ 6', 'THỨ 7'];
    return days[date.getDay()];
}

function formatGroupValue(val, key) {
    if (!val) return 'KHÔNG XÁC ĐỊNH';
    if (['createdAt', 'deployDate', 'deadline'].includes(key)) {
        const d = (val.toDate ? val.toDate() : new Date(val));
        if (isNaN(d.getTime())) return 'NGÀY KHÔNG HỢP LỆ';
        const day = getDayOfWeekVN(d);
        const datePart = `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}`;
        return `${day}, ${datePart}`;
    }
    
    // Map keys to readable labels if needed
    const labels = {
        'department': 'Phòng ban',
        'status': 'Trạng thái',
        'category': 'Thể loại',
        'requester': 'Thành viên',
        'stylist': 'Stylist',
        'assignedVideo': 'Video',
        'assignedPhoto': 'Photo',
        'assignedDesign': 'Design',
        'code': 'Mã đơn'
    };
    const label = labels[key] || '';
    return label ? `${label}: ${String(val).toUpperCase()}` : String(val).toUpperCase();
}

function getNormalizedGroupValue(data, key) {
    const val = data[key];
    if (!val) return 'null';
    if (['createdAt', 'deployDate', 'deadline'].includes(key)) {
        const d = (val.toDate ? val.toDate() : new Date(val));
        if (isNaN(d.getTime())) return 'invalid';
        return `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`;
    }
    return String(val);
}

function getGroupIcon(key) {
    const icons = {
        'createdAt': 'calendar_today',
        'deployDate': 'event_available',
        'deadline': 'timer',
        'requester': 'person',
        'stylist': 'palette',
        'assignedVideo': 'video_library',
        'assignedPhoto': 'photo_camera',
        'assignedDesign': 'palette',
        'department': 'domain',
        'status': 'label',
        'category': 'category',
        'code': 'tag'
    };
    return icons[key] || 'folder';
}

window.setQuickFilter = function(status) {
    const filterStatusEl = document.getElementById('filterStatus');
    if(filterStatusEl) filterStatusEl.value = status;
    currentTablePage = 0;
    window.renderOrdersTable();
};

window.renderOrdersTable = function() {
    const tbodyFull = document.getElementById('ordersTableBody');
    if (!tbodyFull) return;

    // Update Stats based on allOrdersData (Global Totals)
    let totalAll = 0, waiting = 0, processing = 0, done = 0, canceled = 0;
    let myTotal = 0, myWaiting = 0, myProcessing = 0, myDone = 0;
    const currentUserName = localStorage.getItem('nevo_user') || '';

    (window.allOrdersData || []).forEach(o => {
        const isMyOrder = o.requester === currentUserName || o.stylist === currentUserName || o.assignedVideo === currentUserName || o.assignedPhoto === currentUserName || o.assignedDesign === currentUserName;
        totalAll++;
        if (o.status === 'Chờ duyệt') waiting++;
        else if (o.status === 'Đang xử lý' || o.status === 'Triển khai') processing++;
        else if (o.status === 'Hoàn thành') done++;
        else if (o.status === 'Hủy') canceled++;

        if (isMyOrder) {
            myTotal++;
            if (o.status === 'Chờ duyệt') myWaiting++;
            else if (o.status === 'Đang xử lý' || o.status === 'Triển khai') myProcessing++;
            else if (o.status === 'Hoàn thành') myDone++;
        }
    });

    const activeTab = document.querySelector('.quick-filter-tabs button.active')?.id || 'tab-all';
    
    // Update KPI badges
    if (activeTab === 'tab-my') {
        if (document.getElementById('statTotal')) document.getElementById('statTotal').textContent = myTotal;
        if (document.getElementById('statPending')) document.getElementById('statPending').textContent = myWaiting;
        if (document.getElementById('statProcessing')) document.getElementById('statProcessing').textContent = myProcessing;
        if (document.getElementById('statCompleted')) document.getElementById('statCompleted').textContent = myDone;
    } else {
        if (document.getElementById('statTotal')) document.getElementById('statTotal').textContent = totalAll;
        if (document.getElementById('statPending')) document.getElementById('statPending').textContent = waiting;
        if (document.getElementById('statProcessing')) document.getElementById('statProcessing').textContent = processing;
        if (document.getElementById('statCompleted')) document.getElementById('statCompleted').textContent = done;
    }

    // Filter
    let filtered = window.allOrdersData.filter(data => {
        // Active Tab Filter (My Jobs)
        if (activeTab === 'tab-my') {
            const isRelated = data.requester === currentUserName || data.stylist === currentUserName || data.assignedVideo === currentUserName || data.assignedPhoto === currentUserName || data.assignedDesign === currentUserName;
            if (!isRelated) return false;
        }

        // Search Input (Global Title/Code)
        const qSearch = document.getElementById('filterSearch')?.value.trim().toLowerCase();
        if (qSearch) {
            const code = (data.code || '').toLowerCase();
            const title = (data.title || '').toLowerCase();
            const requester = (data.requester || '').toLowerCase();
            const category = (data.category || '').toLowerCase();
            if (!code.includes(qSearch) && !title.includes(qSearch) && !requester.includes(qSearch) && !category.includes(qSearch)) return false;
        }

        // Quick Status Filter
        const qStatus = document.getElementById('filterStatus')?.value;
        if (qStatus && data.status !== qStatus) return false;

        // Column-specific Text Filters (From Filter Row inputs)
        let matchTextInputs = true;
        document.querySelectorAll('.column-filter').forEach(input => {
            const key = input.dataset.column;
            const val = input.value.trim().toLowerCase();
            if (val && key) {
                const itemVal = String(data[key] || '').toLowerCase();
                if (!itemVal.includes(val)) matchTextInputs = false;
            }
        });
        if (!matchTextInputs) return false;

        // Multi-select and Date-range Filters
        const matchColumns = Object.keys(columnFilters).every(key => {
            const filterVal = columnFilters[key];
            
            // Check for date range
            if (key.endsWith('_start') || key.endsWith('_end')) {
                const baseKey = key.replace('_start', '').replace('_end', '');
                const startVal = columnFilters[baseKey + '_start'];
                const endVal = columnFilters[baseKey + '_end'];
                
                const itemDateStr = data[baseKey];
                if (!itemDateStr) return false;
                
                const dDate = new Date(itemDateStr);
                if (isNaN(dDate.getTime())) return false;
                
                if (startVal) {
                    const dStart = new Date(startVal);
                    dStart.setHours(0,0,0,0);
                    if (dDate < dStart) return false;
                }
                if (endVal) {
                    const dEnd = new Date(endVal);
                    dEnd.setHours(23,59,59,999);
                    if (dDate > dEnd) return false;
                }
                return true;
            }

            // Normal multi-select array check
            if (Array.isArray(filterVal) && filterVal.length > 0) {
                const itemVal = data[key] || '-';
                return filterVal.includes(itemVal);
            }
            return true;
        });

        return matchColumns;
    });

    // Save filtered results for Excel Export
    window.currentFilteredOrders = filtered;

    // Sorting
    if (sortConfig.key) {
        filtered.sort((a, b) => {
            let valA = a[sortConfig.key];
            let valB = b[sortConfig.key];

            // Normalize values for sorting
            if (sortConfig.key === 'createdAt' || sortConfig.key === 'deployDate' || sortConfig.key === 'deadline') {
                const timeA = valA ? (valA.toDate ? valA.toDate().getTime() : new Date(valA).getTime()) : 0;
                const timeB = valB ? (valB.toDate ? valB.toDate().getTime() : new Date(valB).getTime()) : 0;
                return sortConfig.direction === 'asc' ? timeA - timeB : timeB - timeA;
            }

            valA = String(valA || '').toLowerCase();
            valB = String(valB || '').toLowerCase();

            if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
            if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
            return 0;
        });
    }

    // Set Sort Icons visually in Headers
    document.querySelectorAll('.sort-icon').forEach(icon => {
        const headerKey = icon.closest('th')?.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
        if (headerKey === sortConfig.key) {
            icon.textContent = sortConfig.direction === 'asc' ? 'arrow_upward' : 'arrow_downward';
            icon.classList.add('active');
        } else {
            icon.textContent = 'unfold_more';
            icon.classList.remove('active');
        }
    });

    // Pagination
    const totalItems = filtered.length;
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    const startIdx = currentTablePage * itemsPerPage;
    const pagedData = filtered.slice(startIdx, startIdx + itemsPerPage);

    // Update table info text
    const counterEleTop = document.getElementById('tableCountInfo');
    if (counterEleTop) {
        counterEleTop.textContent = `Hiển thị ${pagedData.length} trên ${totalItems} kết quả (Tổng hệ thống: ${window.allOrdersData.length} | Trang ${currentTablePage + 1}/${totalPages || 1})`;
    }

    if (pagedData.length === 0) {
        tbodyFull.innerHTML = `<tr><td colspan="16" class="px-6 py-12 text-center text-slate-400 font-medium bg-slate-50/50">Không tìm thấy đơn hàng nào khớp với bộ lọc.</td></tr>`;
        updatePaginationUI(0);
        return;
    }

    let fullHtml = '';
    pagedData.forEach((data) => {
        const initials = (data.requester || 'NV').split(' ').map(x => x[0]).join('').toUpperCase().substring(0, 2);
        
        // Custom dates rendering
        const orderText = formatDateDisplay(data.orderDate || data.createdAt);
        const deployText = formatDateDisplay(data.deployDate);
        const deadlineText = formatDateDisplay(data.deadline);

        const currentStatus = (window.orderStatusesData || []).find(s => s.name === data.status);
        const badgeClasses = currentStatus ? currentStatus.color : 'bg-slate-100 text-slate-600 border-slate-200';
        const statusBadgeFull = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${badgeClasses} uppercase tracking-wider shadow-sm">${data.status || 'Chờ duyệt'}</span>`;
        
        const dataStr = encodeURIComponent(JSON.stringify({
            id: data.id, 
            code: data.code, 
            status: data.status, 
            title: data.title, 
            requester: data.requester, 
            department: data.department, 
            deadline: data.deadline, 
            deployDate: data.deployDate,
            orderDate: data.orderDate || data.createdAt,
            content: data.content,
            category: data.category,
            stylist: data.stylist,
            assignedVideo: data.assignedVideo,
            assignedPhoto: data.assignedPhoto,
            assignedDesign: data.assignedDesign,
            costs: data.costs || {},
            totalCost: data.totalCost || 0,
            note: data.note || ''
        })).replace(/'/g, '%27');

        // Function to get user badge
        const getUserBadge = (name) => {
            if (!name || name === '-') return '<span class="text-slate-400">-</span>';
            const u = (window.allUsersData || []).find(x => x.name === name);
            const roleClass = u ? `badge-${u.role}` : 'badge-default';
            return `<span class="name-badge ${roleClass} cursor-help" 
                onmouseenter="window.showUserTooltip(event, '${name}')" 
                onmouseleave="window.hidePremiumTooltip()">${name}</span>`;
        };

        // Function to get row background color based on status
        const getRowBgClass = (status) => {
            const s = String(status || '').toLowerCase();
            if (s.includes('hoàn thành')) return 'bg-emerald-50/30 hover:bg-emerald-50/60';
            if (s.includes('đang xử lý') || s.includes('triển khai')) return 'bg-blue-50/30 hover:bg-blue-50/60';
            if (s.includes('chờ duyệt') || s.includes('tạm dừng')) return 'bg-amber-50/30 hover:bg-amber-50/60';
            if (s.includes('hủy')) return 'bg-rose-50/30 hover:bg-rose-50/60';
            return 'bg-white hover:bg-slate-50/80';
        };

        const rowBgClass = getRowBgClass(data.status);
        
        fullHtml += `
                <tr data-order-id="${data.id}" class="${rowBgClass} transition-colors group relative border-b border-slate-100/50">
                    <td class="font-headline font-bold text-[13px] text-primary col-code pl-4 cursor-pointer hover:underline decoration-2 underline-offset-4" onclick="openHistoryDrawer('${data.id}', '${data.code}')">
                        <div class="flex items-center gap-1.5">
                            <span class="material-symbols-outlined text-[14px] opacity-0 group-hover:opacity-100 transition-opacity">history</span>
                            ${data.code || '-'}
                        </div>
                    </td>
                    <td class="${checkPermission('requester') ? 'cursor-pointer hover:bg-slate-100/50' : 'cursor-default'} transition-all" ${checkPermission('requester') ? `onclick="startInlineEdit(this, '${dataStr}', 'requester')"` : ''}>
                        <div class="display-val flex items-center gap-2">
                            <div class="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-[10px]">${initials}</div>
                            <div class="text-[13px] font-semibold text-on-surface">${getUserBadge(data.requester)}</div>
                        </div>
                    </td>
                    <td class="text-[12px] font-medium text-slate-500 ${checkPermission('department') ? 'cursor-pointer hover:bg-slate-100/50' : 'cursor-default'} transition-all" ${checkPermission('department') ? `onclick="startInlineEdit(this, '${dataStr}', 'department')"` : ''}>
                        <span class="display-val">${data.department || '-'}</span>
                    </td>
                    <td class="text-[12px] font-semibold text-slate-600 ${checkPermission('category') ? 'cursor-pointer hover:bg-slate-100/50' : 'cursor-default'} transition-all" ${checkPermission('category') ? `onclick="startInlineEdit(this, '${dataStr}', 'category')"` : ''}>
                        <span class="display-val">${getCategoryBadge(data.category)}</span>
                    </td>
                    <td class="max-w-[200px] ${checkPermission('title') ? 'cursor-pointer hover:bg-slate-100/50' : 'cursor-default'} transition-all" 
                        ${checkPermission('title') ? `onclick="openEditModal('${dataStr}')"` : ''}
                        onmouseenter="window.showPremiumTooltip(event, '${safeEncodeForAttr(data.title || '-')}', '${safeEncodeForAttr(data.content || '-')}')"
                        onmouseleave="window.hidePremiumTooltip()">
                        <div class="display-val">
                            <div class="text-[13px] font-bold text-slate-700 truncate">${safeAttr(data.title || '-')}</div>
                            <div class="text-[11px] font-normal text-slate-500 truncate mt-0.5">${safeAttr((data.content || '').replace(/<[^>]*>/g, ' '))}</div>
                        </div>
                    </td>
                    <td class="text-[12px] text-slate-500 italic ${checkPermission('note') ? 'cursor-pointer hover:bg-slate-100/50' : 'cursor-default'} transition-all" ${checkPermission('note') ? `onclick="startInlineEdit(this, '${dataStr}', 'note')"` : ''}>
                        <span class="display-val truncate max-w-[150px] inline-block">${safeAttr(data.note || '-')}</span>
                    </td>
                    <td class="text-[11px] text-slate-500 font-bold cursor-pointer hover:bg-slate-100/50 transition-all" onclick="startInlineEdit(this, '${dataStr}', 'orderDate')">
                        <div class="display-val">${orderText}</div>
                    </td>
                    <td class="text-[11px] text-slate-500 font-bold ${checkPermission('deployDate') ? 'cursor-pointer hover:bg-slate-100/50' : 'cursor-default'} transition-all" ${checkPermission('deployDate') ? `onclick="startInlineEdit(this, '${dataStr}', 'deployDate')"` : ''}>
                        <div class="display-val">${deployText}</div>
                    </td>
                    <td class="text-[12px] font-bold text-primary cursor-pointer hover:bg-slate-100/50 transition-all" onclick="startInlineEdit(this, '${dataStr}', 'deadline')">
                        <div class="display-val">${deadlineText}</div>
                    </td>
                    <td class="${checkPermission('status') ? 'cursor-pointer hover:bg-slate-100/50' : 'cursor-default'} transition-all" ${checkPermission('status') ? `onclick="startInlineEdit(this, '${dataStr}', 'status')"` : ''}>
                        <div class="display-val">${statusBadgeFull}</div>
                    </td>
                    <td class="${checkPermission('costs') ? 'cursor-pointer hover:bg-slate-100/50' : 'cursor-default'} text-[12px] font-bold text-emerald-600 transition-all text-right pr-4" onclick="${checkPermission('costs') ? `openCostModal('${dataStr}')` : ''}">
                        <span class="display-val">${window.formatCurrency(data.totalCost || 0)}</span>
                    </td>
                    <td class="text-[12px] font-medium text-slate-600 ${checkPermission('stylist') ? 'cursor-pointer hover:bg-slate-100/50' : 'cursor-default'} transition-all" ${checkPermission('stylist') ? `onclick="startInlineEdit(this, '${dataStr}', 'stylist')"` : ''}>
                        <div class="display-val">${getUserBadge(data.stylist)}</div>
                    </td>
                    <td class="text-[12px] font-medium text-slate-600 ${checkPermission('assignedVideo') ? 'cursor-pointer hover:bg-slate-100/50' : 'cursor-default'} transition-all" ${checkPermission('assignedVideo') ? `onclick="startInlineEdit(this, '${dataStr}', 'assignedVideo')"` : ''}>
                        <div class="display-val">${getUserBadge(data.assignedVideo)}</div>
                    </td>
                    <td class="text-[12px] font-medium text-slate-600 ${checkPermission('assignedPhoto') ? 'cursor-pointer hover:bg-slate-100/50' : 'cursor-default'} transition-all" ${checkPermission('assignedPhoto') ? `onclick="startInlineEdit(this, '${dataStr}', 'assignedPhoto')"` : ''}>
                        <div class="display-val">${getUserBadge(data.assignedPhoto)}</div>
                    </td>
                    <td class="text-[12px] font-medium text-slate-600 ${checkPermission('assignedDesign') ? 'cursor-pointer hover:bg-slate-100/50' : 'cursor-default'} transition-all" ${checkPermission('assignedDesign') ? `onclick="startInlineEdit(this, '${dataStr}', 'assignedDesign')"` : ''}>
                        <div class="display-val">${getUserBadge(data.assignedDesign)}</div>
                    </td>
                    <td class="text-right">
                        <div class="flex items-center justify-end gap-1">
                            ${checkPermission('orders_edit_any') ? `<button onclick="openEditModal('${dataStr}')" class="p-1.5 hover:bg-slate-100 rounded-full hover:text-primary transition-all"><span class="material-symbols-outlined text-[18px]">edit</span></button>` : ''}
                            ${checkPermission('delete') ? `<button onclick="deleteOrder('${data.id}', '${data.code}')" class="p-1.5 hover:bg-red-50 rounded-full hover:text-red-600 transition-all"><span class="material-symbols-outlined text-[18px]">delete</span></button>` : ''}
                        </div>
                    </td>
                </tr>`;
    });
    tbodyFull.innerHTML = fullHtml;
    updatePaginationUI(totalPages);
};

function updatePaginationUI(totalPages) {
    const container = document.querySelector('.p-4.md\\:p-6.border-t.border-slate-100');
    if (!container) return;

    if (totalPages <= 1) {
        container.innerHTML = `<div class="text-xs text-slate-400 font-medium tracking-wide w-full text-center">Đang hiển thị trang duy nhất</div>`;
        return;
    }

    let html = `<div class="flex items-center justify-between w-full">
        <div class="text-xs font-bold text-slate-500 uppercase tracking-widest">Trang ${currentTablePage + 1} / ${totalPages}</div>
        <div class="flex gap-1.5">
            <button onclick="changePage(${currentTablePage - 1})" class="pagination-btn" ${currentTablePage === 0 ? 'disabled' : ''}>Trước</button>`;
    
    let startPage = Math.max(0, currentTablePage - 2);
    let endPage = Math.min(totalPages, startPage + 5);
    if (endPage === totalPages) startPage = Math.max(0, endPage - 5);

    for (let i = startPage; i < endPage; i++) {
        html += `<button onclick="changePage(${i})" class="pagination-btn ${i === currentTablePage ? 'active' : ''}">${i + 1}</button>`;
    }

    html += `<button onclick="changePage(${currentTablePage + 1})" class="pagination-btn" ${currentTablePage === totalPages - 1 ? 'disabled' : ''}>Sau</button>
        </div>
    </div>`;
    container.innerHTML = html;
}

window.changePage = function(p) {
    currentTablePage = p;
    window.renderOrdersTable();
    document.getElementById('mainOrdersTable').scrollIntoView({ behavior: 'smooth' });
};

window.renderDashboardTable = function() {
    const tbodyDash = document.getElementById('dashboardOrdersTableBody');
    if (!tbodyDash) return;
    
    const allOrders = window.allOrdersData || [];
    
    // --- Calculate Stats ---
    const total = allOrders.length;
    const completed = allOrders.filter(o => o.status === 'Hoàn thành').length;
    const cancelled = allOrders.filter(o => o.status === 'Hủy').length;
    const pending = total - completed - cancelled;
    
    // Update Stats UI
    if (document.getElementById('dash-total-orders')) document.getElementById('dash-total-orders').textContent = total.toLocaleString();
    if (document.getElementById('dash-pending-orders')) document.getElementById('dash-pending-orders').textContent = pending.toLocaleString();
    if (document.getElementById('dash-completed-orders')) document.getElementById('dash-completed-orders').textContent = completed.toLocaleString();
    
    // Deadline Rate (Real calculation based on completion time vs deadline)
    if (document.getElementById('dash-deadline-rate')) {
        const completedOrders = allOrders.filter(o => o.status === 'Hoàn thành');
        const onTimeOrders = completedOrders.filter(o => {
            if (!o.deadline) return true;
            const deadline = new Date(o.deadline);
            const updated = o.updatedAt ? (o.updatedAt.toDate ? o.updatedAt.toDate() : new Date(o.updatedAt)) : new Date();
            return updated <= deadline;
        });
        const rate = completedOrders.length > 0 ? Math.round((onTimeOrders.length / completedOrders.length) * 100) : 0;
        document.getElementById('dash-deadline-rate').textContent = completedOrders.length > 0 ? (rate > 90 ? 'Tuyệt vời' : rate + '%') : '--';
    }

    // --- Material Distribution ---
    if (document.getElementById('dash-material-total')) {
        document.getElementById('dash-material-total').textContent = total >= 1000 ? (total/1000).toFixed(1) + 'K' : total;
    }
    
    const categories = {};
    allOrders.forEach(o => {
        const cat = o.category && o.category !== '-' ? o.category : 'Khác';
        categories[cat] = (categories[cat] || 0) + 1;
    });
    
    const dashMaterialList = document.getElementById('dash-material-list');
    if (dashMaterialList) {
        let materialHtml = '';
        const sortedCats = Object.entries(categories).sort((a,b) => b[1] - a[1]);
        
        sortedCats.forEach(([cat, count]) => {
            const percent = total > 0 ? Math.round((count / total) * 100) : 0;
            let icon = 'category';
            const lowerCat = cat.toLowerCase();
            if(lowerCat.includes('video')) icon = 'movie';
            else if(lowerCat.includes('hình ảnh') || lowerCat.includes('photo')) icon = 'image';
            else if(lowerCat.includes('design') || lowerCat.includes('thiết kế')) icon = 'draw';
            else if(lowerCat.includes('khác')) icon = 'more_horiz';

            materialHtml += `
            <div class="flex justify-between items-center bg-white/10 p-3 rounded-lg backdrop-blur-sm mb-3 last:mb-0">
                <div class="flex items-center gap-3">
                    <span class="material-symbols-outlined">${icon}</span>
                    <span class="font-semibold text-sm">${cat}</span>
                </div>
                <span class="font-headline font-bold">${percent}% <span class="text-[10px] font-normal opacity-60 ml-1">(${count})</span></span>
            </div>
            `;
        });
        dashMaterialList.innerHTML = materialHtml;
    }

    // --- Weekly Orders Chart ---
    const now = new Date();
    const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1; // 0 = Monday
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - dayOfWeek);
    startOfWeek.setHours(0,0,0,0);
    
    const weekCountsTotal = [0, 0, 0, 0, 0, 0, 0];
    const weekCountsCompleted = [0, 0, 0, 0, 0, 0, 0];
    
    allOrders.forEach(o => {
        const dateStr = o.createdAt?.seconds ? new Date(o.createdAt.seconds * 1000) : new Date(o.createdAt);
        if (dateStr >= startOfWeek) {
            const diffTime = dateStr.getTime() - startOfWeek.getTime();
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            if (diffDays >= 0 && diffDays <= 6) {
                weekCountsTotal[diffDays]++;
                if (o.status === 'Hoàn thành') {
                    weekCountsCompleted[diffDays]++;
                }
            }
        }
    });
    
    const maxCount = Math.max(...weekCountsTotal, 1);
    const chartDays = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
    const chartContainer = document.getElementById('dash-weekly-chart');
    
    if (chartContainer) {
        let chartHtml = '';
        weekCountsTotal.forEach((totalCount, idx) => {
            const compCount = weekCountsCompleted[idx];
            const heightTotal = Math.round((totalCount / maxCount) * 100);
            const heightComp = Math.round((compCount / maxCount) * 100);
            const isToday = idx === dayOfWeek;
            
            chartHtml += `
            <div class="flex flex-col items-center flex-1">
                <div class="w-full bg-slate-100 rounded-t-lg relative group h-40" title="Tổng: ${totalCount} | Xong: ${compCount}">
                    <div class="absolute bottom-0 w-full bg-primary/20 rounded-t-lg transition-all group-hover:bg-primary/30" style="height: ${heightTotal}%"></div>
                    <div class="absolute bottom-0 w-full ${isToday ? 'bg-primary-container shadow-lg' : 'bg-primary/60'} rounded-t-lg transition-all group-hover:bg-primary" style="height: ${heightComp}%"></div>
                </div>
                <span class="mt-3 text-xs ${isToday ? 'font-bold text-on-surface' : 'font-semibold text-on-surface-variant'}">${chartDays[idx]}</span>
            </div>
            `;
        });
        chartContainer.innerHTML = chartHtml;
    }

    // --- Render Latest Orders Table ---
    if (allOrders.length === 0) {
        tbodyDash.innerHTML = '<tr><td colspan="4" class="px-6 py-8 text-center text-slate-400">Chưa có đơn hàng nào trực tuyến.</td></tr>';
        return;
    }
    
    let dashHtml = '';
    // Sort by createdAt desc and take top 5
    const latestOrders = [...allOrders].sort((a, b) => {
        const dateA = a.createdAt?.seconds ? a.createdAt.seconds : new Date(a.createdAt).getTime();
        const dateB = b.createdAt?.seconds ? b.createdAt.seconds : new Date(b.createdAt).getTime();
        return dateB - dateA;
    }).slice(0, 10);

    latestOrders.forEach((data) => {
        const currentStatus = (window.orderStatusesData || []).find(s => s.name === data.status);
        const badgeClasses = currentStatus ? currentStatus.color : 'bg-surface-container-highest text-on-secondary-container';
        const statusBadgeDash = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${badgeClasses} uppercase">${data.status || 'Chờ duyệt'}</span>`;
        
        const orderDateStr = data.createdAt ? (data.createdAt.seconds ? new Date(data.createdAt.seconds * 1000).toLocaleDateString('vi-VN') : new Date(data.createdAt).toLocaleDateString('vi-VN')) : '-';

        dashHtml += `
            <tr class="hover:bg-surface-container-low transition-colors cursor-pointer" onclick="navigateTo('orders')">
                <td class="py-4 font-mono font-semibold text-primary text-sm hover:underline cursor-pointer" onclick="event.stopPropagation(); window.openHistoryDrawer('${data.id}', '${data.code}')">${data.code || '-'}</td>
                <td class="py-4 text-xs font-medium text-slate-500">${orderDateStr}</td>
                <td class="py-4 font-medium text-sm text-slate-700">${data.requester || '-'}</td>
                <td class="py-4 text-sm text-slate-600">${data.category || '-'}</td>
                <td class="py-4 text-on-surface-variant text-[13px] font-bold truncate max-w-[200px]">${data.title || '-'}</td>
                <td class="py-4 text-right">${statusBadgeDash}</td>
            </tr>`;
    });
    tbodyDash.innerHTML = dashHtml;
    
    // Also update recent activity if on dashboard
    if (window.renderRecentActivity) window.renderRecentActivity();
};

window.logActivity = async function(type, title, description, orderId = null, orderCode = null) {
    if (!db) return;
    try {
        const user = localStorage.getItem('nevo_user') || 'Hệ thống';
        await addDoc(collection(db, "activities"), {
            type: type, // 'create', 'update', 'delete', 'system'
            title: title,
            description: description,
            user: user,
            orderId: orderId,
            orderCode: orderCode,
            createdAt: serverTimestamp()
        });
    } catch (e) {
        console.error("Error logging activity:", e);
    }
};

window.renderRecentActivity = function() {
    const container = document.getElementById('dashboardRecentActivity');
    if (!container) return;
    
    const activities = window.allActivitiesData || [];
    if (activities.length === 0) {
        container.innerHTML = '<p class="text-center text-slate-400 text-xs py-4 italic">Chưa có hoạt động nào được ghi lại.</p>';
        return;
    }

    const timeSince = (date) => {
        if (!date) return 'Vừa xong';
        const seconds = Math.floor((new Date() - (date.toDate ? date.toDate() : new Date(date))) / 1000);
        if (seconds < 60) return 'Vừa xong';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + ' phút trước';
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + ' giờ trước';
        const days = Math.floor(hours / 24);
        return days + ' ngày trước';
    };

    const getIconClass = (type) => {
        switch(type) {
            case 'create': return 'bg-primary';
            case 'update': return 'bg-secondary';
            case 'delete': return 'bg-error';
            default: return 'bg-tertiary';
        }
    };

    let html = '';
    activities.slice(0, 10).forEach(act => {
        const iconClass = getIconClass(act.type);
        html += `
            <div class="flex gap-4 group">
                <div class="mt-1 w-2 h-2 rounded-full ${iconClass} flex-shrink-0"></div>
                <div>
                    <p class="text-sm font-semibold group-hover:text-primary transition-colors cursor-pointer" onclick="${act.orderId ? `window.openHistoryDrawer('${act.orderId}', '${act.orderCode}')` : ''}">${act.title}</p>
                    <p class="text-xs text-on-surface-variant mb-1">${act.description}</p>
                    <div class="flex items-center gap-2">
                        <span class="text-[10px] font-bold text-slate-400">${timeSince(act.createdAt)}</span>
                        <span class="text-[10px] font-medium text-slate-300">•</span>
                        <span class="text-[10px] font-bold text-slate-400">${act.user}</span>
                    </div>
                </div>
            </div>`;
    });
    container.innerHTML = html;
};

window.updateDashboardStats = window.renderDashboardTable;

window.deleteOrder = async function(id, code) {
    if (!checkPermission('delete')) {
        showToast('Từ chối!', 'Bạn không có quyền xóa đơn hàng.', 'block', 'error');
        return;
    }
    if (confirm('Bạn có chắc chắn muốn xóa đơn hàng ' + code + ' không? Thao tác này không thể hoàn tác.')) {
        try {
            await deleteDoc(doc(db, "orders", id));
            showToast('Thành công!', 'Đã xóa đơn hàng ' + code + '.', 'delete', 'error');
            
            // LOG ACTIVITY
            if (window.logActivity) {
                window.logActivity('delete', `Xóa đơn hàng ${code}`, `Đơn hàng ${code} đã bị xóa khỏi hệ thống.`);
            }
        } catch (error) {
            console.error("Lỗi xóa đơn:", error);
            showToast('Lỗi!', 'Không thể xóa đơn hàng.', 'error', 'error');
        }
    }
};

window.openEditModal = async function(dataStr) {
    if (!checkPermission('orders_edit_any')) {
        showToast('Từ chối!', 'Bạn không có quyền chỉnh sửa đơn hàng.', 'block', 'error');
        return;
    }
    const data = JSON.parse(decodeURIComponent(dataStr));
    
    document.getElementById('editOrderId').value = data.id;
    document.getElementById('editOrderCode').value = data.code || '';
    document.getElementById('editModalHeaderId').textContent = data.code || ('#' + data.id.substring(0,8));
    document.getElementById('editOrderStatus').value = data.status || 'Chờ duyệt';
    document.getElementById('editOrderTitle').value = data.title || '';
    document.getElementById('editOrderRequester').value = data.requester || '';
    document.getElementById('editOrderDeadline').value = data.deadline || '';
    document.getElementById('editOrderDeployDate').value = data.deployDate || '';
    
    let allowedEditCats = window.orderCategoriesData ? [...window.orderCategoriesData] : [];
    if (typeof window.checkOrderWindowOpen === 'function') {
        const result = await window.checkOrderWindowOpen();
        if (result && !result.allowed) {
            allowedEditCats = [];
        } else if (result && result.openCategories && !result.openCategories.includes('all')) {
            allowedEditCats = allowedEditCats.filter(c => result.openCategories.includes(c.name) || c.name === data.category);
        }
    }
    if (data.category && !allowedEditCats.some(c => c.name === data.category)) {
        allowedEditCats.push({ name: data.category });
    }
    populateDropdown('editOrderCategory', allowedEditCats, '- Chọn thể loại -');
    
    document.getElementById('editOrderCategory').value = data.category || 'Video';
    document.getElementById('editOrderStylist').value = data.stylist || '';
    document.getElementById('editOrderVideo').value = data.assignedVideo || '';
    document.getElementById('editOrderPhoto').value = data.assignedPhoto || '';
    document.getElementById('editOrderDesign').value = data.assignedDesign || '';
    document.getElementById('editOrderContent').innerHTML = data.content || '';
    document.getElementById('editOrderNote').value = data.note || '';
    document.getElementById('editOrderDepartment').value = data.department || 'Công nghệ Thông tin';

    // Load Total Cost Display
    const totalCost = data.totalCost || 0;
    const totalCostValueEl = document.getElementById('editOrderTotalCostValue');
    if (totalCostValueEl) {
        totalCostValueEl.textContent = window.formatCurrency(totalCost);
    }
    
    // Setup click handler to open the existing Cost Modal (Admin Only)
    const costDisplayEl = document.getElementById('editOrderTotalCostDisplay');
    const canEditCosts = checkPermission('costs');
    if (costDisplayEl) {
        const adjustBtn = costDisplayEl.querySelector('.flex.items-center.gap-2');
        if (canEditCosts) {
            const dataStrEncoded = encodeURIComponent(JSON.stringify(data));
            costDisplayEl.onclick = () => window.openCostModal(dataStrEncoded);
            costDisplayEl.classList.add('cursor-pointer', 'hover:bg-emerald-100');
            costDisplayEl.classList.remove('cursor-default');
            if (adjustBtn) adjustBtn.classList.remove('hidden');
        } else {
            costDisplayEl.onclick = null;
            costDisplayEl.classList.remove('cursor-pointer', 'hover:bg-emerald-100');
            costDisplayEl.classList.add('cursor-default');
            if (adjustBtn) adjustBtn.classList.add('hidden');
        }
    }
    
    // RBAC: Disable fields if not permitted
    const fieldsToProtect = [
        { id: 'editOrderStatus', field: 'status' },
        { id: 'editOrderDeployDate', field: 'deployDate' },
        { id: 'editOrderCategory', field: 'category' },
        { id: 'editOrderDepartment', field: 'department' },
        { id: 'editOrderStylist', field: 'stylist' },
        { id: 'editOrderVideo', field: 'assignedVideo' },
        { id: 'editOrderPhoto', field: 'assignedPhoto' },
        { id: 'editOrderDesign', field: 'assignedDesign' },
        { id: 'editOrderNote', field: 'note' },
        { id: 'editOrderTitle', field: 'title' },
        { id: 'editOrderRequester', field: 'requester' },
        { id: 'editOrderDeadline', field: 'deadline' }
    ];

    fieldsToProtect.forEach(item => {
        const el = document.getElementById(item.id);
        if (el) {
            if (!checkPermission(item.field)) {
                el.disabled = true;
                el.classList.add('bg-slate-50', 'opacity-70', 'cursor-not-allowed');
            } else {
                el.disabled = false;
                el.classList.remove('bg-slate-50', 'opacity-70', 'cursor-not-allowed');
            }
        }
    });

    const modal = document.getElementById('editOrderModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

window.toggleExtraFields = function() {
    const content = document.getElementById('extraFieldsContent');
    const icon = document.getElementById('extraFieldsIcon');
    if (content.classList.contains('hidden')) {
        content.classList.remove('hidden');
        icon.style.transform = 'rotate(180deg)';
    } else {
        content.classList.add('hidden');
        icon.style.transform = 'rotate(0deg)';
    }
};

window.closeEditModal = function() {
    const modal = document.getElementById('editOrderModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
};

window.openCostModal = function(dataStr) {
    const data = JSON.parse(decodeURIComponent(dataStr));
    const currentData = window.allOrdersData.find(o => o.id === data.id) || data;
    
    document.getElementById('costOrderId').value = currentData.id;
    document.getElementById('costOrderCode').textContent = `ORDER: ${currentData.code || currentData.id.substring(0,8)}`;
    
    const costs = currentData.costs || {};
    const fields = ['model', 'makeup', 'studio', 'travel', 'video', 'photo', 'stylist', 'assistant', 'other'];
    
    fields.forEach(f => {
        const input = document.getElementById(`cost-${f}`);
        if (input) input.value = costs[f] || 0;
    });
    
    const noteInput = document.getElementById('cost-note');
    if (noteInput) noteInput.value = costs.note || '';
    
    window.calculateTotalCost();
    
    const modal = document.getElementById('costModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.classList.add('open');
};

window.calculateTotalCost = function() {
    const fields = ['model', 'makeup', 'studio', 'travel', 'video', 'photo', 'stylist', 'assistant', 'other'];
    let total = 0;
    fields.forEach(f => {
        const val = document.getElementById(`cost-${f}`).value;
        total += Number(val || 0);
    });
    const display = document.getElementById('costTotalDisplay');
    if (display) display.textContent = total.toLocaleString('vi-VN');
    return total;
};

window.closeCostModal = function() {
    const modal = document.getElementById('costModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modal.classList.remove('open');
};

window.saveCostDetails = async function() {
    if (!checkPermission('costs')) {
        showToast('Từ chối!', 'Bạn không có quyền lưu chi phí.', 'block', 'error');
        return;
    }
    const id = document.getElementById('costOrderId').value;
    const fields = ['model', 'makeup', 'studio', 'travel', 'video', 'photo', 'stylist', 'assistant', 'other'];
    const costs = {};
    let total = 0;
    
    fields.forEach(f => {
        const val = Number(document.getElementById(`cost-${f}`).value || 0);
        costs[f] = val;
        total += val;
    });
    costs.note = document.getElementById('cost-note').value;
    
    const btn = document.getElementById('saveCostBtn');
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-outlined text-[20px] animate-spin">progress_activity</span> Đang lưu...';
    btn.disabled = true;
    
    try {
        await window.updateOrderWithHistory(id, {
            costs: costs,
            totalCost: total
        });
        showToast('Thành công!', 'Đã cập nhật chi phí đơn hàng.', 'payments', 'success');
        window.closeCostModal();
    } catch (error) {
        console.error("Lỗi lưu chi phí:", error);
        showToast('Lỗi!', 'Không thể lưu thông tin chi phí.', 'error', 'error');
    } finally {
        btn.innerHTML = originalHtml;
        btn.disabled = false;
    }
};

window.saveEditOrder = async function() {
    if (!checkPermission('orders_edit_any')) {
        showToast('Từ chối!', 'Bạn không có quyền lưu chỉnh sửa.', 'block', 'error');
        return;
    }
    const id = document.getElementById('editOrderId').value;
    const code = document.getElementById('editOrderCode').value;
    const status = document.getElementById('editOrderStatus').value;
    const title = document.getElementById('editOrderTitle').value;
    const requester = document.getElementById('editOrderRequester').value;
    const deadline = document.getElementById('editOrderDeadline').value;
    const deployDate = document.getElementById('editOrderDeployDate').value;
    const category = document.getElementById('editOrderCategory').value;
    const stylist = document.getElementById('editOrderStylist').value;
    const assignedVideo = document.getElementById('editOrderVideo').value;
    const assignedPhoto = document.getElementById('editOrderPhoto').value;
    const assignedDesign = document.getElementById('editOrderDesign').value;
    const department = document.getElementById('editOrderDepartment').value;
    const note = document.getElementById('editOrderNote').value;
    const content = document.getElementById('editOrderContent').innerHTML;

    if (!title || !requester || !deadline) {
        showToast('Lỗi!', 'Vui lòng điền đủ các trường bắt buộc.', 'error', 'error');
        return;
    }

    const btn = document.getElementById('btnSaveEditOrder');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>...';
    btn.disabled = true;

    try {
        await window.updateOrderWithHistory(id, {
            status: status,
            title: title,
            requester: requester,
            deadline: deadline,
            deployDate: deployDate,
            category: category,
            stylist: stylist,
            assignedVideo: assignedVideo,
            assignedPhoto: assignedPhoto,
            assignedDesign: assignedDesign,
            department: department,
            note: note,
            content: content
        });
        
        btn.innerHTML = originalText;
        btn.disabled = false;
        window.closeEditModal();
        showToast('Thành công!', 'Đã cập nhật dữ liệu đơn ' + code + '.', 'check_circle', 'success');
        
        // LOG ACTIVITY
        if (window.logActivity) {
            window.logActivity('update', `Cập nhật đơn hàng ${code}`, `Thông tin đơn hàng ${code} đã được cập nhật qua bảng chỉnh sửa.`);
        }
    } catch (error) {
        console.error("Lỗi cập nhật:", error);
        btn.innerHTML = originalText;
        btn.disabled = false;
        showToast('Lỗi!', 'Không thể cập nhật đơn hàng.', 'error', 'error');
    }
};

// ===== Inline Edit =====
window.startInlineEdit = async function(element, dataStr, field) {
    if (element.classList.contains('editing')) return;

    // RBAC Check
    if (!checkPermission(field)) {
        showToast('Từ chối!', 'Bạn không có quyền chỉnh sửa nhanh trường này.', 'block', 'error');
        return;
    }
    
    // Prevent editing if multiple elements clicked too fast
    if (document.querySelector('.editing')) {
        const currentEdit = document.querySelector('.editing');
        if (currentEdit !== element) window.saveInlineEdit(currentEdit, currentEdit.dataset.id, currentEdit.dataset.field, currentEdit.querySelector('.inline-input')?.value, currentEdit.dataset.original);
    }
    
    element.classList.add('editing', 'relative');
    const data = JSON.parse(decodeURIComponent(dataStr));
    const originalVal = data[field] || '';
    const id = data.id;
    
    element.dataset.id = id;
    element.dataset.field = field;
    element.dataset.original = originalVal;
    
    const safeVal = originalVal.replace(/"/g, '&quot;');
    
    let inputHtml = '';
    const commonSelectClass = "bg-white border-2 border-primary rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-4 focus:ring-primary/20 inline-input shadow-xl text-slate-700 absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[90%] min-w-[120px] max-w-full cursor-pointer transition-all";
    const commonInputClass = "bg-white border-2 border-primary rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-4 focus:ring-primary/20 inline-input shadow-xl text-slate-700 absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[90%] min-w-[120px] max-w-full transition-all";

    if (field === 'status') {
        let optionsHtml = '';
        (window.orderStatusesData || []).forEach(s => {
            optionsHtml += `<option value="${s.name}" ${originalVal === s.name ? 'selected' : ''}>${s.name}</option>`;
        });
        inputHtml = `<select class="${commonSelectClass} font-bold text-primary" onchange="this.blur()" onblur="saveInlineEdit(this.closest('.editing'), '${id}', '${field}', this.value, '${safeVal}')">
            ${optionsHtml}
        </select>`;
    } else if (field === 'department') {
        let optionsHtml = '';
        (window.departmentsData || []).forEach(d => {
            optionsHtml += `<option value="${d.name}" ${originalVal === d.name ? 'selected' : ''}>${d.name}</option>`;
        });
        inputHtml = `<select class="${commonSelectClass}" onchange="this.blur()" onblur="saveInlineEdit(this.closest('.editing'), '${id}', '${field}', this.value, '${safeVal}')">
            ${optionsHtml}
        </select>`;
    } else if (field === 'category') {
        let optionsHtml = '';
        let allowedCats = window.orderCategoriesData ? [...window.orderCategoriesData] : [];
        if (typeof window.checkOrderWindowOpen === 'function') {
            const result = await window.checkOrderWindowOpen();
            if (result && !result.allowed) {
                allowedCats = [];
            } else if (result && result.openCategories && !result.openCategories.includes('all')) {
                allowedCats = allowedCats.filter(c => result.openCategories.includes(c.name) || c.name === originalVal);
            }
        }
        if (originalVal && !allowedCats.some(c => c.name === originalVal)) {
            allowedCats.push({ name: originalVal });
        }
        allowedCats.forEach(c => {
            const catName = c.name || c;
            optionsHtml += `<option value="${catName}" ${originalVal === catName ? 'selected' : ''}>${catName}</option>`;
        });
        inputHtml = `<select class="${commonSelectClass}" onchange="this.blur()" onblur="saveInlineEdit(this.closest('.editing'), '${id}', '${field}', this.value, '${safeVal}')">
            ${optionsHtml}
        </select>`;
    } else if (field === 'requester' || field === 'stylist' || field === 'assignedVideo' || field === 'assignedPhoto' || field === 'assignedDesign') {
        let optionsHtml = '<option value="-">-</option>';
        const sortedUsers = (window.allUsersData || []).sort((a,b) => a.name.localeCompare(b.name));
        
        const displayUsers = (field === 'requester') 
            ? sortedUsers 
            : sortedUsers.filter(u => u.dept === 'Creative');

        displayUsers.forEach(u => {
            optionsHtml += `<option value="${u.name}" ${originalVal === u.name ? 'selected' : ''}>${u.name}</option>`;
        });
        inputHtml = `<select class="${commonSelectClass} font-bold" onchange="this.blur()" onblur="saveInlineEdit(this.closest('.editing'), '${id}', '${field}', this.value, '${safeVal}')">
            ${optionsHtml}
        </select>`;
    } else if (field === 'deadline' || field === 'deployDate') {
        inputHtml = `<input type="date" class="${commonInputClass}" value="${originalVal}" onblur="saveInlineEdit(this.closest('.editing'), '${id}', '${field}', this.value, '${safeVal}')" />`;
    } else {
        inputHtml = `<input type="text" class="${commonInputClass} font-semibold" value="${safeVal}" onblur="saveInlineEdit(this.closest('.editing'), '${id}', '${field}', this.value, '${safeVal}')" onkeydown="if(event.key==='Enter') this.blur();" />`;
    }
    
    const displayEl = element.querySelector('.display-val');
    if(displayEl) displayEl.style.opacity = '0';
    
    element.insertAdjacentHTML('beforeend', inputHtml);
    const inputEl = element.querySelector('.inline-input');
    if(inputEl) {
        inputEl.focus();
        if(inputEl.type === 'text') {
            const len = inputEl.value.length;
            inputEl.setSelectionRange(len, len);
        } else if (inputEl.tagName === 'SELECT' && typeof inputEl.showPicker === 'function') {
            try { inputEl.showPicker(); } catch (e) {}
        }
    }
};

window.saveInlineEdit = async function(element, id, field, newVal, oldVal) {
    if (!element) return;
    
    element.classList.remove('editing', 'relative');
    const inputEl = element.querySelector('.inline-input');
    if(inputEl) inputEl.remove();
    const displayEl = element.querySelector('.display-val');
    
    if (newVal === oldVal || newVal === null || newVal === undefined) {
         if(displayEl) displayEl.style.opacity = '1';
         return;
    }
    
    if (!checkPermission(field)) {
        showToast('Từ chối!', 'Bạn không có quyền chỉnh sửa trường này.', 'block', 'error');
        if(displayEl) displayEl.style.opacity = '1';
        return;
    }

    if(displayEl) {
        displayEl.style.opacity = '0.5';
    }
    
    try {
        await window.updateOrderWithHistory(id, {
            [field]: newVal
        });
        showToast('Lưu tự động', 'Đã cập nhật', 'check_circle', 'success');
        
        // LOG ACTIVITY (All fields)
        if (window.logActivity) {
            const fieldLabels = { 
                'status': 'trạng thái', 
                'title': 'tiêu đề', 
                'requester': 'người yêu cầu',
                'department': 'phòng ban',
                'category': 'phân loại',
                'stylist': 'stylist',
                'assignedVideo': 'video',
                'assignedPhoto': 'photo',
                'assignedDesign': 'design',
                'deadline': 'hạn chót',
                'deployDate': 'ngày triển khai',
                'orderDate': 'ngày đơn hàng',
                'note': 'ghi chú',
                'content': 'nội dung'
            };
            const label = fieldLabels[field] || field;
            window.logActivity('update', `Cập nhật ${label}`, `Trường ${label} đã được thay đổi từ "${oldVal}" sang "${newVal}"`);
        }
    } catch (error) {
        showToast('Lỗi!', 'Không thể lưu thay đổi.', 'error', 'error');
        if(displayEl) displayEl.style.opacity = '1';
    }
};

window.showUserTooltip = function(e, name) {
    clearTimeout(window.tooltipTimeout);
    const tooltip = document.getElementById('premium-tooltip');
    if (!tooltip) return;
    
    const body = tooltip.querySelector('.tooltip-body');
    const u = (window.allUsersData || []).find(x => x.name === name);
    
    if (u) {
        body.innerHTML = `
            <div class="flex flex-col gap-3 font-sans">
                <div class="flex items-center gap-3">
                    <div class="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-black text-xs shadow-inner">
                        ${u.name.substring(0,2).toUpperCase()}
                    </div>
                    <div>
                        <p class="text-sm font-black text-slate-800 leading-tight">${u.name}</p>
                        <p class="text-[10px] font-bold text-primary/70 uppercase tracking-tighter">${u.dept || 'Phòng ban'}</p>
                    </div>
                </div>
                <div class="border-t border-slate-100 pt-3 flex flex-col gap-2">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                            <span class="material-symbols-outlined text-[24px]">badge</span>
                        </div>
                        <div>
                            <p class="text-[10px] uppercase font-extrabold text-slate-400 tracking-widest">Mã nhân viên</p>
                            <p class="text-sm font-bold text-slate-700">${u.empId || 'N/A'}</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-600">
                            <span class="material-symbols-outlined text-[24px]">call</span>
                        </div>
                        <div>
                            <p class="text-[10px] uppercase font-extrabold text-slate-400 tracking-widest">Số điện thoại</p>
                            <p class="text-sm font-bold text-slate-700">${u.phone || 'N/A'}</p>
                        </div>
                    </div>
                    <div class="mt-2 pt-3 border-t border-slate-100 flex items-center justify-between">
                        <span class="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Chức vụ</span>
                        <span class="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-bold text-slate-600 uppercase">${u.role || 'user'}</span>
                    </div>
                </div>
            </div>
        `;
    } else {
        body.innerHTML = `<p class="text-slate-400 italic py-2">Không tìm thấy thông tin thành viên này trong hệ thống.</p>`;
    }
    
    tooltip.classList.add('show');
    const targetElement = e.target ? e.target.closest('td') : null;
    if (targetElement) {
        window.updateTooltipPos(targetElement);
    }
};

window.hidePremiumTooltip = function() {
    window.tooltipTimeout = setTimeout(() => {
        const tooltip = document.getElementById('premium-tooltip');
        if (tooltip) tooltip.classList.remove('show');
    }, 100);
};

window.updateTooltipPos = function(element) {
    const tooltip = document.getElementById('premium-tooltip');
    if (!tooltip || !tooltip.classList.contains('show') || !element) return;
    
    const targetRect = element.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    
    // Default: Position to the right of the cell, shifted slightly right
    let finalX = targetRect.right + 15; 
    let finalY = targetRect.top;
    
    // If it goes off the right edge, flip to the left side
    if (finalX + tooltipRect.width > window.innerWidth - 20) {
        finalX = targetRect.left - tooltipRect.width - 15;
    }
    
    // If it goes off the bottom edge, push it up
    if (finalY + tooltipRect.height > window.innerHeight - 20) {
        finalY = window.innerHeight - tooltipRect.height - 20;
    }

    // Clamp to top
    if (finalY < 80) finalY = 80;
    
    tooltip.style.left = finalX + 'px';
    tooltip.style.top = finalY + 'px';
};

window.exportToExcel = function() {
    if (!window.currentFilteredOrders || window.currentFilteredOrders.length === 0) {
        alert("Không có dữ liệu để xuất.");
        return;
    }
    
    // Map data to Vietnamese columns
    const exportData = window.currentFilteredOrders.map(order => {
        return {
            "Mã đơn hàng": order.code || "-",
            "Người yêu cầu": order.requester || "-",
            "Phòng ban": order.department || "-",
            "Thể loại": order.category || "-",
            "Nội dung": order.title || "-",
            "Chi tiết nội dung": (order.content || "").replace(/<[^>]*>/g, ' '),
            "Ghi chú": order.note || "-",
            "Ngày order": formatDateDisplay(order.orderDate || order.createdAt),
            "Ngày triển khai": formatDateDisplay(order.deployDate),
            "Deadline": formatDateDisplay(order.deadline),
            "Trạng thái": order.status || "Chờ duyệt",
            "Stylist": order.stylist || "-",
            "Video": order.assignedVideo || "-",
            "Photo": order.assignedPhoto || "-",
            "Design": order.assignedDesign || "-",
            "Chi phí": order.totalCost || 0,
            "Ghi chú chi phí": (order.costs?.note || "-")
        };
    });

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    
    // Set column widths for better readability
    const colWidths = [
        { wch: 15 }, // Mã
        { wch: 20 }, // Người yêu cầu
        { wch: 20 }, // Phòng ban
        { wch: 15 }, // Thể loại
        { wch: 40 }, // Nội dung
        { wch: 50 }, // Chi tiết nội dung
        { wch: 30 }, // Ghi chú
        { wch: 15 }, // Ngày order
        { wch: 15 }, // Ngày triển khai
        { wch: 15 }, // Deadline
        { wch: 15 }, // Trạng thái
        { wch: 20 }, // Stylist
        { wch: 20 }, // Video
        { wch: 20 }, // Photo
        { wch: 15 }, // Chi phí
        { wch: 30 }  // Ghi chú chi phí
    ];
    worksheet['!cols'] = colWidths;

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Đơn hàng");
    XLSX.writeFile(workbook, `NevoTask_Orders_${new Date().toISOString().slice(0,10)}.xlsx`);
};

function populateDropdown(selectId, data, defaultText = null, defaultValue = "") {
    const select = document.getElementById(selectId);
    if (!select) return;
    const currentVal = select.value;
    let html = defaultText ? `<option value="${defaultValue}">${defaultText}</option>` : '';
    html += data.map(item => `<option value="${item.name}">${item.name}</option>`).join('');
    select.innerHTML = html;
    if (currentVal && data.some(d => d.name === currentVal)) {
        select.value = currentVal;
    }
}
window.populateDropdown = populateDropdown;

function populateMultiSelect(containerId, data, key) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    let html = `
        <div class="multi-select-item ${(!columnFilters[key] || columnFilters[key].length === 0) ? 'all-active' : ''}" id="all-${key}" onclick="toggleColumnFilter('${key}', 'ALL', true)">
            <span>Tất cả</span>
        </div>`;
        
    data.forEach(item => {
        const isChecked = columnFilters[key] && columnFilters[key].includes(item.name);
        html += `
            <div class="multi-select-item" onclick="var cb=this.querySelector('input'); cb.checked=!cb.checked; toggleColumnFilter('${key}', '${item.name}', cb.checked)">
                <input type="checkbox" ${isChecked ? 'checked' : ''} onclick="event.stopPropagation()" onchange="toggleColumnFilter('${key}', '${item.name}', this.checked)">
                <span>${item.name}</span>
            </div>`;
    });
    container.innerHTML = html;
}
window.populateMultiSelect = populateMultiSelect;

window.getStatusColor = function(status) {
    if (status === 'Hoàn thành') return 'bg-emerald-100 text-emerald-700';
    if (status === 'Hủy') return 'bg-rose-100 text-rose-700';
    if (status === 'Đang xử lý') return 'bg-blue-100 text-blue-700';
    return 'bg-amber-100 text-amber-700';
};

    window.initOrdersTracker = function() {
        if (!window.db) return;
        
        // --- 0. USERS SYNC ---
        const usersRef = window.fsCollection(window.db, "users");
        window.fsOnSnapshot(usersRef, (snapshot) => {
            window.allUsersData = [];
            snapshot.forEach(doc => window.allUsersData.push({ id: doc.id, ...doc.data() }));
            
            // Sync current user's profile changes to localStorage automatically
            const currentEmpId = localStorage.getItem('nevo_empId');
            if (currentEmpId) {
                const me = window.allUsersData.find(u => u.id === currentEmpId);
                if (me) {
                    if (me.dept && me.dept !== localStorage.getItem('nevo_dept')) {
                        localStorage.setItem('nevo_dept', me.dept);
                    }
                    if (me.role && me.role !== localStorage.getItem('nevo_role')) {
                        localStorage.setItem('nevo_role', me.role);
                    }
                    if (me.name && me.name !== localStorage.getItem('nevo_user')) {
                        localStorage.setItem('nevo_user', me.name);
                    }
                }
            }
            
            const staff = window.allUsersData.sort((a,b) => a.name.localeCompare(b.name));
            const creativeStaff = staff.filter(u => u.dept === 'Creative');

            // Multi-select staff
            populateMultiSelect('menu-requester', staff, 'requester');
            populateMultiSelect('menu-stylist', creativeStaff, 'stylist');
            populateMultiSelect('menu-assignedVideo', creativeStaff, 'assignedVideo');
            populateMultiSelect('menu-assignedPhoto', creativeStaff, 'assignedPhoto');
            populateMultiSelect('menu-assignedDesign', creativeStaff, 'assignedDesign');
            
            // Populate Edit Modal Personnel Dropdowns
            populateDropdown('editOrderStylist', creativeStaff, '- Chưa chọn -');
            populateDropdown('editOrderVideo', creativeStaff, '- Chưa chọn -');
            populateDropdown('editOrderPhoto', creativeStaff, '- Chưa chọn -');
            populateDropdown('editOrderDesign', creativeStaff, '- Chưa chọn -');
            
            // Populate Create Page Personnel Dropdowns
            populateDropdown('assignedStylist', creativeStaff, '- Chưa chọn -');
            populateDropdown('assignedVideo', creativeStaff, '- Chưa chọn -');
            populateDropdown('assignedPhoto', creativeStaff, '- Chưa chọn -');
            populateDropdown('assignedDesign', creativeStaff, '- Chưa chọn -');

            // Populate Schedule User Filter
            populateDropdown('scheduleUserFilter', staff, 'Tất cả thành viên', 'all');

            if (window.allOrdersData && window.allOrdersData.length > 0) window.renderOrdersTable();
        });

        // --- 1. DEPARTMENTS SYNC ---
        const deptsRef = window.fsCollection(window.db, "departments");
        const qDepts = window.fsQuery(deptsRef, window.fsOrderBy("name"));
        window.fsOnSnapshot(qDepts, (snapshot) => {
            window.departmentsData = [];
            snapshot.forEach(doc => window.departmentsData.push({ id: doc.id, ...doc.data() }));
            populateDropdown('department', window.departmentsData);
            populateDropdown('editOrderDepartment', window.departmentsData);
            populateDropdown('budgetFilterDept', window.departmentsData, 'Tất cả phòng ban', 'all');
            populateMultiSelect('menu-department', window.departmentsData, 'department');
            if (typeof window.updatePlanningDepartmentFilter === 'function') {
                window.updatePlanningDepartmentFilter();
                window.initMockupPlanningRows();
            }
        });

        // --- 2. ORDER STATUSES SYNC ---
        const statusRef = window.fsCollection(window.db, "order_statuses");
        const qStatus = window.fsQuery(statusRef, window.fsOrderBy("order"));
        window.fsOnSnapshot(qStatus, (snapshot) => {
            window.orderStatusesData = [];
            snapshot.forEach(doc => window.orderStatusesData.push({ id: doc.id, ...doc.data() }));
            populateDropdown('editOrderStatus', window.orderStatusesData);
            populateDropdown('filterStatus', window.orderStatusesData, 'Tất cả trạng thái');
            populateMultiSelect('menu-status', window.orderStatusesData, 'status');
            if (window.allOrdersData.length > 0) window.renderOrdersTable();
        });

        // --- 2.5 ORDER CATEGORIES SYNC ---
        const categoryRef = window.fsCollection(window.db, "order_categories");
        const qCategory = window.fsQuery(categoryRef, window.fsOrderBy("name"));
        window.fsOnSnapshot(qCategory, (snapshot) => {
            window.orderCategoriesData = [];
            const seenNames = new Set();
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.name && !seenNames.has(data.name.toLowerCase())) {
                    window.orderCategoriesData.push({ id: doc.id, ...data });
                    seenNames.add(data.name.toLowerCase());
                }
            });
            if (window.updateOrderCategoryDropdown) {
                window.updateOrderCategoryDropdown();
            } else {
                populateDropdown('orderCategory', window.orderCategoriesData, '- Chọn thể loại -');
            }
            populateDropdown('editOrderCategory', window.orderCategoriesData, '- Chọn thể loại -');
            populateDropdown('budgetFilterCategory', window.orderCategoriesData, 'Tất cả hạng mục', 'all');
            populateMultiSelect('menu-category', window.orderCategoriesData, 'category');
            if (window.allOrdersData.length > 0) window.renderOrdersTable();
        });

        // --- 3. ORDERS SYNC ---
        const ordersRef = window.fsCollection(window.db, "orders");
        const qAll = window.fsQuery(ordersRef, window.fsOrderBy("createdAt", "desc"));
        let isInitialLoadAllOrders = true;
        
        // Request notification permission if not granted (Wrapped in try-catch to avoid breaking Safari/iOS)
        try {
            if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
                Notification.requestPermission().catch(e => console.warn("Notification permission error:", e));
            }
        } catch (err) {
            console.warn("Could not request notification permission:", err);
        }

        window.fsOnSnapshot(qAll, (snapshot) => {
            window.allOrdersData = [];
            snapshot.forEach((doc) => {
                window.allOrdersData.push({ id: doc.id, ...doc.data() });
            });
            
            // Check for newly added orders
            if (!isInitialLoadAllOrders) {
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added') {
                        const order = change.doc.data();
                        const title = order.title || 'Không có tiêu đề';
                        window.showToast(`🔔 Đơn hàng mới: ${title}`, 'success');
                        
                        if ("Notification" in window && Notification.permission === 'granted') {
                            new Notification('Đơn hàng mới', {
                                body: `${title} (${order.code || ''})`,
                                icon: 'https://bizweb.dktcdn.net/100/598/325/themes/1047287/assets/footers2_one_logo.png'
                            });
                        }
                    }
                });
            }
            isInitialLoadAllOrders = false;
            
            // Render visible components
            if (window.currentPage === 'orders') window.renderOrdersTable();
            if (window.currentPage === 'dashboard') window.renderDashboardTable();
            
            if (window.currentPage === 'reports') {
                window.renderReports();
                if (typeof window.renderCategoryStats === 'function') window.renderCategoryStats();
            }
            if (window.currentPage === 'detailed-report') {
                if (typeof window.renderDetailedReport === 'function') window.renderDetailedReport();
            }
            if (window.currentPage === 'planning') {
                if (typeof window.renderPlanningReport === 'function') window.renderPlanningReport();
            }
            if (window.currentPage === 'budgetReport') {
                if (typeof window.renderBudgetReport === 'function') window.renderBudgetReport();
                if (typeof window.renderFinancePage === 'function') window.renderFinancePage();
            }
        });

        // --- 4. ACTIVITIES SYNC ---
        const activitiesRef = window.fsCollection(window.db, "activities");
        const activitiesQuery = window.fsQuery(activitiesRef, window.fsOrderBy("createdAt", "desc"), window.fsLimit(20));
        window.fsOnSnapshot(activitiesQuery, (snapshot) => {
            window.allActivitiesData = [];
            snapshot.forEach(doc => window.allActivitiesData.push({ id: doc.id, ...doc.data() }));
            if (window.renderRecentActivity) window.renderRecentActivity();
        });
    };

// Auto start tracking
if (window.initOrdersTracker) {
    window.initOrdersTracker();
}
