import { 
    db, collection, addDoc, getDocs, doc, getDoc,
    updateDoc, deleteDoc, serverTimestamp, setDoc,
    query, orderBy, onSnapshot, deleteField, runTransaction
} from "./firebase-service.js";
import { escapeHtml, safeUrl, buildLocalYMD } from "./security-utils.js";

// Auth Guard
const isLoggedIn = localStorage.getItem('nevo_logged_in') === 'true';
if (!isLoggedIn) {
    window.location.replace('login.html');
}

const userRole = (localStorage.getItem('nevo_role') || 'user').trim();
const roleLower = userRole.toLowerCase();
const isViewer = roleLower === 'viewer';
const isUser = !['admin', 'manager'].includes(roleLower);

let currentMonth = "";
let COLLECTION_NAME = "";
let currentViewMode = "month"; // "month" or "all"
let selectedYear = String(new Date().getFullYear());
let allProductsData = [];
let activeRealtimeUnsub = null;
let hoverPreviewReqId = 0;
const SETTINGS_DOC = "products_table_config";

let table;
let isSyncing = false;
let statusOptions = ["Hoàn tất", "Đang xử lý", "Chưa thực hiện"];
let statusColors = {
    "Hoàn tất": "#dcfce7",
    "Đang xử lý": "#fef08a",
    "Chưa thực hiện": "#ffffff"
};

// Image Cache for Drive API optimization
const driveCache = new Map();
const imageCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

// Reusable Link Formatter (XSS-hardened)
const linkFormatter = function(cell) {
    const val = cell.getValue();
    if (val && typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed.toLowerCase().startsWith("http") || trimmed.toLowerCase().startsWith("www") || trimmed.toLowerCase().startsWith("drive.google.com")) {
            const candidate = trimmed.toLowerCase().startsWith("http") ? trimmed : "https://" + trimmed;
            const cleanHref = safeUrl(candidate);
            if (cleanHref) {
                return `<a href="${escapeHtml(cleanHref)}" target="_blank" rel="noopener noreferrer" class="link-access text-blue-600 hover:underline cursor-pointer inline-flex items-center gap-1" title="${escapeHtml(trimmed)}" onclick="event.stopPropagation();" onmousedown="event.stopPropagation();" onpointerdown="event.stopPropagation();"><span class="material-symbols-outlined text-[14px]">link</span> Truy cập</a>`;
            }
        }
        return escapeHtml(val);
    }
    return val ?? "";
};

// Custom Formatter for Status (XSS-hardened)
const statusFormatter = function(cell) {
    let val = cell.getValue() || "Chưa thực hiện";
    if (val === "Chưa có" || val === "Chưa chụp") val = "Chưa thực hiện";
    const rawColor = statusColors[val] || "#e2e8f0";
    const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(rawColor) ? rawColor : "#e2e8f0";
    const escVal = escapeHtml(val);
    
    if (val === "Hoàn tất") return `<span class="status-badge status-hoan-tat">${escVal}</span>`;
    if (val === "Đang xử lý") return `<span class="status-badge status-dang-xu-ly">${escVal}</span>`;
    if (val === "Chưa thực hiện") return `<span class="status-badge status-chua-co">${escVal}</span>`;
    
    return `<span class="status-badge" style="background-color: ${safeColor}; color: #475569; border: 1px solid rgba(0,0,0,0.05)">${escVal}</span>`;
};

const dateEditor = function(cell, onRendered, success, cancel) {
    let cellValue = cell.getValue() || "";
    let input = document.createElement("input");
    input.type = "date";
    
    // Convert DD/MM/YYYY to YYYY-MM-DD for native input
    if (cellValue) {
        let parts = cellValue.split("/");
        if (parts.length === 3) {
            input.value = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        }
    }
    
    input.style.cssText = "padding:4px; width:100%; box-sizing:border-box; border:none; outline:none; background:transparent; font-family:inherit; font-size:inherit;";
    
    onRendered(() => { 
        input.focus(); 
        // Auto open picker if supported by browser
        if (typeof input.showPicker === 'function') {
            try { input.showPicker(); } catch (e) {}
        }
    });

    function onChange() {
        let val = input.value;
        if (!val) return success("");
        
        // Convert YYYY-MM-DD back to DD/MM/YYYY
        let parts = val.split("-");
        if (parts.length === 3) {
            val = `${parts[2]}/${parts[1]}/${parts[0]}`;
        }
        
        success(val);
    }
    
    input.addEventListener("blur", onChange);
    input.addEventListener("keydown", (e) => { 
        if (e.key === "Enter") onChange(); 
        if (e.key === "Escape") cancel(); 
    });
    return input;
};

// Formatter to show only DD/MM
const dateDisplayFormatter = function(cell) {
    let val = cell.getValue();
    if (!val || typeof val !== "string") return val || "";
    let parts = val.split("/");
    if (parts.length >= 2) {
        return `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}`;
    }
    return val;
};

// Row formatter for coloring
const rowColorFormatter = function(row) {
    let data = row.getData();
    // Manual row color overrides status color
    if (data.rowColor) {
        row.getElement().style.backgroundColor = data.rowColor;
        return;
    }
    
    // Auto status color
    let statuses = [data.anhTraiSanTrangThai, data.anhModelTrangThai, data.videoModelTrangThai];
    const processingStatuses = ["Đang xử lý", "Đang hậu kỳ", "Đang triển khai"];
    
    if (statuses.some(s => processingStatuses.includes(s))) {
        // Use color of first matched processing status, or fallback to yellow
        let matchedStatus = statuses.find(s => processingStatuses.includes(s));
        row.getElement().style.backgroundColor = statusColors[matchedStatus] || statusColors["Đang xử lý"] || "#fef08a";
    } else if (statuses.every(s => s === "Hoàn tất")) {
        row.getElement().style.backgroundColor = statusColors["Hoàn tất"];
    } else {
        row.getElement().style.backgroundColor = "#ffffff";
    }
};

// Update Sync Status UI
function setSyncing(status) {
    isSyncing = status;
    const el = document.getElementById("syncStatus");
    const ind = document.getElementById("sync-indicator");
    if (ind) ind.style.display = status ? "inline-flex" : "none";
    if (!el) return;
    if (status) {
        el.innerHTML = `<span class="material-symbols-outlined text-[14px] animate-spin text-amber-500">sync</span>
                        <span class="text-[11px] font-bold text-amber-700 uppercase tracking-wide">Đang lưu...</span>`;
        el.className = "flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-100";
    } else {
        el.innerHTML = `<div class="live-dot"></div>
                        <span class="text-[11px] font-bold text-emerald-700 uppercase tracking-wide">Đã lưu</span>`;
        el.className = "flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-100";
    }
}

// Update Stats
function updateStats(data) {
    const safeData = Array.isArray(data) ? data : [];
    const setTxt = (id, v) => { const n = document.getElementById(id); if (n) n.innerText = v; };
    setTxt('stat-rows', safeData.length);
    const totalQty = safeData.reduce((sum, item) => sum + (parseInt(item.soLuongVe, 10) || 0), 0);
    setTxt('stat-total', totalQty);
    const totalMa10 = safeData.filter(d => d.ma10 && d.ma10.toString().trim() !== '').length;
    setTxt('stat-ma10', totalMa10);
    setTxt('stat-traisan', safeData.filter(d => d.anhTraiSanTrangThai === 'Hoàn tất').length);
    setTxt('stat-model', safeData.filter(d => d.anhModelTrangThai === 'Hoàn tất').length);
    setTxt('stat-video', safeData.filter(d => d.videoModelTrangThai === 'Hoàn tất').length);
}

// Date helpers for "Xem toàn bộ" by year & arrival date
function extractYearFromDateStr(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const parts = dateStr.trim().split('/');
    if (parts.length === 3) return parts[2].trim();
    const dashParts = dateStr.trim().split('-');
    if (dashParts.length === 3) {
        return dashParts[0].length === 4 ? dashParts[0].trim() : dashParts[2].trim();
    }
    return null;
}

function parseDateStrToTimestamp(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return 0;
    const trimmed = dateStr.trim();
    const parts = trimmed.split('/');
    if (parts.length === 3) {
        const day = parseInt(parts[0], 10) || 1;
        const month = (parseInt(parts[1], 10) || 1) - 1;
        const year = parseInt(parts[2], 10) || 2026;
        return new Date(year, month, day).getTime();
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        const [y, m, d] = trimmed.split('-').map(Number);
        return new Date(y, m - 1, d).getTime();
    }
    return 0;
}

// Setup Months across 2025-2028
function setupMonths() {
    const sel = document.getElementById('month-selector');
    if (!sel) return;
    sel.innerHTML = '';
    const now = new Date();
    const curYearNum = now.getFullYear();
    const curMonthNum = now.getMonth() + 1;
    const years = Array.from(new Set([2025, 2026, 2027, Math.max(2028, curYearNum + 1)])).sort((a, b) => b - a);
    
    years.forEach(y => {
        const grp = document.createElement('optgroup');
        grp.label = `Năm ${y}`;
        for (let m = 1; m <= 12; m++) {
            const mStr = String(m).padStart(2, '0');
            const val = `${mStr}-${y}`;
            const opt = document.createElement('option');
            opt.value = val;
            opt.text = `Tháng ${mStr}/${y}`;
            if (y === curYearNum && m === curMonthNum) {
                opt.selected = true;
                currentMonth = val;
                COLLECTION_NAME = "new_products_" + val;
            }
            grp.appendChild(opt);
        }
        sel.appendChild(grp);
    });

    if (!currentMonth) {
        const mStr = String(curMonthNum).padStart(2, '0');
        currentMonth = `${mStr}-${curYearNum}`;
        COLLECTION_NAME = "new_products_" + currentMonth;
    }

    const yearSelect = document.getElementById('year-selector');
    if (yearSelect && yearSelect.querySelector(`option[value="${curYearNum}"]`)) {
        yearSelect.value = String(curYearNum);
        selectedYear = String(curYearNum);
    }
    
    sel.addEventListener('change', (e) => {
        currentMonth = e.target.value;
        COLLECTION_NAME = "new_products_" + currentMonth;
        loadTableData().then(() => migrateOldStatuses());
    });
}

function attachMonthRealtimeListener(collName, monthVal) {
    if (activeRealtimeUnsub) {
        activeRealtimeUnsub();
        activeRealtimeUnsub = null;
    }
    let isFirstSnap = true;
    activeRealtimeUnsub = onSnapshot(collection(db, collName), (snap) => {
        if (isFirstSnap) {
            isFirstSnap = false;
            return;
        }
        if (!table || currentViewMode !== 'month' || COLLECTION_NAME !== collName) return;
        // Avoid disrupting active inline cell editing
        if (document.querySelector('#products-table .tabulator-editing')) return;

        snap.docChanges().forEach(change => {
            const d = change.doc;
            const rowObj = {
                id: d.id,
                _collectionName: collName,
                _monthStr: monthVal,
                ...d.data()
            };
            if (change.type === 'removed') {
                const existing = table.getRow(d.id);
                if (existing) existing.delete();
            } else {
                table.updateOrAddData([rowObj]).catch(() => {});
            }
        });
        setTimeout(() => {
            if (table) updateStats(table.getData('active'));
        }, 60);
    }, (err) => console.warn('Realtime products sync warning:', err));
}

// Load Data into Table (Month View)
async function loadTableData() {
    setSyncing(true);
    try {
        const q = query(collection(db, COLLECTION_NAME), orderBy("createdAt", "desc"));
        const snapshot = await getDocs(q);
        const tableData = [];
        snapshot.forEach(docSnap => {
            tableData.push({
                id: docSnap.id,
                _collectionName: COLLECTION_NAME,
                _monthStr: currentMonth,
                ...docSnap.data()
            });
        });
        
        if (table) {
            try { table.hideColumn('_monthStr'); } catch(e) {}
            await table.setData(tableData);
            updateStats(tableData);
        }
        attachMonthRealtimeListener(COLLECTION_NAME, currentMonth);
        setSyncing(false);
        return tableData;
    } catch (e) {
        console.error("Error loading data:", e);
        const snapshot = await getDocs(collection(db, COLLECTION_NAME));
        const tableData = snapshot.docs.map(docSnap => ({
            id: docSnap.id,
            _collectionName: COLLECTION_NAME,
            _monthStr: currentMonth,
            ...docSnap.data()
        }));
        if (table) {
            try { table.hideColumn('_monthStr'); } catch(e) {}
            table.setData(tableData);
            updateStats(tableData);
        }
        attachMonthRealtimeListener(COLLECTION_NAME, currentMonth);
        setSyncing(false);
        return tableData;
    }
}

// Load All Year Data for "Xem toàn bộ" tab
async function loadAllYearData(year = "2026") {
    if (activeRealtimeUnsub) {
        activeRealtimeUnsub();
        activeRealtimeUnsub = null;
    }
    setSyncing(true);
    try {
        const promises = [];
        const curY = new Date().getFullYear();
        const dynamicYears = Array.from(new Set(['2025', '2026', '2027', '2028', String(curY)]));
        const yearsToScan = (year === 'all') ? dynamicYears : [year];
        
        for (const y of yearsToScan) {
            for (let m = 1; m <= 12; m++) {
                const mStr = String(m).padStart(2, '0') + '-' + y;
                const collName = `new_products_${mStr}`;
                promises.push(
                    getDocs(collection(db, collName)).then(snap => {
                        return snap.docs.map(doc => ({
                            id: doc.id,
                            _collectionName: collName,
                            _monthStr: mStr,
                            ...doc.data()
                        }));
                    }).catch(() => [])
                );
            }
        }

        // Also fetch legacy collection 'new_products'
        if (year === '2026' || year === 'all') {
            promises.push(
                getDocs(collection(db, "new_products")).then(snap => {
                    return snap.docs.map(doc => ({
                        id: doc.id,
                        _collectionName: "new_products",
                        _monthStr: "05-2026",
                        ...doc.data()
                    }));
                }).catch(() => [])
            );
        }

        const results = await Promise.all(promises);
        const rawProducts = results.flat();

        // Deduplicate
        const seen = new Set();
        let uniqueProducts = [];
        for (const item of rawProducts) {
            const key = item._collectionName + '_' + item.id;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueProducts.push(item);
            }
        }

        // Filter based on "Ngày về kho Media"
        if (year !== 'all') {
            uniqueProducts = uniqueProducts.filter(item => {
                const yearFromDate = extractYearFromDateStr(item.ngayVeKho);
                if (yearFromDate) {
                    return yearFromDate === year;
                }
                const collYear = item._monthStr ? item._monthStr.split('-')[1] : null;
                return collYear === year;
            });
        }

        // Sort by "Ngày về kho Media" descending (newest arrival date on top)
        uniqueProducts.sort((a, b) => {
            const timeA = parseDateStrToTimestamp(a.ngayVeKho) || (a.createdAt?.toMillis ? a.createdAt.toMillis() : 0);
            const timeB = parseDateStrToTimestamp(b.ngayVeKho) || (b.createdAt?.toMillis ? b.createdAt.toMillis() : 0);
            return timeB - timeA;
        });

        allProductsData = uniqueProducts;

        if (table) {
            try { table.showColumn('_monthStr'); } catch (e) {}
            await table.setData(allProductsData);
            updateStats(allProductsData);
        }
        setSyncing(false);
        return allProductsData;
    } catch (err) {
        console.error("Error loading all year data:", err);
        setSyncing(false);
        return [];
    }
}

// Switch between "Theo tháng" and "Xem toàn bộ" modes
function switchViewMode(mode) {
    currentViewMode = mode;
    const tabMonth = document.getElementById('tab-mode-month');
    const tabAll = document.getElementById('tab-mode-all');
    const monthContainer = document.getElementById('month-selector-container');
    const yearContainer = document.getElementById('year-selector-container');

    if (mode === 'all') {
        if (tabAll) tabAll.className = "flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-bold transition-all bg-white text-slate-900 shadow-sm cursor-pointer";
        if (tabMonth) tabMonth.className = "flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition-all text-slate-600 hover:text-slate-900 cursor-pointer";
        
        if (monthContainer) {
            monthContainer.classList.add('hidden');
            monthContainer.classList.remove('flex');
        }
        if (yearContainer) {
            yearContainer.classList.remove('hidden');
            yearContainer.classList.add('flex');
        }

        if (table) {
            try { table.showColumn('_monthStr'); } catch (e) {}
        }
        loadAllYearData(selectedYear);
    } else {
        if (tabMonth) tabMonth.className = "flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-bold transition-all bg-white text-slate-800 shadow-sm cursor-pointer";
        if (tabAll) tabAll.className = "flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition-all text-slate-600 hover:text-slate-900 cursor-pointer";

        if (yearContainer) {
            yearContainer.classList.add('hidden');
            yearContainer.classList.remove('flex');
        }
        if (monthContainer) {
            monthContainer.classList.remove('hidden');
            monthContainer.classList.add('flex');
        }

        if (table) {
            try { table.hideColumn('_monthStr'); } catch (e) {}
        }
        loadTableData();
    }
}

// Migration: Update old status values in Firestore
async function migrateOldStatuses() {
    const migrationKey = `status_migrated_${COLLECTION_NAME}`;
    if (localStorage.getItem(migrationKey)) return; // Already migrated this collection

    console.log(`🔄 Migrating old statuses in ${COLLECTION_NAME}...`);
    const LEGACY_VALUES = ["Chưa có", "Chưa chụp"];
    const STATUS_FIELDS = ["anhTraiSanTrangThai", "anhModelTrangThai", "videoModelTrangThai"];
    const NEW_VALUE = "Chưa thực hiện";

    try {
        const snapshot = await getDocs(collection(db, COLLECTION_NAME));
        let updatedCount = 0;

        const promises = [];
        snapshot.forEach(docSnap => {
            const data = docSnap.data();
            const updates = {};
            let needsUpdate = false;

            STATUS_FIELDS.forEach(field => {
                if (LEGACY_VALUES.includes(data[field])) {
                    updates[field] = NEW_VALUE;
                    needsUpdate = true;
                }
            });

            if (needsUpdate) {
                promises.push(
                    updateDoc(doc(db, COLLECTION_NAME, docSnap.id), updates)
                        .then(() => { updatedCount++; })
                );
            }
        });

        await Promise.all(promises);
        localStorage.setItem(migrationKey, 'true');
        console.log(`✅ Migration done: ${updatedCount} documents updated in ${COLLECTION_NAME}`);

        // Reload table data if any updates were made
        if (updatedCount > 0 && table) {
            await loadTableData();
        }
    } catch (e) {
        console.error("Migration error:", e);
    }
}

// Initialize App
async function init() {
    setupMonths();
    setSyncing(true);
    
    // Fetch Settings
    let customCols = [];
    try {
        const configSnap = await getDoc(doc(db, "settings", SETTINGS_DOC));
        if (configSnap.exists()) {
            customCols = configSnap.data().customColumns || [];
            if (configSnap.data().statusColors) statusColors = configSnap.data().statusColors;
            if (configSnap.data().statusOptions) statusOptions = configSnap.data().statusOptions;
        }
    } catch (e) { console.log("No config found"); }

    function updateDriveButton() {
        const btn = document.getElementById("btn-connect-drive");
        if (!btn) return;
        const token = localStorage.getItem("gdrive_access_token");
        const expires = localStorage.getItem("gdrive_token_expires");
        const isValid = token && expires && Date.now() < parseInt(expires);
        
        if (isValid) {
            btn.innerHTML = `<span class="material-symbols-outlined text-[18px] text-emerald-600">cloud_done</span>
                             <span class="text-emerald-700 font-bold">Đã kết nối Drive</span>`;
            btn.className = "px-4 py-2 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl hover:bg-emerald-100 transition-all font-bold flex items-center gap-2 text-sm";
        } else {
            btn.innerHTML = `<span class="material-symbols-outlined text-[18px]">add_to_drive</span>
                             <span>Kết nối Drive</span>`;
            btn.className = "px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-xl hover:bg-slate-50 transition-all font-bold flex items-center gap-2 text-sm";
        }
    }

    let tokenClient = null;
    let isConnectingDrive = false; // Chặn bấm nhiều lần khi đang kết nối
    let cachedClientId = null;
    let driveRefreshTimer = null;
    const DRIVE_REFRESH_MARGIN = 5 * 60 * 1000; // gia hạn trước khi hết hạn 5 phút

    // silent = true: tự gia hạn im lặng (không hộp thoại, không báo lỗi khi thất bại)
    async function connectGoogleDrive(silent = false, forceSelectAccount = false) {
        if (silent !== true && !forceSelectAccount) {
            const curToken = localStorage.getItem("gdrive_access_token");
            const curExp = parseInt(localStorage.getItem("gdrive_token_expires") || "0", 10);
            if (curToken && curExp && Date.now() < curExp) {
                const hintEmail = localStorage.getItem("gdrive_hint") || "Tài khoản hiện tại";
                const choice = await Swal.fire({
                    title: 'Google Drive đã kết nối',
                    text: `Đang kết nối: ${hintEmail}`,
                    icon: 'info',
                    showCancelButton: true,
                    showDenyButton: true,
                    confirmButtonText: 'Đổi tài khoản Google',
                    denyButtonText: 'Ngắt kết nối',
                    cancelButtonText: 'Đóng'
                });
                if (choice.isDenied) {
                    localStorage.removeItem("gdrive_access_token");
                    localStorage.removeItem("gdrive_token_expires");
                    localStorage.removeItem("gdrive_connected");
                    localStorage.removeItem("gdrive_hint");
                    updateDriveButton();
                    if (table) table.redraw(true);
                    return;
                }
                if (!choice.isConfirmed) return;
                forceSelectAccount = true;
            }
        }

        if (isConnectingDrive) return;
        isConnectingDrive = true;
        let popupOpened = false;
        try {
            popupOpened = await connectGoogleDriveFlow(silent === true, forceSelectAccount === true);
        } finally {
            if (!popupOpened) isConnectingDrive = false;
        }
    }

    // Hẹn giờ tự gia hạn token trước khi hết hạn (nếu tab còn mở)
    function scheduleDriveRefresh() {
        if (driveRefreshTimer) clearTimeout(driveRefreshTimer);
        const expires = parseInt(localStorage.getItem("gdrive_token_expires") || "0");
        if (!expires) return;
        const delay = Math.max(expires - Date.now() - DRIVE_REFRESH_MARGIN, 5000);
        driveRefreshTimer = setTimeout(() => connectGoogleDrive(true), delay);
    }

    // Vào trang: token còn hạn thì chỉ hẹn giờ gia hạn; hết hạn nhưng đã từng kết nối thì thử gia hạn im lặng
    function trySilentReconnect() {
        const token = localStorage.getItem("gdrive_access_token");
        const expires = parseInt(localStorage.getItem("gdrive_token_expires") || "0");
        if (token && expires && Date.now() < expires) { scheduleDriveRefresh(); return; }
        if (localStorage.getItem("gdrive_connected") === "1") {
            // Thư viện Google tải async: chờ tối đa ~10s rồi mới gia hạn im lặng
            let tries = 0;
            const wait = setInterval(() => {
                tries++;
                if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
                    clearInterval(wait);
                    connectGoogleDrive(true);
                } else if (tries >= 40) clearInterval(wait);
            }, 250);
        }
    }

    // Lưu email tài khoản Google đã kết nối để lần sau Google chọn đúng tài khoản
    async function rememberDriveAccount(token) {
        try {
            const resp = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!resp.ok) return;
            const data = await resp.json();
            if (data && data.user && data.user.emailAddress) localStorage.setItem("gdrive_hint", data.user.emailAddress);
        } catch (e) { /* không quan trọng */ }
    }

    async function connectGoogleDriveFlow(silent, forceSelectAccount = false) {
        // Fetch googleClientId from settings document
        let clientId = cachedClientId;
        try {
            if (!clientId) {
                const configSnap = await getDoc(doc(db, "settings", SETTINGS_DOC));
                clientId = configSnap.exists() ? configSnap.data().googleClientId : null;
            }
        } catch (err) { console.error("Error loading config for Google Drive:", err); }
        
        if (!clientId && silent) return false;
        if (!clientId) {
            if (isUser) {
                Swal.fire('Chưa cấu hình Google Client ID', 'Vui lòng liên hệ Quản trị viên để cấu hình Google Client ID cho tổ chức.', 'warning');
                return false;
            }
            const { value: newId } = await Swal.fire({
                title: 'Cấu hình Google Client ID',
                text: 'Hệ thống chưa có Google Client ID. Vui lòng nhập Client ID của tổ chức Yody để kết nối trực tiếp với Google Drive:',
                input: 'text',
                inputPlaceholder: 'Nhập Google OAuth Client ID...',
                showCancelButton: true,
                confirmButtonText: 'Lưu & Kết nối',
                cancelButtonText: 'Hủy'
            });
            if (newId && newId.trim()) {
                setSyncing(true);
                try {
                    await setDoc(doc(db, "settings", SETTINGS_DOC), { googleClientId: newId.trim() }, { merge: true });
                    clientId = newId.trim();
                    Swal.fire('Thành công', 'Đã lưu Google Client ID. Bắt đầu kết nối...', 'success');
                } catch (e) {
                    Swal.fire('Lỗi', 'Không thể lưu cài đặt.', 'error');
                    setSyncing(false);
                    return false;
                }
                setSyncing(false);
            } else {
                return false;
            }
        }
        
        if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
            if (!silent) Swal.fire('Lỗi thư viện', 'Thư viện Google Identity Services chưa tải xong. Vui lòng thử lại sau vài giây!', 'error');
            return false;
        }
        
        cachedClientId = clientId;
        try {
            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: clientId,
                scope: 'https://www.googleapis.com/auth/drive.readonly',
                callback: (tokenResponse) => {
                    isConnectingDrive = false;
                    if (tokenResponse && tokenResponse.access_token) {
                        localStorage.setItem("gdrive_access_token", tokenResponse.access_token);
                        localStorage.setItem("gdrive_token_expires", (Date.now() + tokenResponse.expires_in * 1000).toString());
                        localStorage.setItem("gdrive_connected", "1");
                        updateDriveButton();
                        scheduleDriveRefresh();
                        rememberDriveAccount(tokenResponse.access_token);
                        if (table) table.redraw(true);
                        if (!silent) Swal.fire('Thành công', 'Đã kết nối trực tiếp với Google Drive thành công!', 'success');
                    } else if (!silent) {
                        Swal.fire('Lỗi ủy quyền', 'Sếp đã từ chối hoặc có lỗi trong quá trình cấp quyền.', 'error');
                    }
                },
                error_callback: () => { isConnectingDrive = false; }
            });
            const request = { prompt: forceSelectAccount ? 'select_account' : '' };
            const hint = localStorage.getItem("gdrive_hint");
            if (hint && !forceSelectAccount) request.hint = hint;
            tokenClient.requestAccessToken(request);
            return true;
        } catch (err) {
            console.error(err);
            if (!silent) Swal.fire('Lỗi kết nối', 'Có lỗi khi kết nối Google: ' + err.message, 'error');
            return false;
        }
    }

    function extractFolderId(url) {
        if (!url || typeof url !== "string") return null;
        const s = url.trim();
        const byParam = s.match(/[?&]id=([-\w]{15,})/);
        if (byParam) return byParam[1];
        const byFolder = s.match(/\/folders\/([-\w]{15,})/);
        if (byFolder) return byFolder[1];
        const byFile = s.match(/\/d\/([-\w]{15,})/);
        if (byFile) return byFile[1];
        const match = s.match(/[-\w]{25,}/);
        return match ? match[0] : null;
    }

    function hideImagePreview() {
        hoverPreviewReqId++;
        const card = document.getElementById("hover-preview-card");
        if (card) {
            card.style.display = "none";
            const img = document.getElementById("preview-img");
            img.style.display = "none";
            img.src = "";
            document.getElementById("preview-title").innerText = "";
            const spinner = card.querySelector(".loading-spinner");
            if (spinner) spinner.style.display = "block";
        }
    }

    // Helper: all Drive API calls go through here with Authorization header
    async function driveApiFetch(url, token) {
        return await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
    }

    const folderInflight = new Map();
    const metaCache = new Map();
    const metaInflight = new Map();

    function normalizeDriveItem(f) {
        if (f && f.mimeType === 'application/vnd.google-apps.shortcut' && f.shortcutDetails && f.shortcutDetails.targetId) {
            return {
                id: f.shortcutDetails.targetId,
                name: f.name,
                mimeType: f.shortcutDetails.targetMimeType || f.mimeType,
                thumbnailLink: f.thumbnailLink
            };
        }
        return f;
    }

    // Cached folder file listing (with in-flight deduplication)
    async function getCachedFolderFiles(folderId, token) {
        const cached = driveCache.get(folderId);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) return cached;
        if (folderInflight.has(folderId)) return await folderInflight.get(folderId);

        const promise = (async () => {
            const q = `'${folderId}' in parents and trashed = false`;
            const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,thumbnailLink,shortcutDetails)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1000`;
            const resp = await driveApiFetch(url, token);
            if (!resp.ok) return { status: resp.status, files: [], timestamp: 0 };
            const data = await resp.json();
            const rawFiles = (data.files || []).map(normalizeDriveItem);
            const entry = { status: 200, files: rawFiles, timestamp: Date.now() };
            driveCache.set(folderId, entry);
            return entry;
        })();

        folderInflight.set(folderId, promise);
        try {
            return await promise;
        } finally {
            folderInflight.delete(folderId);
        }
    }

    // Cached metadata lookup for links like drive.google.com/open?id=... (could be folder or file)
    async function getCachedFileMeta(fileId, token) {
        const cached = metaCache.get(fileId);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) return cached;
        if (metaInflight.has(fileId)) return await metaInflight.get(fileId);

        const promise = (async () => {
            const fileUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,thumbnailLink,shortcutDetails&supportsAllDrives=true`;
            const resp = await driveApiFetch(fileUrl, token);
            if (!resp.ok) return { status: resp.status, file: null, timestamp: 0 };
            const raw = await resp.json();
            const file = normalizeDriveItem(raw);
            const entry = { status: 200, file, timestamp: Date.now() };
            metaCache.set(fileId, entry);
            return entry;
        })();

        metaInflight.set(fileId, promise);
        try {
            return await promise;
        } finally {
            metaInflight.delete(fileId);
        }
    }

    function normalizeCodeStr(s) {
        return String(s || "").toLowerCase().replace(/[\s_]+/g, "-");
    }

    function isImageOrPreviewable(f) {
        if (!f || !f.mimeType || f.mimeType === 'application/vnd.google-apps.folder') return false;
        return f.mimeType.startsWith('image/') || Boolean(f.thumbnailLink);
    }

    function findBestImageMatch(files, candidate) {
        const normCandidate = normalizeCodeStr(candidate);
        let matches = files.filter(f => {
            if (!isImageOrPreviewable(f) || !f.name) return false;
            const lowName = f.name.toLowerCase();
            return lowName.includes(candidate) || normalizeCodeStr(lowName).includes(normCandidate);
        });
        if (matches.length === 0) return null;
        
        matches.sort((a, b) => {
            const nameA = a.name.toLowerCase();
            const nameB = b.name.toLowerCase();
            
            const getScore = (f, name) => {
                const nameWithoutExt = name.substring(0, name.lastIndexOf('.')) || name;
                const normNoExt = normalizeCodeStr(nameWithoutExt);
                let score = 40;
                if (nameWithoutExt === candidate || normNoExt === normCandidate) score = 100;
                else if (name.includes('(1)') || name.includes('-1') || name.includes('_1') || name.includes('front')) score = 80;
                else if (name.includes('(2)') || name.includes('-2') || name.includes('_2')) score = 60;
                if (f.mimeType && f.mimeType.startsWith('image/')) score += 5;
                return score;
            };
            
            const scoreA = getScore(a, nameA);
            const scoreB = getScore(b, nameB);
            
            if (scoreA !== scoreB) return scoreB - scoreA; 
            return nameA.localeCompare(nameB); 
        });
        
        return matches[0];
    }

    async function findImageInFolder(folderId, searchCode, token, strictColor = false) {
        const folderData = await getCachedFolderFiles(folderId, token);
        if (folderData.status !== 200) return { status: folderData.status, file: null };
        const files = folderData.files;

        const targetCode = normalizeCodeStr(searchCode.trim());
        const searchCandidates = [targetCode];
        if (targetCode.includes('-')) {
            const parts = targetCode.split('-');
            if (parts.length > 2) searchCandidates.push(parts.slice(0, 2).join('-'));
            if (!strictColor) searchCandidates.push(parts[0]);
        }

        // 1. Direct match in current folder
        for (const candidate of searchCandidates) {
            const bestMatch = findBestImageMatch(files, candidate);
            if (bestMatch) return { status: 200, file: bestMatch };
        }

        // 2. Search subfolders (prioritize subfolders whose name matches candidate codes, skip other product-code folders)
        const productCodePattern = /[a-z]{3,5}\d{2}[a-z]\d{3}/i;
        const allSubfolders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
        const folderMatchRank = (folderName) => {
            const low = normalizeCodeStr(folderName || "");
            for (let i = 0; i < searchCandidates.length; i++) {
                if (low.includes(searchCandidates[i])) return i;
            }
            return 99;
        };
        const matchingSubfolders = allSubfolders
            .filter(f => folderMatchRank(f.name) < 99)
            .sort((a, b) => folderMatchRank(a.name) - folderMatchRank(b.name));
        // Chỉ quét thêm tối đa 6 thư mục chung (không mang mã sản phẩm khác) nếu chưa tìm thấy
        const genericSubfolders = allSubfolders
            .filter(f => folderMatchRank(f.name) === 99 && !productCodePattern.test(f.name || ""))
            .slice(0, 6);
        const subfolders = [...matchingSubfolders, ...genericSubfolders];

        for (const folder of subfolders) {
            const subData = await getCachedFolderFiles(folder.id, token);
            if (subData.status === 200) {
                for (const candidate of searchCandidates) {
                    const bestMatch = findBestImageMatch(subData.files, candidate);
                    if (bestMatch) return { status: 200, file: bestMatch };
                }
                // Check level-2 subfolders if they match candidate codes
                const subSubfolders = subData.files.filter(
                    f => f.mimeType === 'application/vnd.google-apps.folder' && folderMatchRank(f.name) < 99
                );
                subSubfolders.sort((a, b) => folderMatchRank(a.name) - folderMatchRank(b.name));
                for (const sub2 of subSubfolders) {
                    const sub2Data = await getCachedFolderFiles(sub2.id, token);
                    if (sub2Data.status === 200) {
                        for (const candidate of searchCandidates) {
                            const bestMatch = findBestImageMatch(sub2Data.files, candidate);
                            if (bestMatch) return { status: 200, file: bestMatch };
                        }
                        const firstImg = sub2Data.files.find(isImageOrPreviewable);
                        if (firstImg) return { status: 200, file: firstImg };
                    }
                }
                // If the subfolder itself is named after this specific product/color, fallback to its first image
                if (folderMatchRank(folder.name) <= 1) {
                    const firstImg = subData.files.find(isImageOrPreviewable);
                    if (firstImg) return { status: 200, file: firstImg };
                }
            }
        }
        return { status: 200, file: null };
    }

    // Unified resolver: handles /folders/, /open?id=..., shortcuts, direct files, and fallback across links
    async function resolveDriveImageFromLink(linkAnh, searchCode, token, strictColor = false) {
        const id = extractFolderId(linkAnh);
        if (!id) return { status: 400, file: null, isFolder: false };

        const explicitFolderUrl = linkAnh.includes("/folders/") || linkAnh.includes("folderview") || driveCache.has(id);
        if (explicitFolderUrl) {
            const res = await findImageInFolder(id, searchCode, token, strictColor);
            return { status: res.status, file: res.file, isFolder: true };
        }

        // Unknown link format (e.g. drive.google.com/open?id=...&usp=drive_fs or /file/d/...): check metadata first
        const meta = await getCachedFileMeta(id, token);
        if (meta.status !== 200 || !meta.file) {
            return { status: meta.status, file: null, isFolder: false };
        }
        if (meta.file.mimeType === 'application/vnd.google-apps.folder') {
            const res = await findImageInFolder(meta.file.id, searchCode, token, strictColor);
            return { status: res.status, file: res.file, isFolder: true };
        }
        return { status: 200, file: meta.file, isFolder: false };
    }

    async function resolveDriveImageFromLinks(links, searchCode, token) {
        const validLinks = (links || []).filter(l => l && typeof l === 'string' && l.includes("drive.google.com"));
        let lastResult = { status: 200, file: null, isFolder: true };
        const hasColorPart = normalizeCodeStr(searchCode).includes('-');

        // Lượt 1: Tìm khớp đúng mã màu (Mã 16) trên tất cả các link (ưu tiên Model -> Trải sàn)
        for (const link of validLinks) {
            const res = await resolveDriveImageFromLink(link, searchCode, token, hasColorPart);
            if (res.status === 401 || res.status === 403) return res;
            if (res.file && isImageOrPreviewable(res.file)) return res;
            lastResult = res;
        }
        // Lượt 2: Nếu chưa thấy ảnh theo mã màu, cho phép fallback theo Mã 10
        if (hasColorPart) {
            for (const link of validLinks) {
                const res = await resolveDriveImageFromLink(link, searchCode, token, false);
                if (res.status === 401 || res.status === 403) return res;
                if (res.file && isImageOrPreviewable(res.file)) return res;
                lastResult = res;
            }
        }
        return lastResult;
    }

    async function showImagePreview(e, cell) {
        const reqId = ++hoverPreviewReqId;
        const rowData = cell.getRow().getData();
        const searchCode = rowData.ma16 || rowData.ma10;
        const field = cell.getField();
        
        let candidateLinks = [];
        if (field === "linkAnh") {
            candidateLinks = [rowData.linkAnh];
        } else if (field === "linkAnhModel") {
            candidateLinks = [rowData.linkAnhModel];
        } else {
            candidateLinks = [rowData.linkAnhModel, rowData.linkAnh];
        }
        candidateLinks = candidateLinks.filter(l => l && typeof l === 'string' && l.includes("drive.google.com"));

        if (!searchCode || candidateLinks.length === 0) return;

        const card = document.getElementById("hover-preview-card");
        const previewImg = document.getElementById("preview-img");
        const previewTitle = document.getElementById("preview-title");
        const spinner = card.querySelector(".loading-spinner");
        previewImg.style.display = "none";
        spinner.style.display = "block";
        previewTitle.innerText = "";

        let x = e.clientX + 20, y = e.clientY - 150;
        if (x + 350 > window.innerWidth) x = e.clientX - 340;
        if (y < 10) y = 10;
        if (y + 450 > window.innerHeight) y = window.innerHeight - 460;
        card.style.left = x + "px";
        card.style.top = y + "px";
        card.style.display = "block";

        const token = localStorage.getItem("gdrive_access_token");
        const expires = localStorage.getItem("gdrive_token_expires");
        if (!token || !expires || Date.now() >= parseInt(expires)) {
            previewTitle.innerHTML = `<span class="text-rose-500 font-bold">⚠️ Chưa kết nối Drive</span><br><span class="text-[11px] text-slate-500 font-normal">Bấm vào ô ảnh (biểu tượng đám mây) hoặc nút <b>"Kết nối Drive"</b> trên thanh công cụ.</span>`;
            spinner.style.display = "none";
            return;
        }

        const folderId = extractFolderId(candidateLinks[0]);
        if (!folderId) {
            previewTitle.innerText = "⚠️ Link ảnh không đúng định dạng Drive";
            spinner.style.display = "none";
            return;
        }

        try {
            const { status, file, isFolder } = await resolveDriveImageFromLinks(candidateLinks, searchCode, token);
            if (reqId !== hoverPreviewReqId) return;

            if (status === 401 || status === 403) {
                if (status === 401) {
                    localStorage.removeItem("gdrive_access_token");
                    localStorage.removeItem("gdrive_token_expires");
                    updateDriveButton();
                }
                previewTitle.innerHTML = `<span class="text-rose-500 font-bold">❌ Lỗi quyền truy cập (${status})</span><br><span class="text-[11px] text-slate-500 font-normal">Kiểm tra: 1) Google Drive API đã bật trong Cloud Console<br>2) Nhấp lại "Kết nối Drive"</span>`;
                spinner.style.display = "none";
                return;
            }

            if (file) {
                // Nếu ô thumbnail của dòng này đang chờ hoặc chưa có ảnh, cập nhật luôn từ kết quả hover
                try {
                    const thumbCell = cell.getRow && cell.getRow().getCell ? cell.getRow().getCell("_thumb") : null;
                    const thumbEl = thumbCell && thumbCell.getElement ? thumbCell.getElement().querySelector(".nevo-thumb-box") : null;
                    if (thumbEl && !thumbEl.querySelector("img") && file.thumbnailLink) {
                        setThumbImage(thumbEl, file.thumbnailLink.replace(/=s\d+$/, `=s${THUMB_SIZE * 3}`), file, token);
                    }
                } catch (e) {}

                if (file.mimeType && file.mimeType.startsWith('image/')) {
                    const cachedBlob = imageCache.get(file.id);
                    if (cachedBlob) {
                        previewImg.src = cachedBlob;
                        previewImg.style.display = "block";
                        spinner.style.display = "none";
                        previewTitle.innerText = `Ảnh: ${file.name}`;
                    } else if (file.thumbnailLink) {
                        const hiResUrl = file.thumbnailLink.replace(/=s\d+$/, '=s800');
                        previewImg.referrerPolicy = "no-referrer";
                        previewImg.onload = () => { previewImg.style.display = "block"; spinner.style.display = "none"; };
                        previewImg.onerror = async () => {
                            const mediaResp = await driveApiFetch(
                                `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`, token
                            );
                            if (mediaResp.ok) {
                                const blob = await mediaResp.blob();
                                const localUrl = URL.createObjectURL(blob);
                                imageCache.set(file.id, localUrl);
                                previewImg.src = localUrl;
                            } else {
                                previewTitle.innerText = "❌ Không thể tải nội dung ảnh";
                                spinner.style.display = "none";
                            }
                        };
                        previewImg.src = hiResUrl;
                        previewTitle.innerText = `Ảnh: ${file.name}`;
                    } else {
                        const mediaResp = await driveApiFetch(
                            `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`, token
                        );
                        if (mediaResp.ok) {
                            const blob = await mediaResp.blob();
                            const localUrl = URL.createObjectURL(blob);
                            imageCache.set(file.id, localUrl);
                            previewImg.src = localUrl;
                            previewImg.onload = () => { previewImg.style.display = "block"; spinner.style.display = "none"; };
                            previewTitle.innerText = `Ảnh: ${file.name}`;
                        } else {
                            previewTitle.innerText = "❌ Không thể tải nội dung ảnh";
                            spinner.style.display = "none";
                        }
                    }
                } else if (file.thumbnailLink) {
                    previewImg.referrerPolicy = "no-referrer";
                    previewImg.src = file.thumbnailLink.replace(/=s\d+$/, '=s800');
                    previewImg.onload = () => { previewImg.style.display = "block"; spinner.style.display = "none"; };
                    previewTitle.innerText = `Ảnh xem trước: ${file.name}`;
                } else {
                    previewTitle.innerText = `⚠️ Tệp "${file.name || ''}" không phải là ảnh`;
                    spinner.style.display = "none";
                }
            } else {
                previewTitle.innerText = isFolder
                    ? `⚠️ Không thấy ảnh chứa mã: ${searchCode.trim()}`
                    : "⚠️ Không tìm thấy tệp ảnh Drive trực tiếp";
                spinner.style.display = "none";
            }
        } catch (err) {
            console.error("❌ Exception:", err);
            previewTitle.innerText = "❌ Lỗi kết nối API Google Drive";
            spinner.style.display = "none";
        }
    }

    // --- THUMBNAIL ẢNH TRONG BẢNG ---
    const THUMB_SIZE = 44;
    const thumbUrlCache = new Map();   // key: links|code -> { url, file } | null (không có ảnh)
    const thumbQueue = [];
    let thumbActive = 0;
    const THUMB_CONCURRENCY = 4;

    function runThumbQueue() {
        while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
            const job = thumbQueue.shift();
            thumbActive++;
            job().catch(() => {}).finally(() => { thumbActive--; runThumbQueue(); });
        }
    }

    function setThumbPlaceholder(el, icon, title) {
        el.innerHTML = `<span class="material-symbols-outlined" style="font-size:20px;color:#cbd5e1;" title="${title}">${icon}</span>`;
    }

    // Ô chưa kết nối Drive / phiên hết hạn: bấm thẳng vào ô để kết nối
    function setThumbConnect(el, title) {
        el.innerHTML = `<span class="material-symbols-outlined" style="font-size:22px;color:#f59e0b;cursor:pointer;" title="${title}">cloud_off</span>`;
        el.style.cursor = "pointer";
        const stop = (e) => e.stopPropagation();
        el.onmousedown = stop;
        el.onpointerdown = stop;
        el.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            connectGoogleDrive();
        };
    }

    function setThumbImage(el, url, fallbackFile, token) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.style.cssText = `width:${THUMB_SIZE}px;height:${THUMB_SIZE}px;object-fit:cover;border-radius:6px;border:1px solid #e2e8f0;background:#f1f5f9;display:block;`;
        let triedFallback = false;
        img.onerror = async () => {
            // Dự phòng: tải trực tiếp nội dung ảnh bằng token nếu thumbnailLink không dùng được
            if (triedFallback || !fallbackFile) { setThumbPlaceholder(el, "broken_image", "Không tải được ảnh"); return; }
            triedFallback = true;
            try {
                let blobUrl = imageCache.get(fallbackFile.id);
                if (!blobUrl) {
                    const resp = await driveApiFetch(`https://www.googleapis.com/drive/v3/files/${fallbackFile.id}?alt=media&supportsAllDrives=true`, token);
                    if (!resp.ok) throw new Error("HTTP " + resp.status);
                    blobUrl = URL.createObjectURL(await resp.blob());
                    imageCache.set(fallbackFile.id, blobUrl);
                }
                img.src = blobUrl;
            } catch (e) { setThumbPlaceholder(el, "broken_image", "Không tải được ảnh"); }
        };
        img.src = url;
        el.innerHTML = "";
        el.appendChild(img);
    }

    async function loadThumbnail(el, linkInput, searchCode) {
        try {
            const token = localStorage.getItem("gdrive_access_token");
            const expires = localStorage.getItem("gdrive_token_expires");
            if (!token || !expires || Date.now() >= parseInt(expires)) {
                setThumbConnect(el, "Chưa kết nối Drive - bấm để kết nối");
                return;
            }
            const links = (Array.isArray(linkInput) ? linkInput : [linkInput])
                .filter(l => l && typeof l === "string" && l.includes("drive.google.com"));
            const ids = links.map(extractFolderId).filter(Boolean);
            if (ids.length === 0) {
                setThumbPlaceholder(el, "image_not_supported", "Link ảnh không đúng định dạng Drive");
                return;
            }

            const key = `${ids.join(",")}|${normalizeCodeStr(searchCode.trim())}`;
            if (thumbUrlCache.has(key)) {
                const cached = thumbUrlCache.get(key);
                if (cached) setThumbImage(el, cached.url, cached.file, token);
                else setThumbPlaceholder(el, "image_not_supported", `Không thấy ảnh chứa mã: ${searchCode.trim()}`);
                return;
            }

            const { status, file } = await resolveDriveImageFromLinks(links, searchCode, token);

            if (status === 401) {
                localStorage.removeItem("gdrive_access_token");
                localStorage.removeItem("gdrive_token_expires");
                updateDriveButton();
                setThumbConnect(el, "Phiên Drive hết hạn - bấm để kết nối lại");
                return;
            }
            if (status !== 200) { setThumbPlaceholder(el, "lock", `Lỗi quyền truy cập (${status})`); return; }

            if (!file || !isImageOrPreviewable(file)) {
                thumbUrlCache.set(key, null);
                setThumbPlaceholder(el, "image_not_supported", `Không thấy ảnh chứa mã: ${searchCode.trim()}`);
                return;
            }
            const url = file.thumbnailLink
                ? file.thumbnailLink.replace(/=s\d+$/, `=s${THUMB_SIZE * 3}`)
                : null;
            if (url) {
                thumbUrlCache.set(key, { url, file });
                setThumbImage(el, url, file, token);
            } else {
                // Không có thumbnailLink -> tải nội dung ảnh
                const resp = await driveApiFetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`, token);
                if (!resp.ok) { setThumbPlaceholder(el, "broken_image", "Không tải được ảnh"); return; }
                const blobUrl = URL.createObjectURL(await resp.blob());
                imageCache.set(file.id, blobUrl);
                thumbUrlCache.set(key, { url: blobUrl, file: null });
                setThumbImage(el, blobUrl, null, token);
            }
        } catch (err) {
            console.error("Thumbnail load error:", err);
            setThumbPlaceholder(el, "broken_image", "Lỗi kết nối khi tải ảnh");
        }
    }

    // Formatter cột thumbnail: ưu tiên link ảnh model, nếu chưa có ảnh thì tự động tìm sang link ảnh trải sàn
    const thumbnailFormatter = function(cell) {
        const rowData = cell.getRow().getData();
        const searchCode = rowData.ma16 || rowData.ma10;
        const candidateLinks = [rowData.linkAnhModel, rowData.linkAnh]
            .filter(l => l && typeof l === "string" && l.includes("drive.google.com"));
        const el = document.createElement("div");
        el.className = "nevo-thumb-box";
        el.style.cssText = `width:${THUMB_SIZE}px;height:${THUMB_SIZE}px;display:flex;align-items:center;justify-content:center;margin:0 auto;`;
        if (!searchCode || candidateLinks.length === 0) {
            setThumbPlaceholder(el, "image", "Chưa có link ảnh Drive");
            return el;
        }
        setThumbPlaceholder(el, "hourglass_top", "Đang tải...");
        thumbQueue.push(() => loadThumbnail(el, candidateLinks, String(searchCode)));
        runThumbQueue();
        return el;
    };

    const tableData = await loadTableData();
    // Auto-migrate old status values ("Chưa có", "Chưa chụp") → "Chưa thực hiện"
    migrateOldStatuses();

    // Helper: tính ngày có ảnh = ngày về kho + N ngày (DD/MM/YYYY)
    function addDaysToDateStr(dateStr, days) {
        if (!dateStr || typeof dateStr !== 'string') return '';
        const parts = dateStr.trim().split('/');
        if (parts.length !== 3) return '';
        const d = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        const y = parseInt(parts[2], 10);
        if (isNaN(d) || isNaN(m) || isNaN(y)) return '';
        const date = new Date(y, m, d);
        date.setDate(date.getDate() + days);
        const dd = String(date.getDate()).padStart(2, '0');
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        return `${dd}/${mm}/${date.getFullYear()}`;
    }

    // Các cột air channels — TẤT CẢ user đều được phép điền
    const AIR_FIELDS = ['airWeb', 'airTiktok', 'airShopee'];

    // Header Menu (chỉ dành cho các cột tuỳ chỉnh do người dùng thêm)
    const customHeaderMenu = [
        {
            label: "Đổi tên cột",
            action: async function(e, column){
                const { value: newName } = await Swal.fire({ title: 'Đổi tên cột', input: 'text', inputValue: column.getDefinition().title, showCancelButton: true });
                if (newName && newName.trim()) {
                    const cleanTitle = newName.trim();
                    setSyncing(true);
                    column.updateDefinition({ title: cleanTitle });
                    // Đồng bộ trong mảng columns cục bộ
                    const field = column.getField();
                    columns.forEach(c => {
                        if (c.field === field) c.title = cleanTitle;
                        if (c.columns) c.columns.forEach(sc => { if (sc.field === field) sc.title = cleanTitle; });
                    });
                    try {
                        const configSnap = await getDoc(doc(db, "settings", SETTINGS_DOC));
                        let cols = configSnap.exists() ? configSnap.data().customColumns || [] : [];
                        let colDef = cols.find(c => c.field === field);
                        if (colDef) colDef.title = cleanTitle;
                        await setDoc(doc(db, "settings", SETTINGS_DOC), { customColumns: cols }, { merge: true });
                    } catch (e) {}
                    setSyncing(false);
                }
            }
        },
        {
            label: "Xoá cột",
            action: async function(e, column){
                const field = column.getField();
                const result = await Swal.fire({ title: 'Xoá cột?', text: `Xoá "${column.getDefinition().title}"?`, icon: 'warning', showCancelButton: true });
                if (result.isConfirmed) {
                    setSyncing(true);
                    column.delete();
                    // Xoá khỏi mảng columns cục bộ để không bị hồi sinh khi thêm cột mới
                    for (let i = columns.length - 1; i >= 0; i--) {
                        if (columns[i].field === field) {
                            columns.splice(i, 1);
                        } else if (columns[i].columns) {
                            columns[i].columns = columns[i].columns.filter(sc => sc.field !== field);
                            if (columns[i].columns.length === 0) columns.splice(i, 1);
                        }
                    }
                    try {
                        const configSnap = await getDoc(doc(db, "settings", SETTINGS_DOC));
                        let cols = configSnap.exists() ? configSnap.data().customColumns || [] : [];
                        cols = cols.filter(c => c.field !== field);
                        await setDoc(doc(db, "settings", SETTINGS_DOC), { customColumns: cols }, { merge: true });
                    } catch (e) {}
                    setSyncing(false);
                }
            }
        }
    ];

    const dateColSorter = function(a, b) {
        return parseDateStrToTimestamp(a) - parseDateStrToTimestamp(b);
    };

    // Base Columns
    let columns = [
        { rowHandle:true, formatter:"handle", headerSort:false, frozen:true, width:30, minWidth:30 },
        { formatter:"rowSelection", titleFormatter:"rowSelection", hozAlign:"center", headerSort:false, width:40, frozen:true },
        { 
            title: "STT", formatter:"rownum", hozAlign:"center", width:50, frozen:true, headerSort:false,
            headerFilter: function() {
                const container = document.createElement("div");
                container.className = "flex justify-center items-center h-full w-full px-1";
                const btn = document.createElement("button");
                btn.innerHTML = `<span class="material-symbols-outlined text-[16px]">filter_alt_off</span>`;
                btn.className = "w-6 h-6 rounded bg-rose-50 text-rose-500 hover:bg-rose-500 hover:text-white transition-all flex items-center justify-center shadow-sm";
                btn.title = "Xóa tất cả bộ lọc";
                btn.onclick = function(e) {
                    e.stopPropagation();
                    table.clearHeaderFilter();
                    table.clearFilter();
                };
                container.appendChild(btn);
                return container;
            }
        },
        { 
            title: "Đợt/Tháng", 
            field: "_monthStr", 
            width: 105, 
            headerFilter: "input", 
            visible: false,
            formatter: function(cell) {
                const rowData = cell.getRow().getData();
                let monthStr = "";
                if (rowData.ngayVeKho && typeof rowData.ngayVeKho === 'string') {
                    const parts = rowData.ngayVeKho.trim().split('/');
                    if (parts.length === 3 && parts[1] && parts[2]) {
                        monthStr = `${parts[1].padStart(2, '0')}-${parts[2].trim()}`;
                    } else if (parts.length === 2 && parts[1]) {
                        const y = (rowData._monthStr ? rowData._monthStr.split('-')[1] : null) || String(new Date().getFullYear());
                        monthStr = `${parts[1].padStart(2, '0')}-${y}`;
                    }
                }
                if (!monthStr) {
                    monthStr = rowData._monthStr || currentMonth || `${String(new Date().getMonth() + 1).padStart(2, '0')}-${new Date().getFullYear()}`;
                }
                const parts = monthStr.split('-');
                return `<span class="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 font-extrabold text-[11px] border border-indigo-100 whitespace-nowrap">T${escapeHtml(parts[0] || '')}/${escapeHtml(parts[1] || '')}</span>`;
            }
        },
        { title: "Mã 10", field: "ma10", editor: "input", width: 120, minWidth: 80, headerFilter: "input" },
        {
            title: "Ảnh", field: "_thumb", formatter: thumbnailFormatter, width: 70, minWidth: 60,
            hozAlign: "center", vertAlign: "middle", headerSort: false, download: false, clipboard: false,
            cellMouseEnter: showImagePreview, cellMouseLeave: hideImagePreview
        },
        { 
            title: "Mã Màu (mã 16)", field: "ma16", editor: "input", width: 140, minWidth: 100, headerFilter: "input",
            cellMouseEnter: showImagePreview, cellMouseLeave: hideImagePreview
        },
        { title: "Phân loại", field: "phanLoai", editor: "input", width: 120, minWidth: 80, headerFilter: "input" },
        { title: "Số lượng về", field: "soLuongVe", editor: "number", sorter: "number", width: 100, minWidth: 80, headerFilter: "input" },
        { 
            title: "Ngày về kho", 
            field: "ngayVeKho", 
            editor: dateEditor, 
            formatter: dateDisplayFormatter, 
            width: 120, 
            minWidth: 100,
            headerFilter: "input",
            sorter: dateColSorter
        },
        {
            title: "Hình ảnh trải sàn",
            columns: [
                { title: "Link Ảnh", field: "linkAnh", editor: "input", width: 130, minWidth: 90, headerFilter: "input",
                    cellMouseEnter: showImagePreview, cellMouseLeave: hideImagePreview, formatter: linkFormatter },
                { title: "Ngày chụp", field: "anhTraiSanNgay", editor: dateEditor, formatter: dateDisplayFormatter, sorter: dateColSorter, width: 105, minWidth: 90, headerFilter: "input" },
                { title: "Ngày có ảnh", field: "anhTraiSanNgayCo", editor: dateEditor, formatter: dateDisplayFormatter, sorter: dateColSorter, width: 115, minWidth: 100, headerFilter: "input",
                    tooltip: "Tự động = Ngày về kho + 7 ngày. Có thể chỉnh tay." },
                { title: "Trạng thái", field: "anhTraiSanTrangThai", editor: "list", editorParams:{values: statusOptions}, formatter: statusFormatter, width: 130, minWidth: 110, headerFilter: "list", headerFilterParams: {values: ["", ...statusOptions]} }
            ]
        },
        {
            title: "Hình ảnh model",
            columns: [
                { title: "Link Ảnh", field: "linkAnhModel", editor: "input", width: 130, minWidth: 90, headerFilter: "input",
                    cellMouseEnter: showImagePreview, cellMouseLeave: hideImagePreview, formatter: linkFormatter },
                { title: "Ngày chụp", field: "anhModelNgay", editor: dateEditor, formatter: dateDisplayFormatter, sorter: dateColSorter, width: 105, minWidth: 90, headerFilter: "input" },
                { title: "Ngày có ảnh", field: "anhModelNgayCo", editor: dateEditor, formatter: dateDisplayFormatter, sorter: dateColSorter, width: 115, minWidth: 100, headerFilter: "input",
                    tooltip: "Tự động = Ngày về kho + 7 ngày. Có thể chỉnh tay." },
                { title: "Trạng thái", field: "anhModelTrangThai", editor: "list", editorParams:{values: statusOptions}, formatter: statusFormatter, width: 130, minWidth: 110, headerFilter: "list", headerFilterParams: {values: ["", ...statusOptions]} }
            ]
        },
        {
            title: "Video model",
            columns: [
                { title: "Link Video", field: "linkVideo", editor: "input", width: 130, minWidth: 90, headerFilter: "input", formatter: linkFormatter },
                { title: "Ngày quay", field: "videoModelNgay", editor: dateEditor, formatter: dateDisplayFormatter, sorter: dateColSorter, width: 105, minWidth: 90, headerFilter: "input" },
                { title: "Trạng thái", field: "videoModelTrangThai", editor: "list", editorParams:{values: statusOptions}, formatter: statusFormatter, width: 130, minWidth: 110, headerFilter: "list", headerFilterParams: {values: ["", ...statusOptions]} }
            ]
        },
        {
            title: "Ngày air các kênh",
            columns: [
                { title: "Web",    field: "airWeb",    editor: dateEditor, formatter: dateDisplayFormatter, sorter: dateColSorter, width: 100, minWidth: 80, headerFilter: "input" },
                { title: "Tiktok", field: "airTiktok", editor: dateEditor, formatter: dateDisplayFormatter, sorter: dateColSorter, width: 100, minWidth: 80, headerFilter: "input" },
                { title: "Shopee", field: "airShopee", editor: dateEditor, formatter: dateDisplayFormatter, sorter: dateColSorter, width: 100, minWidth: 80, headerFilter: "input" }
            ]
        },
        { title: "Ghi chú", field: "ghiChu", editor: "textarea", width: 250, minWidth: 120, headerFilter: "input" }
    ];

    // Load custom columns từ Firebase (hỗ trợ cả cột đơn và cột thuộc nhóm)
    customCols.forEach(col => {
        const colDef = { title: col.title, field: col.field, editor: "input", headerFilter: "input", width: 150, headerMenu: isUser ? [] : customHeaderMenu };
        if (col.group) {
            const groupCol = columns.find(c => c.title === col.group && c.columns);
            if (groupCol) {
                groupCol.columns.push(colDef);
            } else {
                const ghiChuIdx = columns.findIndex(c => c.field === 'ghiChu');
                const newGroup = { title: col.group, columns: [colDef] };
                if (ghiChuIdx > -1) columns.splice(ghiChuIdx, 0, newGroup);
                else columns.push(newGroup);
            }
        } else {
            const ghiChuIdx = columns.findIndex(c => c.field === 'ghiChu');
            if (ghiChuIdx > -1) columns.splice(ghiChuIdx, 0, colDef);
            else columns.push(colDef);
        }
    });

    if (isUser) {
        const disableEditing = (cols) => {
            cols.forEach(c => {
                if (c.columns) {
                    if (!isViewer && c.title === 'Ngày air các kênh') return;
                    disableEditing(c.columns);
                } else {
                    if (!isViewer && AIR_FIELDS.includes(c.field)) return;
                    c.editor = false;
                    c.headerMenu = [];
                }
            });
        };
        disableEditing(columns);
    }

    // Setup Tabulator (removed column/row localStorage persistence so custom column renames/deletes take effect cleanly)
    table = new Tabulator("#products-table", {
        data: tableData,
        index: "id",
        layout: "fitColumns",
        height: "100%", 
        history: true, 
        clipboard: isUser ? "copy" : true,
        selectable: "highlight",
        reactiveData: true,
        rowFormatter: rowColorFormatter,
        movableColumns: true, 
        movableRows: !isUser,
        headerWordWrap: true,
        columns: columns,
    });
    updateStats(tableData);

    // Tracking last cell for pasting
    let lastClickedCell = null;
    table.on("cellClick", function(e, cell) { lastClickedCell = cell; });
    table.on("cellEditing", function(cell) { cell.getRow().deselect(); });
    table.on("dataLoaded", updateStats);
    table.on("dataChanged", updateStats);
    table.on("dataFiltered", function(filters, rows) {
        const data = rows.map(r => r.getData());
        updateStats(data);
    });

    // --- FILL DOWN (Alt/Option + Drag) ---
    let fillSource = null;
    let fillField = null;
    let fillActive = false;
    let fillTargets = [];

    table.on("cellMouseDown", function(e, cell) {
        if (isUser) return;
        const fld = cell.getField();
        if (e.altKey && fld && !['_thumb', '_monthStr'].includes(fld)) {
            e.preventDefault();
            fillSource = cell;
            fillField = fld;
            fillActive = true;
            fillTargets = [];
            cell.getElement().style.outline = "2px solid #6366f1";
            cell.getElement().style.boxShadow = "0 0 8px rgba(99,102,241,0.3)";
        }
    });

    table.on("cellMouseOver", function(e, cell) {
        if (!fillActive || !fillSource || cell.getField() !== fillField) return;
        if (cell === fillSource) return;
        const already = fillTargets.find(c => c.getRow().getData().id === cell.getRow().getData().id);
        if (!already) {
            fillTargets.push(cell);
            cell.getElement().style.outline = "2px dashed #6366f1";
            cell.getElement().style.backgroundColor = "rgba(99,102,241,0.06)";
        }
    });

    document.addEventListener("mouseup", async function() {
        if (!fillActive || !fillSource) return;
        const sourceValue = fillSource.getValue();
        fillSource.getElement().style.outline = "";
        fillSource.getElement().style.boxShadow = "";

        if (fillTargets.length > 0) {
            setSyncing(true);
            for (const cell of fillTargets) {
                cell.getElement().style.outline = "";
                cell.getElement().style.backgroundColor = "";
                cell.setValue(sourceValue);
                const r = cell.getRow();
                const d = r.getData();
                const f = cell.getField();
                if (d.id) {
                    const targetCollection = d._collectionName || COLLECTION_NAME;
                    const normalizedVal = f === 'soLuongVe' ? (Number(sourceValue) || 0) : (sourceValue ?? "");
                    const payload = {
                        [f]: normalizedVal,
                        updatedAt: serverTimestamp()
                    };
                    if (f === 'ngayVeKho') {
                        const newNgayCo = sourceValue ? addDaysToDateStr(sourceValue, 7) : "";
                        const tc = r.getCell('anhTraiSanNgayCo');
                        const mc = r.getCell('anhModelNgayCo');
                        if (tc) tc.setValue(newNgayCo);
                        if (mc) mc.setValue(newNgayCo);
                        payload.anhTraiSanNgayCo = newNgayCo;
                        payload.anhModelNgayCo = newNgayCo;
                    }
                    try {
                        await updateDoc(doc(db, targetCollection, d.id), payload);
                    } catch (err) { console.error(err); }
                    r.reformat();
                }
            }
            setSyncing(false);
        }
        fillSource = null;
        fillField = null;
        fillActive = false;
        fillTargets = [];
    });

    // --- FIREBASE SYNC (Inline Edit + Undo/Redo + Clipboard Paste) ---
    async function persistCellChange(cell) {
        if (isViewer) return;
        const row = cell.getRow();
        const data = row.getData();
        const field = cell.getField();
        const value = cell.getValue();
        if (!field || ['_thumb', '_monthStr'].includes(field)) return;
        if (isUser && !AIR_FIELDS.includes(field)) return;

        const cleanValue = field === 'soLuongVe'
            ? (value === '' || value === null || value === undefined ? 0 : (Number(value) || 0))
            : (value ?? "");

        const updatePayload = {
            [field]: cleanValue,
            updatedAt: serverTimestamp()
        };

        if (field === 'ngayVeKho') {
            const newNgayCo = value ? addDaysToDateStr(String(value), 7) : "";
            const traiSanCell = row.getCell('anhTraiSanNgayCo');
            const modelCell   = row.getCell('anhModelNgayCo');
            if (traiSanCell) traiSanCell.setValue(newNgayCo);
            if (modelCell)   modelCell.setValue(newNgayCo);
            updatePayload.anhTraiSanNgayCo = newNgayCo;
            updatePayload.anhModelNgayCo = newNgayCo;
        }

        if (data.id) {
            setSyncing(true);
            const targetCollection = data._collectionName || COLLECTION_NAME;
            try {
                await updateDoc(doc(db, targetCollection, data.id), updatePayload);
            } catch (err) { console.error(err); }
            row.reformat();
            setSyncing(false);
        }
    }

    table.on("cellEdited", persistCellChange);
    table.on("historyUndo", function(action, component) {
        if (action === "cellEdit" && component) persistCellChange(component);
    });
    table.on("historyRedo", function(action, component) {
        if (action === "cellEdit" && component) persistCellChange(component);
    });
    table.on("clipboardPasted", async function(clipboard, rowData, rows) {
        if (isUser || !Array.isArray(rows) || rows.length === 0) return;
        setSyncing(true);
        try {
            const targetColl = COLLECTION_NAME || `new_products_${currentMonth}`;
            for (const row of rows) {
                const d = { ...row.getData() };
                const existingId = d.id;
                delete d.id;
                delete d._collectionName;
                delete d._monthStr;
                delete d._thumb;
                d.updatedAt = serverTimestamp();
                if (existingId) {
                    await updateDoc(doc(db, row.getData()._collectionName || targetColl, existingId), d);
                } else {
                    d.createdAt = serverTimestamp();
                    const ref = await addDoc(collection(db, targetColl), d);
                    row.update({ id: ref.id, _collectionName: targetColl, _monthStr: currentMonth });
                }
            }
            updateStats(table.getData());
        } catch (err) {
            console.error("Clipboard paste sync error:", err);
        }
        setSyncing(false);
    });

    // --- BUTTON LISTENERS ---
    
    // Add Row (respects currently selected month in 'month' view)
    document.getElementById("btn-add-row").addEventListener("click", async () => {
        if (isUser) return;
        setSyncing(true);
        try {
            const now = new Date();
            const realM = String(now.getMonth() + 1).padStart(2, '0');
            const realY = String(now.getFullYear());
            const activeMonthStr = (currentViewMode === 'month' && currentMonth) ? currentMonth : `${realM}-${realY}`;
            const [selM, selY] = activeMonthStr.split('-');
            const targetCollection = `new_products_${activeMonthStr}`;

            const arrivalStr = (selM === realM && selY === realY)
                ? `${String(now.getDate()).padStart(2, '0')}/${realM}/${realY}`
                : `01/${selM}/${selY}`;
            const defaultNgayCo = addDaysToDateStr(arrivalStr, 7);
            
            const newDoc = {
                ma10: "", ma16: "", phanLoai: "", soLuongVe: 0,
                ngayVeKho: arrivalStr, linkAnh: "", linkAnhModel: "", linkVideo: "",
                anhTraiSanNgay: "", anhTraiSanNgayCo: defaultNgayCo, anhTraiSanTrangThai: "Chưa thực hiện",
                anhModelNgay: "", anhModelNgayCo: defaultNgayCo, anhModelTrangThai: "Chưa thực hiện",
                videoModelNgay: "", videoModelTrangThai: "Chưa thực hiện",
                airWeb: "", airTiktok: "", airShopee: "",
                ghiChu: "",
                createdAt: serverTimestamp()
            };
            const docRef = await addDoc(collection(db, targetCollection), newDoc);
            table.addRow({ id: docRef.id, _collectionName: targetCollection, _monthStr: activeMonthStr, ...newDoc }, true);
            updateStats(table.getData());
        } catch (err) { console.error(err); }
        setSyncing(false);
    });

    // Add Custom Column (hỗ trợ chọn nhóm hoặc cột đơn)
    document.getElementById("btn-add-col").addEventListener("click", async () => {
        if (isUser) return;

        // Lấy danh sách nhóm hiện có
        const existingGroups = columns
            .filter(c => c.columns && c.title)
            .map(c => c.title);

        const groupOptionsHtml = [
            `<option value="">— Cột đơn (không thuộc nhóm) —</option>`,
            ...existingGroups.map(g => `<option value="${g}">${g}</option>`),
            `<option value="__new__">✨ Tạo nhóm mới...</option>`
        ].join('');

        const { value: formValues } = await Swal.fire({
            title: 'Thêm cột mới',
            width: '460px',
            html: `
                <div style="text-align:left;display:flex;flex-direction:column;gap:14px;margin-top:4px">
                    <div>
                        <label style="font-size:13px;font-weight:700;color:#475569;display:block;margin-bottom:4px">Tên cột</label>
                        <input id="swal-col-name" class="swal2-input" style="margin:0;width:100%;box-sizing:border-box" placeholder="Nhập tên cột...">
                    </div>
                    <div>
                        <label style="font-size:13px;font-weight:700;color:#475569;display:block;margin-bottom:4px">Thuộc nhóm</label>
                        <select id="swal-col-group" class="swal2-select" style="margin:0;width:100%;box-sizing:border-box">${groupOptionsHtml}</select>
                    </div>
                    <div id="swal-new-group-wrap" style="display:none">
                        <label style="font-size:13px;font-weight:700;color:#475569;display:block;margin-bottom:4px">Tên nhóm mới</label>
                        <input id="swal-new-group-name" class="swal2-input" style="margin:0;width:100%;box-sizing:border-box" placeholder="Nhập tên nhóm mới...">
                    </div>
                </div>
            `,
            showCancelButton: true,
            confirmButtonText: 'Thêm cột',
            cancelButtonText: 'Hủy',
            didOpen: () => {
                document.getElementById('swal-col-group').addEventListener('change', (ev) => {
                    const wrap = document.getElementById('swal-new-group-wrap');
                    wrap.style.display = ev.target.value === '__new__' ? 'block' : 'none';
                });
            },
            preConfirm: () => {
                const name = document.getElementById('swal-col-name').value.trim();
                const group = document.getElementById('swal-col-group').value;
                const newGroupName = (document.getElementById('swal-new-group-name') || {}).value?.trim() || '';
                if (!name) { Swal.showValidationMessage('Vui lòng nhập tên cột'); return false; }
                if (group === '__new__' && !newGroupName) { Swal.showValidationMessage('Vui lòng nhập tên nhóm mới'); return false; }
                return { name, group: group === '__new__' ? newGroupName : group };
            }
        });

        if (formValues) {
            setSyncing(true);
            const { name: colName, group: colGroup } = formValues;
            const field = "custom_" + Date.now();
            const newColDef = { title: colName, field: field, editor: "input", headerFilter: "input", width: 150, headerMenu: customHeaderMenu };

            try {
                if (colGroup) {
                    const groupCol = columns.find(c => c.title === colGroup && c.columns);
                    if (groupCol) {
                        groupCol.columns.push({...newColDef});
                    } else {
                        const ghiChuIdx = columns.findIndex(c => c.field === 'ghiChu');
                        const newGroup = { title: colGroup, columns: [{...newColDef}] };
                        if (ghiChuIdx > -1) columns.splice(ghiChuIdx, 0, newGroup);
                        else columns.push(newGroup);
                    }
                } else {
                    const ghiChuIdx = columns.findIndex(c => c.field === 'ghiChu');
                    if (ghiChuIdx > -1) columns.splice(ghiChuIdx, 0, {...newColDef});
                    else columns.push({...newColDef});
                }

                table.setColumns(columns);

                const configSnap = await getDoc(doc(db, "settings", SETTINGS_DOC));
                let cols = configSnap.exists() ? configSnap.data().customColumns || [] : [];
                cols.push({ title: colName, field: field, group: colGroup || null });
                await setDoc(doc(db, "settings", SETTINGS_DOC), { customColumns: cols }, { merge: true });
                Swal.fire('Thành công', colGroup
                    ? `Đã thêm cột "${colName}" vào nhóm "${colGroup}". Áp dụng cho mọi tháng.`
                    : `Đã thêm cột "${colName}". Áp dụng cho mọi tháng.`, 'success');
            } catch (e) { console.error(e); Swal.fire('Lỗi', 'Không thể thêm cột: ' + e.message, 'error'); }
            setSyncing(false);
        }
    });

    // Manage Statuses (no nested Swal.fire that closes modal)
    document.getElementById("btn-manage-status").addEventListener("click", async () => {
        if (isUser) return;
        let tempStatuses = [...statusOptions];
        let tempColors = {...statusColors};

        const renderList = () => {
            let html = '<div id="status-inline-error" class="hidden mb-2 p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-600 text-xs font-bold"></div>';
            html += '<div class="space-y-3 max-h-[60vh] overflow-y-auto px-1">';
            tempStatuses.forEach((s, i) => {
                const escS = escapeHtml(s);
                const safeCol = /^#[0-9a-fA-F]{6}$/.test(tempColors[s] || '') ? tempColors[s] : '#e2e8f0';
                html += `
                    <div class="flex items-center gap-2 bg-slate-50 p-2 rounded-lg border border-slate-100 mb-2">
                        <div class="flex flex-col">
                            <button type="button" class="btn-move-up text-slate-400 hover:text-indigo-600 disabled:opacity-30" data-index="${i}" ${i === 0 ? 'disabled' : ''}>
                                <span class="material-symbols-outlined text-[20px]">expand_less</span>
                            </button>
                            <button type="button" class="btn-move-down text-slate-400 hover:text-indigo-600 disabled:opacity-30" data-index="${i}" ${i === tempStatuses.length - 1 ? 'disabled' : ''}>
                                <span class="material-symbols-outlined text-[20px]">expand_more</span>
                            </button>
                        </div>
                        <input type="text" value="${escS}" class="status-name-input flex-grow px-3 py-1.5 rounded border border-slate-200 text-sm font-medium" data-index="${i}" placeholder="Tên trạng thái">
                        <input type="color" value="${safeCol}" class="status-color-input w-10 h-8 p-0 border-none cursor-pointer rounded" data-index="${i}">
                        <button type="button" class="btn-remove-status text-rose-500 hover:bg-rose-50 p-1.5 rounded transition-all flex items-center justify-center" data-index="${i}">
                            <span class="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                    </div>
                `;
            });
            html += '</div>';
            html += `
                <button type="button" id="btn-add-status-item" class="mt-4 w-full py-2 border-2 border-dashed border-slate-200 rounded-lg text-slate-500 hover:border-indigo-400 hover:text-indigo-500 transition-all font-bold flex items-center justify-center gap-2 text-sm">
                    <span class="material-symbols-outlined text-[18px]">add</span>
                    Thêm trạng thái mới
                </button>
            `;
            return html;
        };

        const { value: confirmed } = await Swal.fire({
            title: 'Quản lý Trạng thái',
            html: `<div id="status-manager-container">${renderList()}</div>`,
            showCancelButton: true,
            confirmButtonText: 'Lưu thay đổi',
            cancelButtonText: 'Hủy',
            width: '480px',
            focusConfirm: false,
            didOpen: () => {
                const container = document.getElementById('status-manager-container');
                const showInlineErr = (msg) => {
                    const errEl = document.getElementById('status-inline-error');
                    if (!errEl) return;
                    errEl.textContent = msg;
                    errEl.classList.remove('hidden');
                    setTimeout(() => errEl.classList.add('hidden'), 3200);
                };
                
                const attachEvents = () => {
                    container.querySelectorAll('.status-name-input').forEach(input => {
                        input.addEventListener('change', (e) => {
                            const idx = Number(e.target.dataset.index);
                            const oldName = tempStatuses[idx];
                            const newName = e.target.value.trim();
                            if (newName && !tempStatuses.includes(newName)) {
                                tempStatuses[idx] = newName;
                                if (tempColors[oldName]) {
                                    tempColors[newName] = tempColors[oldName];
                                    delete tempColors[oldName];
                                }
                            } else if (newName !== oldName) {
                                showInlineErr('Tên trạng thái đã tồn tại hoặc không hợp lệ.');
                                e.target.value = oldName;
                            }
                        });
                    });

                    container.querySelectorAll('.status-color-input').forEach(input => {
                        input.addEventListener('change', (e) => {
                            const idx = Number(e.target.dataset.index);
                            const name = tempStatuses[idx];
                            tempColors[name] = e.target.value;
                        });
                    });

                    container.querySelectorAll('.btn-move-up').forEach(btn => {
                        btn.addEventListener('click', (e) => {
                            const idx = parseInt(e.currentTarget.dataset.index, 10);
                            if (idx > 0) {
                                [tempStatuses[idx], tempStatuses[idx-1]] = [tempStatuses[idx-1], tempStatuses[idx]];
                                container.innerHTML = renderList();
                                attachEvents();
                            }
                        });
                    });

                    container.querySelectorAll('.btn-move-down').forEach(btn => {
                        btn.addEventListener('click', (e) => {
                            const idx = parseInt(e.currentTarget.dataset.index, 10);
                            if (idx < tempStatuses.length - 1) {
                                [tempStatuses[idx], tempStatuses[idx+1]] = [tempStatuses[idx+1], tempStatuses[idx]];
                                container.innerHTML = renderList();
                                attachEvents();
                            }
                        });
                    });

                    container.querySelectorAll('.btn-remove-status').forEach(btn => {
                        btn.addEventListener('click', (e) => {
                            if (tempStatuses.length <= 1) {
                                showInlineErr('Cần giữ lại ít nhất 1 trạng thái.');
                                return;
                            }
                            const idx = Number(e.currentTarget.dataset.index);
                            const name = tempStatuses[idx];
                            tempStatuses.splice(idx, 1);
                            delete tempColors[name];
                            container.innerHTML = renderList();
                            attachEvents();
                        });
                    });

                    document.getElementById('btn-add-status-item').onclick = () => {
                        let suffix = tempStatuses.length + 1;
                        let newName = "Trạng thái mới " + suffix;
                        while (tempStatuses.includes(newName)) {
                            suffix++;
                            newName = "Trạng thái mới " + suffix;
                        }
                        tempStatuses.push(newName);
                        tempColors[newName] = "#e2e8f0";
                        container.innerHTML = renderList();
                        attachEvents();
                    };
                };

                attachEvents();
            }
        });

        if (confirmed) {
            setSyncing(true);
            statusOptions.length = 0;
            statusOptions.push(...tempStatuses);
            statusColors = tempColors;

            try {
                await setDoc(doc(db, "settings", SETTINGS_DOC), { 
                    statusOptions: statusOptions,
                    statusColors: statusColors 
                }, { merge: true });

                table.getColumns(true).forEach(col => {
                    const field = col.getField();
                    if (["anhTraiSanTrangThai", "anhModelTrangThai", "videoModelTrangThai"].includes(field)) {
                        col.updateDefinition({
                            editorParams: { values: [...statusOptions] },
                            headerFilterParams: { values: ["", ...statusOptions] }
                        });
                    }
                });
                
                table.redraw(true);
                Swal.fire('Thành công', 'Đã cập nhật danh sách trạng thái.', 'success');
            } catch (e) {
                console.error(e);
                Swal.fire('Lỗi', 'Không thể lưu cài đặt.', 'error');
            }
            setSyncing(false);
        }
    });

    // Manually Color Rows (Clearing color restores automatic status coloring)
    document.getElementById("btn-color-row").addEventListener("click", async () => {
        if (isUser) return;
        const selectedRows = table.getSelectedRows();
        if (selectedRows.length === 0) return Swal.fire('Chú ý', 'Chọn các dòng (ô vuông đầu dòng) để tô màu.', 'warning');

        const { value: color } = await Swal.fire({
            title: 'Chọn màu nền',
            input: 'select',
            inputOptions: {
                '__clear__': 'Trắng (Xoá màu thủ công — về tự động theo trạng thái)',
                '#dcfce7': 'Xanh nhạt (Hoàn tất)',
                '#fef08a': 'Vàng nhạt (Đang xử lý)',
                '#fecaca': 'Đỏ nhạt (Lỗi/Khẩn cấp)',
                '#e2e8f0': 'Xám (Bỏ qua)'
            },
            inputPlaceholder: 'Chọn màu',
            showCancelButton: true
        });

        if (color) {
            setSyncing(true);
            const isClear = color === '__clear__' || color === '#ffffff';
            const promises = [];
            for (const row of selectedRows) {
                const data = row.getData();
                if (data.id) {
                    const targetCollection = data._collectionName || COLLECTION_NAME;
                    promises.push(updateDoc(doc(db, targetCollection, data.id), {
                        rowColor: isClear ? deleteField() : color
                    }));
                    row.update({ rowColor: isClear ? "" : color });
                }
            }
            await Promise.all(promises);
            table.deselectRow(); 
            table.redraw(true); 
            setSyncing(false);
        }
    });

    // Connect Drive Listener
    document.getElementById("btn-connect-drive").addEventListener("click", () => connectGoogleDrive(false, false));

    // Helper: normalize Excel cell value / Date to DD/MM/YYYY string for date columns
    function normalizeImportedDate(val) {
        if (val === null || val === undefined || val === '') return '';
        if (val instanceof Date && !isNaN(val.getTime())) {
            const dd = String(val.getDate()).padStart(2, '0');
            const mm = String(val.getMonth() + 1).padStart(2, '0');
            return `${dd}/${mm}/${val.getFullYear()}`;
        }
        const s = String(val).trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
            const [y, m, d] = s.slice(0, 10).split('-');
            return `${d}/${m}/${y}`;
        }
        if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
            const [d, m, y] = s.split('/');
            return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
        }
        return s;
    }

    // Import Logic (Supports both .xlsx and .csv with Vietnamese & field-key header mapping)
    document.getElementById("btn-import-trigger").addEventListener("click", () => {
        if (isUser) return;
        document.getElementById("file-import-csv").click();
    });

    document.getElementById("file-import-csv").addEventListener("change", async (e) => {
        if (isUser) return;
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;

        const targetMonth = currentMonth || `${String(new Date().getMonth() + 1).padStart(2, '0')}-${new Date().getFullYear()}`;
        const targetColl = `new_products_${targetMonth}`;

        const result = await Swal.fire({
            title: 'Nhập dữ liệu Excel / CSV',
            text: `Bạn muốn nhập dữ liệu từ "${file.name}" vào tháng ${targetMonth}?`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Nhập ngay',
            cancelButtonText: 'Hủy'
        });

        if (!result.isConfirmed) return;

        setSyncing(true);
        try {
            const buffer = await file.arrayBuffer();
            const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const jsonRows = XLSX.utils.sheet_to_json(ws, { defval: '' });

            if (!jsonRows.length) {
                Swal.fire('File rỗng', 'Không tìm thấy dòng dữ liệu nào trong file.', 'warning');
                setSyncing(false);
                return;
            }

            // Build flexible header map (Vietnamese titles + internal field keys + custom columns)
            const headerAliasMap = {
                'ma10': 'ma10', 'mã 10': 'ma10', 'ma 10': 'ma10', 'mã sp': 'ma10', 'ma sp': 'ma10',
                'ma16': 'ma16', 'mã màu (mã 16)': 'ma16', 'mã màu': 'ma16', 'ma mau': 'ma16', 'mã 16': 'ma16', 'ma 16': 'ma16',
                'phanloai': 'phanLoai', 'phân loại': 'phanLoai', 'phan loai': 'phanLoai', 'tên sản phẩm': 'phanLoai', 'ten san pham': 'phanLoai',
                'soluongve': 'soLuongVe', 'số lượng về': 'soLuongVe', 'so luong ve': 'soLuongVe', 'số lượng': 'soLuongVe', 'sl': 'soLuongVe',
                'ngayvekho': 'ngayVeKho', 'ngày về kho': 'ngayVeKho', 'ngay ve kho': 'ngayVeKho', 'ngày về kho media': 'ngayVeKho',
                'linkanh': 'linkAnh', 'link ảnh': 'linkAnh', 'link anh': 'linkAnh', 'link ảnh trải sàn': 'linkAnh',
                'anhtraisangay': 'anhTraiSanNgay', 'anhtraisannngay': 'anhTraiSanNgay', 'ngày chụp trải sàn': 'anhTraiSanNgay',
                'anhtraisangayco': 'anhTraiSanNgayCo', 'ngày có ảnh trải sàn': 'anhTraiSanNgayCo',
                'anhtraisantrangthai': 'anhTraiSanTrangThai', 'trạng thái trải sàn': 'anhTraiSanTrangThai',
                'linkanhmodel': 'linkAnhModel', 'link ảnh model': 'linkAnhModel', 'link anh model': 'linkAnhModel',
                'anhmodelngay': 'anhModelNgay', 'ngày chụp model': 'anhModelNgay',
                'anhmodelngayco': 'anhModelNgayCo', 'ngày có ảnh model': 'anhModelNgayCo',
                'anhmodeltrangthai': 'anhModelTrangThai', 'trạng thái model': 'anhModelTrangThai',
                'linkvideo': 'linkVideo', 'link video': 'linkVideo', 'link video model': 'linkVideo',
                'videomodelngay': 'videoModelNgay', 'ngày quay': 'videoModelNgay', 'ngay quay': 'videoModelNgay',
                'videomodeltrangthai': 'videoModelTrangThai', 'trạng thái video': 'videoModelTrangThai',
                'airweb': 'airWeb', 'web': 'airWeb', 'ngày air web': 'airWeb',
                'airtiktok': 'airTiktok', 'tiktok': 'airTiktok', 'ngày air tiktok': 'airTiktok',
                'airshopee': 'airShopee', 'shopee': 'airShopee', 'ngày air shopee': 'airShopee',
                'ghichu': 'ghiChu', 'ghi chú': 'ghiChu', 'ghi chu': 'ghiChu', 'note': 'ghiChu'
            };

            customCols.forEach(cc => {
                if (cc.title && cc.field) {
                    headerAliasMap[cc.title.trim().toLowerCase()] = cc.field;
                    headerAliasMap[cc.field.toLowerCase()] = cc.field;
                }
            });

            const DATE_FIELDS = new Set([
                'ngayVeKho', 'anhTraiSanNgay', 'anhTraiSanNgayCo',
                'anhModelNgay', 'anhModelNgayCo', 'videoModelNgay',
                'airWeb', 'airTiktok', 'airShopee'
            ]);

            let addedCount = 0;
            const addedUiRows = [];

            for (const raw of jsonRows) {
                const mapped = {
                    ma10: '', ma16: '', phanLoai: '', soLuongVe: 0,
                    ngayVeKho: '', linkAnh: '', linkAnhModel: '', linkVideo: '',
                    anhTraiSanNgay: '', anhTraiSanNgayCo: '', anhTraiSanTrangThai: 'Chưa thực hiện',
                    anhModelNgay: '', anhModelNgayCo: '', anhModelTrangThai: 'Chưa thực hiện',
                    videoModelNgay: '', videoModelTrangThai: 'Chưa thực hiện',
                    airWeb: '', airTiktok: '', airShopee: '', ghiChu: ''
                };

                let hasContent = false;
                for (const [rawKey, rawVal] of Object.entries(raw)) {
                    const normKey = String(rawKey || '').trim().toLowerCase();
                    if (!normKey || normKey === 'stt' || normKey === 'id' || normKey === 'ảnh') continue;
                    const field = headerAliasMap[normKey] || (rawKey in mapped ? rawKey : null);
                    if (!field) continue;

                    if (field === 'soLuongVe') {
                        const n = parseInt(String(rawVal).replace(/[^0-9-]/g, ''), 10) || 0;
                        mapped.soLuongVe = n;
                        if (n > 0) hasContent = true;
                    } else if (DATE_FIELDS.has(field)) {
                        const dStr = normalizeImportedDate(rawVal);
                        mapped[field] = dStr;
                        if (dStr) hasContent = true;
                    } else {
                        const strVal = String(rawVal ?? '').trim();
                        if (strVal) {
                            mapped[field] = strVal;
                            hasContent = true;
                        }
                    }
                }

                if (!hasContent) continue;

                // Auto-calculate Ngày có ảnh = Ngày về kho + 7 ngày when blank
                if (mapped.ngayVeKho) {
                    const autoNgayCo = addDaysToDateStr(mapped.ngayVeKho, 7);
                    if (!mapped.anhTraiSanNgayCo) mapped.anhTraiSanNgayCo = autoNgayCo;
                    if (!mapped.anhModelNgayCo) mapped.anhModelNgayCo = autoNgayCo;
                }

                mapped.createdAt = serverTimestamp();
                const docRef = await addDoc(collection(db, targetColl), mapped);
                addedUiRows.push({
                    id: docRef.id,
                    _collectionName: targetColl,
                    _monthStr: targetMonth,
                    ...mapped
                });
                addedCount++;
            }

            if (addedUiRows.length > 0 && table) {
                await table.addData(addedUiRows, true);
                updateStats(table.getData());
            }
            Swal.fire('Thành công!', `Đã nhập chính xác ${addedCount} dòng sản phẩm vào tháng ${targetMonth}.`, 'success');
        } catch (err) {
            console.error("Import error:", err);
            Swal.fire('Lỗi đọc file', err.message || 'Định dạng file không hợp lệ.', 'error');
        }
        setSyncing(false);
    });

    // Cross-Module Sync: Push selected product rows directly into a Creative Order (NV-xxxx)
    const createOrderBtn = document.getElementById("btn-create-order-from-products");
    if (createOrderBtn) {
        createOrderBtn.addEventListener("click", async () => {
            if (isViewer) {
                Swal.fire('Từ chối', 'Tài khoản Người xem không có quyền tạo đơn hàng.', 'warning');
                return;
            }
            const selectedRows = table.getSelectedRows();
            if (selectedRows.length === 0) {
                Swal.fire('Chưa chọn sản phẩm', 'Hãy tích chọn ít nhất 1 dòng sản phẩm (ô vuông đầu dòng) để tạo đơn sản xuất Creative.', 'info');
                return;
            }

            const items = selectedRows.map(r => r.getData());
            const sampleCodes = items.map(x => x.ma10 || x.ma16).filter(Boolean).slice(0, 4).join(', ');
            const defaultTitle = `Sản xuất Media SP mới (${items.length} mã${sampleCodes ? ': ' + sampleCodes : ''})`;
            const plus7 = new Date();
            plus7.setDate(plus7.getDate() + 7);
            const defaultDeadline = buildLocalYMD(plus7.getFullYear(), plus7.getMonth() + 1, plus7.getDate());
            const defaultDept = localStorage.getItem('nevo_dept') || 'Ngành hàng';

            const { value: orderForm } = await Swal.fire({
                title: `🎬 Tạo đơn Creative (${items.length} SP)`,
                width: '520px',
                html: `
                    <div style="text-align:left;display:flex;flex-direction:column;gap:12px;margin-top:6px">
                        <div>
                            <label style="font-size:12px;font-weight:700;color:#475569;display:block;margin-bottom:4px">Tiêu đề đơn hàng *</label>
                            <input id="swal-ord-title" class="swal2-input" style="margin:0;width:100%;box-sizing:border-box;font-size:13px" value="${escapeHtml(defaultTitle)}">
                        </div>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                            <div>
                                <label style="font-size:12px;font-weight:700;color:#475569;display:block;margin-bottom:4px">Thể loại sản xuất *</label>
                                <select id="swal-ord-cat" class="swal2-select" style="margin:0;width:100%;box-sizing:border-box;font-size:13px">
                                    <option value="Hình Ảnh">Hình Ảnh (Model + Trải sàn)</option>
                                    <option value="Video">Video Model</option>
                                    <option value="Livestream">Livestream</option>
                                    <option value="Giả Live">Giả Live</option>
                                    <option value="Thiết kế">Thiết kế</option>
                                </select>
                            </div>
                            <div>
                                <label style="font-size:12px;font-weight:700;color:#475569;display:block;margin-bottom:4px">Deadline bàn giao *</label>
                                <input id="swal-ord-deadline" type="date" class="swal2-input" style="margin:0;width:100%;box-sizing:border-box;font-size:13px" value="${defaultDeadline}">
                            </div>
                        </div>
                        <div>
                            <label style="font-size:12px;font-weight:700;color:#475569;display:block;margin-bottom:4px">Phòng ban yêu cầu</label>
                            <input id="swal-ord-dept" class="swal2-input" style="margin:0;width:100%;box-sizing:border-box;font-size:13px" value="${escapeHtml(defaultDept)}">
                        </div>
                        <p style="font-size:11px;color:#64748b;margin:0">✨ Khi đơn Creative được đánh dấu <b>Hoàn thành</b> hoặc <b>Duyệt Final</b>, trạng thái Ảnh/Video và Link sản phẩm sẽ tự động đồng bộ ngược về các dòng sản phẩm này!</p>
                    </div>
                `,
                showCancelButton: true,
                confirmButtonText: 'Khởi tạo đơn NV-xxxx',
                confirmButtonColor: '#b80035',
                cancelButtonText: 'Hủy',
                preConfirm: () => {
                    const title = document.getElementById('swal-ord-title').value.trim();
                    const category = document.getElementById('swal-ord-cat').value;
                    const deadline = document.getElementById('swal-ord-deadline').value;
                    const department = document.getElementById('swal-ord-dept').value.trim() || 'Ngành hàng';
                    if (!title || !deadline) {
                        Swal.showValidationMessage('Vui lòng nhập đủ Tiêu đề và Deadline.');
                        return false;
                    }
                    return { title, category, deadline, department };
                }
            });

            if (!orderForm) return;

            setSyncing(true);
            try {
                const requester = localStorage.getItem('nevo_user') || 'Nhân viên';
                const rowsHtml = items.map((p, idx) => `
                    <tr>
                        <td>${idx + 1}</td>
                        <td><b>${escapeHtml(p.ma10 || '-')}</b></td>
                        <td>${escapeHtml(p.ma16 || '-')}</td>
                        <td>${escapeHtml(p.phanLoai || '-')}</td>
                        <td>${Number(p.soLuongVe || 0)}</td>
                        <td>${escapeHtml(p.ngayVeKho || '-')}</td>
                        <td>${escapeHtml(p.anhModelNgayCo || p.anhTraiSanNgayCo || '-')}</td>
                    </tr>
                `).join('');

                const contentHtml = `
                    <p><b>Đơn tự động khởi tạo từ bảng Sản phẩm mới (${items.length} dòng sản phẩm):</b></p>
                    <table>
                        <thead>
                            <tr><th>STT</th><th>Mã 10</th><th>Mã Màu (16)</th><th>Phân loại</th><th>SL về</th><th>Ngày về kho</th><th>Hạn có ảnh</th></tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                `;

                const linkedProducts = items
                    .filter(p => p.id)
                    .map(p => ({
                        collection: p._collectionName || COLLECTION_NAME,
                        docId: p.id,
                        ma10: p.ma10 || '',
                        ma16: p.ma16 || ''
                    }));

                const counterRef = doc(db, "counters", "orders");
                const newOrderRef = doc(collection(db, "orders"));
                const todayYMD = buildLocalYMD(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());

                const allocatedCode = await runTransaction(db, async (tx) => {
                    const cSnap = await tx.get(counterRef);
                    let candidateNum = cSnap.exists() ? (Number(cSnap.data().count) || 0) : 0;
                    let assigned = null;

                    for (let attempt = 0; attempt < 50; attempt++) {
                        candidateNum++;
                        const codeCandidate = 'NV-' + String(candidateNum).padStart(4, '0');
                        const codeRef = doc(db, "order_codes", codeCandidate);
                        const codeSnap = await tx.get(codeRef);
                        if (!codeSnap.exists()) {
                            tx.set(codeRef, {
                                code: codeCandidate,
                                orderId: newOrderRef.id,
                                requester,
                                title: orderForm.title,
                                createdAt: serverTimestamp()
                            });
                            assigned = codeCandidate;
                            break;
                        }
                    }
                    if (!assigned) throw new Error("Không thể cấp phát mã đơn tự động.");

                    tx.set(counterRef, {
                        count: candidateNum,
                        lastAllocatedCode: assigned,
                        updatedAt: serverTimestamp()
                    }, { merge: true });

                    tx.set(newOrderRef, {
                        code: assigned,
                        department: orderForm.department,
                        requester,
                        title: orderForm.title,
                        category: orderForm.category,
                        orderDate: todayYMD,
                        deployDate: todayYMD,
                        deadline: orderForm.deadline,
                        content: contentHtml,
                        note: `Đồng bộ 2 chiều với ${linkedProducts.length} mã SP mới`,
                        linkedProducts,
                        status: 'Chờ duyệt',
                        stageTimestamps: { 'Chờ duyệt': new Date().toISOString() },
                        createdAt: serverTimestamp()
                    });

                    return assigned;
                });

                // Mark selected products as "Đang xử lý" for the requested media type
                const isVideoOrder = orderForm.category.toLowerCase().includes('video') || orderForm.category.toLowerCase().includes('live');
                for (const row of selectedRows) {
                    const d = row.getData();
                    if (!d.id) continue;
                    const coll = d._collectionName || COLLECTION_NAME;
                    const statusPatch = isVideoOrder
                        ? { videoModelTrangThai: 'Đang xử lý', updatedAt: serverTimestamp() }
                        : { anhModelTrangThai: 'Đang xử lý', anhTraiSanTrangThai: 'Đang xử lý', updatedAt: serverTimestamp() };
                    await updateDoc(doc(db, coll, d.id), statusPatch);
                    row.update(isVideoOrder
                        ? { videoModelTrangThai: 'Đang xử lý' }
                        : { anhModelTrangThai: 'Đang xử lý', anhTraiSanTrangThai: 'Đang xử lý' }
                    );
                }
                table.deselectRow();
                table.redraw(true);

                // Notify Creative team via notifications collection
                await addDoc(collection(db, "notifications"), {
                    title: `🆕 Đơn SP mới #${allocatedCode}: ${orderForm.title}`,
                    body: `${requester} (${orderForm.department}) vừa đẩy ${linkedProducts.length} sản phẩm mới sang Creative.`,
                    type: 'create',
                    orderId: newOrderRef.id,
                    orderCode: allocatedCode,
                    targetAll: true,
                    readBy: [],
                    linkPage: 'orders',
                    createdAt: serverTimestamp()
                });

                const goRes = await Swal.fire({
                    title: `Đã tạo đơn #${allocatedCode}!`,
                    text: `Đã liên kết 2 chiều ${linkedProducts.length} mã sản phẩm với đơn #${allocatedCode}.`,
                    icon: 'success',
                    showCancelButton: true,
                    confirmButtonText: 'Mở Quản lý đơn hàng',
                    cancelButtonText: 'Ở lại trang SP mới'
                });
                if (goRes.isConfirmed) {
                    window.location.href = 'index.html#orders';
                }
            } catch (err) {
                console.error("Create order from products error:", err);
                Swal.fire('Lỗi tạo đơn', err.message || 'Không thể khởi tạo đơn hàng.', 'error');
            }
            setSyncing(false);
        });
    }

    // Delete Rows
    document.getElementById("btn-delete-rows").addEventListener("click", async () => {
        if (isUser) return;
        const selectedRows = table.getSelectedRows();
        if (selectedRows.length === 0) return Swal.fire('Chú ý', 'Chọn ít nhất 1 dòng', 'warning');

        const result = await Swal.fire({
            title: 'Xác nhận xoá?',
            text: `Bạn muốn xoá ${selectedRows.length} dòng đã chọn?`,
            icon: 'warning',
            showCancelButton: true
        });

        if (result.isConfirmed) {
            setSyncing(true);
            try {
                for (const row of selectedRows) {
                    const data = row.getData();
                    const id = data.id;
                    const targetCollection = data._collectionName || COLLECTION_NAME;
                    if (id) await deleteDoc(doc(db, targetCollection, id));
                    row.delete();
                }
                updateStats(table.getData());
            } catch (err) { console.error(err); }
            setSyncing(false);
        }
    });

    // Export Excel
    document.getElementById("btn-export").addEventListener("click", () => {
        const filename = currentViewMode === 'all'
            ? `SanPham_Nevo_ToanBo_Nam_${selectedYear}.xlsx`
            : `SanPham_Nevo_${currentMonth}.xlsx`;
        const sheetName = currentViewMode === 'all' ? `ToanBo_${selectedYear}` : currentMonth;
        table.download("xlsx", filename, {
            sheetName: sheetName,
        });
    });

    // Tab Mode listeners (Theo tháng vs Xem toàn bộ)
    const tabMonthBtn = document.getElementById('tab-mode-month');
    const tabAllBtn = document.getElementById('tab-mode-all');
    const yearSelect = document.getElementById('year-selector');
    
    if (tabMonthBtn) tabMonthBtn.addEventListener('click', () => switchViewMode('month'));
    if (tabAllBtn) tabAllBtn.addEventListener('click', () => switchViewMode('all'));
    if (yearSelect) {
        yearSelect.addEventListener('change', (e) => {
            selectedYear = e.target.value;
            loadAllYearData(selectedYear);
        });
    }

    // Global search
    document.getElementById("global-search").addEventListener("input", function(e){
        table.setFilter(customFilter, e.target.value);
    });

    function customFilter(data, filterParams) {
        if (!filterParams) return true;
        const term = filterParams.toLowerCase();
        for (const key in data) {
            if (key.startsWith('_')) continue;
            if (data[key] && String(data[key]).toLowerCase().includes(term)) return true;
        }
        return false;
    }
    updateDriveButton();
    trySilentReconnect();

    // RBAC: Ẩn các nút chỉnh sửa theo vai trò
    if (isUser) {
        const elementsToRemove = [
            "btn-add-row", "btn-add-col", "btn-color-row", 
            "btn-import-trigger", "btn-delete-rows", "btn-manage-status",
            "file-import-csv"
        ];
        if (isViewer) {
            elementsToRemove.push("btn-create-order-from-products");
        }
        elementsToRemove.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        
        const infoText = document.querySelector('.text-slate-500.font-medium');
        if (infoText && isViewer) infoText.style.display = 'none';
    }

    setSyncing(false);
}

if (isLoggedIn) {
    init();
}
