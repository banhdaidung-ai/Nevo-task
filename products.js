import { 
    db, collection, addDoc, getDocs, doc, getDoc,
    updateDoc, deleteDoc, serverTimestamp, setDoc,
    query, orderBy 
} from "./firebase-service.js";

// Auth Guard
if (localStorage.getItem('nevo_logged_in') !== 'true') {
    window.location.replace('login.html');
}

let currentMonth = "";
let COLLECTION_NAME = "";
const SETTINGS_DOC = "products_table_config";

let table;
let isSyncing = false;
let statusOptions = ["Hoàn tất", "Đang xử lý", "Chưa có"];
let statusColors = {
    "Hoàn tất": "#dcfce7", // green
    "Đang xử lý": "#fef08a", // yellow
    "Chưa có": "#ffffff" // white
};

// Custom Formatter for Status
const statusFormatter = function(cell, formatterParams) {
    let val = cell.getValue() || "Chưa có";
    let color = statusColors[val] || "#e2e8f0";
    
    // Use predefined classes for legacy statuses if they match, otherwise use inline styles
    if (val === "Hoàn tất") return `<span class="status-badge status-hoan-tat">${val}</span>`;
    if (val === "Đang xử lý") return `<span class="status-badge status-dang-xu-ly">${val}</span>`;
    if (val === "Chưa có") return `<span class="status-badge status-chua-co">${val}</span>`;
    
    return `<span class="status-badge" style="background-color: ${color}; color: #475569; border: 1px solid rgba(0,0,0,0.05)">${val}</span>`;
};

// Better Date Editor: Allows typing and validates format
const dateEditor = function(cell, onRendered, success, cancel) {
    let cellValue = cell.getValue() || "";
    let input = document.createElement("input");
    input.type = "text";
    input.placeholder = "DD/MM/YYYY";
    input.value = cellValue;
    input.style.cssText = "padding:4px; width:100%; box-sizing:border-box; border:none; outline:none; background:transparent; font-family:inherit; font-size:inherit;";
    
    onRendered(() => { input.focus(); });

    function onChange() {
        let val = input.value.trim();
        if (!val) return success("");
        
        // Simple parser
        let parts = val.split(/[-/.]/);
        if (parts.length === 1 && parts[0].length <= 2) {
            let now = new Date();
            val = `${parts[0].padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()}`;
        } else if (parts.length === 2) {
            let now = new Date();
            val = `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${now.getFullYear()}`;
        } else if (parts.length === 3) {
            let year = parts[2];
            if (year.length === 2) year = "20" + year;
            val = `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${year}`;
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
    
    if (statuses.includes("Đang xử lý")) {
        row.getElement().style.backgroundColor = statusColors["Đang xử lý"];
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
    // 0. Tổng số dòng (Rows count)
    document.getElementById('stat-rows').innerText = data.length;

    // 1. Tổng số lượng = SUM of soLuongVe (as requested)
    let totalQty = data.reduce((sum, item) => sum + (parseInt(item.soLuongVe) || 0), 0);
    document.getElementById('stat-total').innerText = totalQty;
    
    // 2. Tổng Mã SP = COUNT of rows where Ma 10 is NOT empty
    let totalMa10 = data.filter(d => d.ma10 && d.ma10.toString().trim() !== '').length;
    document.getElementById('stat-ma10').innerText = totalMa10;

    document.getElementById('stat-traisan').innerText = data.filter(d => d.anhTraiSanTrangThai === 'Hoàn tất').length;
    document.getElementById('stat-model').innerText = data.filter(d => d.anhModelTrangThai === 'Hoàn tất').length;
    document.getElementById('stat-video').innerText = data.filter(d => d.videoModelTrangThai === 'Hoàn tất').length;
}

// Setup Months
function setupMonths() {
    const sel = document.getElementById('month-selector');
    const now = new Date();
    
    // Generate months from 3 months ago to 3 months ahead
    for (let i = -3; i <= 3; i++) {
        let d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        let m = (d.getMonth() + 1).toString().padStart(2, '0');
        let y = d.getFullYear();
        let val = `${m}-${y}`;
        
        let opt = document.createElement('option');
        opt.value = val;
        opt.text = `Tháng ${m}/${y}`;
        
        if (i === 0) {
            opt.selected = true;
            currentMonth = val;
            COLLECTION_NAME = "new_products_" + val;
        }
        sel.appendChild(opt);
    }
    
    sel.addEventListener('change', (e) => {
        currentMonth = e.target.value;
        COLLECTION_NAME = "new_products_" + currentMonth;
        loadTableData();
    });
}

// Load Data into Table
async function loadTableData() {
    setSyncing(true);
    try {
        // Sort by createdAt DESC so newest rows are at the top by default
        const q = query(collection(db, COLLECTION_NAME), orderBy("createdAt", "desc"));
        const snapshot = await getDocs(q);
        const tableData = [];
        snapshot.forEach(doc => {
            tableData.push({ id: doc.id, ...doc.data() });
        });
        
        if (table) {
            await table.setData(tableData);
            updateStats(tableData);
        }
        setSyncing(false);
        return tableData;
    } catch (e) {
        console.error("Error loading data:", e);
        // Fallback: if index not created yet, load without sort
        const snapshot = await getDocs(collection(db, COLLECTION_NAME));
        const tableData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (table) {
            table.setData(tableData);
            updateStats(tableData);
        }
        setSyncing(false);
        return tableData;
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
    async function connectGoogleDrive() {
        // Fetch googleClientId from settings document
        let clientId = null;
        try {
            const configSnap = await getDoc(doc(db, "settings", SETTINGS_DOC));
            clientId = configSnap.exists() ? configSnap.data().googleClientId : null;
        } catch (err) { console.error("Error loading config for Google Drive:", err); }
        
        if (!clientId) {
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
                    return;
                }
                setSyncing(false);
            } else {
                return;
            }
        }
        
        // Trigger Google OAuth 2.0 Token Flow
        if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
            Swal.fire('Lỗi thư viện', 'Thư viện Google Identity Services chưa tải xong. Vui lòng thử lại sau vài giây!', 'error');
            return;
        }
        
        try {
            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: clientId,
                scope: 'https://www.googleapis.com/auth/drive.readonly',
                callback: (tokenResponse) => {
                    if (tokenResponse && tokenResponse.access_token) {
                        localStorage.setItem("gdrive_access_token", tokenResponse.access_token);
                        localStorage.setItem("gdrive_token_expires", (Date.now() + tokenResponse.expires_in * 1000).toString());
                        updateDriveButton();
                        Swal.fire('Thành công', 'Đã kết nối trực tiếp với Google Drive thành công!', 'success');
                    } else {
                        Swal.fire('Lỗi ủy quyền', 'Sếp đã từ chối hoặc có lỗi trong quá trình cấp quyền.', 'error');
                    }
                },
            });
            tokenClient.requestAccessToken({ prompt: 'consent' });
        } catch (err) {
            console.error(err);
            Swal.fire('Lỗi kết nối', 'Có lỗi khi kết nối Google: ' + err.message, 'error');
        }
    }

    function extractFolderId(url) {
        if (!url) return null;
        const match = url.match(/[-\w]{25,}/);
        return match ? match[0] : null;
    }

    function hideImagePreview() {
        const card = document.getElementById("hover-preview-card");
        if (card) {
            card.style.display = "none";
            const img = document.getElementById("preview-img");
            if (img.src && img.src.startsWith("blob:")) {
                URL.revokeObjectURL(img.src);
            }
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

    async function findImageInFolder(folderId, searchCode, token) {
        // 1. List files in folder (Shared Drive compatible via corpora + header auth)
        const q = `'${folderId}' in parents and trashed = false`;
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=200`;
        
        const resp = await driveApiFetch(url, token);
        if (!resp.ok) {
            let errBody = '';
            try { errBody = JSON.stringify(await resp.json()); } catch(e) {}
            console.error(`❌ Drive API lỗi ${resp.status} khi quét folder ${folderId}:`, errBody);
            return { status: resp.status, file: null };
        }
        const data = await resp.json();
        const files = data.files || [];

        // 2. Build progressive search candidates
        const targetCode = searchCode.trim().toLowerCase();
        const searchCandidates = [targetCode];
        if (targetCode.includes('-')) {
            const parts = targetCode.split('-');
            if (parts.length > 2) searchCandidates.push(parts.slice(0, 2).join('-'));
            searchCandidates.push(parts[0]);
        }

        console.log("🔍 === TÌM KIẾM ẢNH DRIVE ===");
        console.log("📋 Mã đang tìm:", searchCode, "| Candidates:", searchCandidates);
        console.log("📂 Files trong folder:", files.map(f => `${f.name} [${f.mimeType}]`));

        // 3. Direct match
        for (const candidate of searchCandidates) {
            const match = files.find(f =>
                f.mimeType && f.mimeType.startsWith('image/') &&
                f.name.toLowerCase().includes(candidate)
            );
            if (match) { console.log("✅ Tìm thấy:", match.name); return { status: 200, file: match }; }
        }

        // 4. Search subfolders (1 level deep)
        const subfolders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
        for (const folder of subfolders) {
            const subQ = `'${folder.id}' in parents and trashed = false`;
            const subUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(subQ)}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=200`;
            const subResp = await driveApiFetch(subUrl, token);
            if (subResp.ok) {
                const subData = await subResp.json();
                const subFiles = subData.files || [];
                console.log(`  📁 "${folder.name}":`, subFiles.map(f => f.name));
                for (const candidate of searchCandidates) {
                    const match = subFiles.find(f =>
                        f.mimeType && f.mimeType.startsWith('image/') &&
                        f.name.toLowerCase().includes(candidate)
                    );
                    if (match) { console.log(`✅ Tìm thấy trong "${folder.name}":`, match.name); return { status: 200, file: match }; }
                }
            }
        }

        console.warn("❌ Không tìm thấy ảnh nào khớp!");
        return { status: 200, file: null };
    }

    async function showImagePreview(e, cell) {
        const rowData = cell.getRow().getData();
        const searchCode = rowData.ma16 || rowData.ma10;
        const linkAnh = rowData.linkAnh;

        if (!searchCode || !linkAnh || !linkAnh.includes("drive.google.com")) return;

        const card = document.getElementById("hover-preview-card");
        const previewImg = document.getElementById("preview-img");
        const previewTitle = document.getElementById("preview-title");
        const spinner = card.querySelector(".loading-spinner");

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
            previewTitle.innerHTML = `<span class="text-rose-500 font-bold">⚠️ Chưa kết nối Drive</span><br><span class="text-[11px] text-slate-500 font-normal">Nhấp nút <b>"Kết nối Drive"</b> trên thanh công cụ.</span>`;
            spinner.style.display = "none";
            return;
        }

        const folderId = extractFolderId(linkAnh);
        if (!folderId) {
            previewTitle.innerText = "⚠️ Link ảnh không đúng định dạng Drive";
            spinner.style.display = "none";
            return;
        }

        console.log("🖱️ Hover:", linkAnh, "| ID:", folderId, "| Code:", searchCode);
        const isFolder = linkAnh.includes("/folders/") || linkAnh.includes("/drive/folders/");

        try {
            let file = null;
            let status = 200;

            if (isFolder) {
                const result = await findImageInFolder(folderId, searchCode, token);
                status = result.status;
                file = result.file;
            } else {
                // Direct file link
                const fileUrl = `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,mimeType&supportsAllDrives=true`;
                const fileResp = await driveApiFetch(fileUrl, token);
                status = fileResp.status;
                if (fileResp.ok) {
                    file = await fileResp.json();
                    console.log("📄 Direct file:", file.name, file.mimeType);
                } else {
                    let errBody = '';
                    try { errBody = JSON.stringify(await fileResp.json()); } catch(e) {}
                    console.error(`❌ Direct file lỗi ${status}:`, errBody);
                }
            }

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
                if (file.mimeType && file.mimeType.startsWith('image/')) {
                    const mediaResp = await driveApiFetch(
                        `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`, token
                    );
                    if (mediaResp.ok) {
                        const blob = await mediaResp.blob();
                        const localUrl = URL.createObjectURL(blob);
                        previewImg.src = localUrl;
                        previewImg.onload = () => { previewImg.style.display = "block"; spinner.style.display = "none"; };
                        previewTitle.innerText = `Ảnh: ${file.name}`;
                    } else {
                        previewTitle.innerText = "❌ Không thể tải nội dung ảnh";
                        spinner.style.display = "none";
                    }
                } else {
                    previewTitle.innerText = "⚠️ Định dạng tệp không phải là ảnh";
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

    const tableData = await loadTableData();

    // Base Columns
    let columns = [
        { rowHandle:true, formatter:"handle", headerSort:false, frozen:true, width:30, minWidth:30 },
        { formatter:"rowSelection", titleFormatter:"rowSelection", hozAlign:"center", headerSort:false, width:40, frozen:true },
        { title: "STT", formatter:"rownum", hozAlign:"center", width:50, frozen:true, headerSort:false },
        { 
            title: "Mã 10", 
            field: "ma10", 
            editor: "input", 
            width: 120, 
            headerFilter: "input"
        },
        { 
            title: "Mã Màu (mã 16)", 
            field: "ma16", 
            editor: "input", 
            width: 140, 
            headerFilter: "input",
            cellMouseEnter: showImagePreview,
            cellMouseLeave: hideImagePreview
        },
        { title: "Phân loại", field: "phanLoai", editor: "input", width: 120, headerFilter: "input" },
        { title: "Số lượng về", field: "soLuongVe", editor: "input", width: 100, headerFilter: "input" },
        { title: "Ngày về kho Media", field: "ngayVeKho", editor: dateEditor, formatter: dateDisplayFormatter, width: 110, headerFilter: "input" },
        { 
            title: "Link Ảnh", 
            field: "linkAnh", 
            editor: "input", 
            width: 150, 
            headerFilter: "input",
            cellMouseEnter: showImagePreview,
            cellMouseLeave: hideImagePreview,
            formatter: function(cell) {
                let val = cell.getValue();
                if (val && (typeof val === 'string') && (val.toLowerCase().startsWith("http") || val.toLowerCase().startsWith("www"))) {
                    let url = val.toLowerCase().startsWith("http") ? val : "https://" + val;
                    // Add 'link-access' class and the URL as a tooltip for clarity
                    return `<div class="link-access text-blue-600 hover:underline cursor-pointer inline-flex items-center gap-1" title="${val}" onclick="event.stopPropagation(); window.open('${url}', '_blank');" onmousedown="event.stopPropagation();"><span class="material-symbols-outlined text-[14px]">link</span> Truy cập</div>`;
                }
                return val || "";
            }
        },
        {
            title: "Hình ảnh trải sàn",
            columns: [
                { title: "Ngày chụp", field: "anhTraiSanNgay", editor: dateEditor, formatter: dateDisplayFormatter, width: 100, headerFilter: "input" },
                { title: "Trạng thái", field: "anhTraiSanTrangThai", editor: "list", editorParams:{values: statusOptions}, formatter: statusFormatter, width: 130, headerFilter: "list", headerFilterParams: {values: ["", ...statusOptions]} }
            ]
        },
        {
            title: "Hình ảnh model",
            columns: [
                { title: "Ngày chụp", field: "anhModelNgay", editor: dateEditor, formatter: dateDisplayFormatter, width: 100, headerFilter: "input" },
                { title: "Trạng thái", field: "anhModelTrangThai", editor: "list", editorParams:{values: statusOptions}, formatter: statusFormatter, width: 130, headerFilter: "list", headerFilterParams: {values: ["", ...statusOptions]} }
            ]
        },
        {
            title: "Video model",
            columns: [
                { title: "Ngày quay", field: "videoModelNgay", editor: dateEditor, formatter: dateDisplayFormatter, width: 100, headerFilter: "input" },
                { title: "Trạng thái", field: "videoModelTrangThai", editor: "list", editorParams:{values: statusOptions}, formatter: statusFormatter, width: 130, headerFilter: "list", headerFilterParams: {values: ["", ...statusOptions]} }
            ]
        },
        { title: "Ghi chú", field: "ghiChu", editor: "textarea", width: 250, headerFilter: "input" }
    ];

    // Header Menu
    const headerMenu = [
        {
            label: "Đổi tên cột",
            action: async function(e, column){
                const { value: newName } = await Swal.fire({ title: 'Đổi tên cột', input: 'text', inputValue: column.getDefinition().title, showCancelButton: true });
                if(newName) {
                    setSyncing(true);
                    column.updateDefinition({title: newName});
                    try {
                        const configSnap = await getDoc(doc(db, "settings", SETTINGS_DOC));
                        let cols = configSnap.exists() ? configSnap.data().customColumns || [] : [];
                        let colDef = cols.find(c => c.field === column.getField());
                        if(colDef) colDef.title = newName;
                        await setDoc(doc(db, "settings", SETTINGS_DOC), { customColumns: cols }, { merge: true });
                    } catch(e) {}
                    setSyncing(false);
                }
            }
        },
        {
            label: "Xoá cột",
            action: async function(e, column){
                let field = column.getField();
                const result = await Swal.fire({ title: 'Xoá cột?', text: `Xoá "${column.getDefinition().title}"?`, icon: 'warning', showCancelButton: true });
                if(result.isConfirmed) {
                    setSyncing(true);
                    column.delete();
                    try {
                        const configSnap = await getDoc(doc(db, "settings", SETTINGS_DOC));
                        let cols = configSnap.exists() ? configSnap.data().customColumns || [] : [];
                        cols = cols.filter(c => c.field !== field);
                        await setDoc(doc(db, "settings", SETTINGS_DOC), { customColumns: cols }, { merge: true });
                    } catch(e) {}
                    setSyncing(false);
                }
            }
        }
    ];

    customCols.forEach(col => {
        columns.push({ title: col.title, field: col.field, editor: "input", width: 150, headerMenu: headerMenu });
    });

    // Setup Tabulator
    table = new Tabulator("#products-table", {
        data: tableData,
        layout: "fitColumns",
        height: "100%", 
        history: true, 
        clipboard: true,
        selectable: "highlight",
        reactiveData: true,
        rowFormatter: rowColorFormatter,
        movableColumns: true, 
        movableRows: true,
        persistence: { columns: true, rows: true },
        persistenceID: "productsTable_v4",
        columns: columns,
    });

    // Tracking last cell for pasting
    let lastClickedCell = null;
    table.on("cellClick", function(e, cell) { lastClickedCell = cell; });
    table.on("cellEditing", function(cell) { cell.getRow().deselect(); });
    table.on("dataLoaded", updateStats);
    table.on("dataChanged", updateStats);

    // --- FIREBASE SYNC ---
    table.on("cellEdited", async function(cell) {
        const row = cell.getRow();
        const data = row.getData();
        const field = cell.getField();
        if (data.id) {
            setSyncing(true);
            try {
                await updateDoc(doc(db, COLLECTION_NAME, data.id), {
                    [field]: cell.getValue() || "",
                    updatedAt: serverTimestamp()
                });
            } catch (err) { console.error(err); }
            row.reformat();
            setSyncing(false);
        }
    });

    // --- BUTTON LISTENERS ---
    
    // Add Row
    document.getElementById("btn-add-row").addEventListener("click", async () => {
        setSyncing(true);
        try {
            const newDoc = {
                ma10: "", ma16: "", phanLoai: "", soLuongVe: 0,
                ngayVeKho: "", linkAnh: "",
                anhTraiSanNgay: "", anhTraiSanTrangThai: "Chưa có",
                anhModelNgay: "", anhModelTrangThai: "Chưa có",
                videoModelNgay: "", videoModelTrangThai: "Chưa có",
                createdAt: serverTimestamp()
            };
            const docRef = await addDoc(collection(db, COLLECTION_NAME), newDoc);
            table.addRow({ id: docRef.id, ...newDoc }, true);
        } catch (err) { console.error(err); }
        setSyncing(false);
    });

    // Add Custom Column
    document.getElementById("btn-add-col").addEventListener("click", async () => {
        const { value: colName } = await Swal.fire({
            title: 'Thêm cột mới',
            input: 'text',
            inputLabel: 'Tên cột',
            inputPlaceholder: 'Nhập tên cột...',
            showCancelButton: true
        });

        if (colName) {
            setSyncing(true);
            const field = "custom_" + Date.now();
            const newColDef = { title: colName, field: field, editor: "input", width: 150, headerMenu: headerMenu };
            
            table.addColumn(newColDef);
            try {
                const configSnap = await getDoc(doc(db, "settings", SETTINGS_DOC));
                let cols = configSnap.exists() ? configSnap.data().customColumns || [] : [];
                cols.push(newColDef);
                await setDoc(doc(db, "settings", SETTINGS_DOC), { customColumns: cols }, { merge: true });
                Swal.fire('Thành công', 'Đã thêm cột mới. Cột này áp dụng cho mọi tháng.', 'success');
            } catch (e) { console.error(e); }
            setSyncing(false);
        }
    });

    // Manage Statuses
    document.getElementById("btn-manage-status").addEventListener("click", async () => {
        let tempStatuses = [...statusOptions];
        let tempColors = {...statusColors};

        const renderList = () => {
            let html = '<div class="space-y-3 max-h-[60vh] overflow-y-auto px-1">';
            tempStatuses.forEach((s, i) => {
                html += `
                    <div class="flex items-center gap-2 bg-slate-50 p-2 rounded-lg border border-slate-100 mb-2">
                        <div class="flex flex-col">
                            <button class="btn-move-up text-slate-400 hover:text-indigo-600 disabled:opacity-30" data-index="${i}" ${i === 0 ? 'disabled' : ''}>
                                <span class="material-symbols-outlined text-[20px]">expand_less</span>
                            </button>
                            <button class="btn-move-down text-slate-400 hover:text-indigo-600 disabled:opacity-30" data-index="${i}" ${i === tempStatuses.length - 1 ? 'disabled' : ''}>
                                <span class="material-symbols-outlined text-[20px]">expand_more</span>
                            </button>
                        </div>
                        <input type="text" value="${s}" class="status-name-input flex-grow px-3 py-1.5 rounded border border-slate-200 text-sm font-medium" data-index="${i}" placeholder="Tên trạng thái">
                        <input type="color" value="${tempColors[s] || '#e2e8f0'}" class="status-color-input w-10 h-8 p-0 border-none cursor-pointer rounded" data-index="${i}">
                        <button class="btn-remove-status text-rose-500 hover:bg-rose-50 p-1.5 rounded transition-all flex items-center justify-center" data-index="${i}">
                            <span class="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                    </div>
                `;
            });
            html += '</div>';
            html += `
                <button id="btn-add-status-item" class="mt-4 w-full py-2 border-2 border-dashed border-slate-200 rounded-lg text-slate-500 hover:border-indigo-400 hover:text-indigo-500 transition-all font-bold flex items-center justify-center gap-2 text-sm">
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
                
                const attachEvents = () => {
                    // Name change
                    container.querySelectorAll('.status-name-input').forEach(input => {
                        input.addEventListener('change', (e) => {
                            const idx = e.target.dataset.index;
                            const oldName = tempStatuses[idx];
                            const newName = e.target.value.trim();
                            if (newName && !tempStatuses.includes(newName)) {
                                tempStatuses[idx] = newName;
                                if (tempColors[oldName]) {
                                    tempColors[newName] = tempColors[oldName];
                                    delete tempColors[oldName];
                                }
                            } else if (newName !== oldName) {
                                Swal.fire('Lỗi', 'Tên trạng thái đã tồn tại hoặc không hợp lệ', 'error');
                                e.target.value = oldName;
                            }
                        });
                    });

                    // Color change
                    container.querySelectorAll('.status-color-input').forEach(input => {
                        input.addEventListener('change', (e) => {
                            const idx = e.target.dataset.index;
                            const name = tempStatuses[idx];
                            tempColors[name] = e.target.value;
                        });
                    });

                    // Move Up
                    container.querySelectorAll('.btn-move-up').forEach(btn => {
                        btn.addEventListener('click', (e) => {
                            const idx = parseInt(e.currentTarget.dataset.index);
                            if (idx > 0) {
                                [tempStatuses[idx], tempStatuses[idx-1]] = [tempStatuses[idx-1], tempStatuses[idx]];
                                container.innerHTML = renderList();
                                attachEvents();
                            }
                        });
                    });

                    // Move Down
                    container.querySelectorAll('.btn-move-down').forEach(btn => {
                        btn.addEventListener('click', (e) => {
                            const idx = parseInt(e.currentTarget.dataset.index);
                            if (idx < tempStatuses.length - 1) {
                                [tempStatuses[idx], tempStatuses[idx+1]] = [tempStatuses[idx+1], tempStatuses[idx]];
                                container.innerHTML = renderList();
                                attachEvents();
                            }
                        });
                    });

                    // Remove
                    container.querySelectorAll('.btn-remove-status').forEach(btn => {
                        btn.addEventListener('click', (e) => {
                            const idx = e.currentTarget.dataset.index;
                            const name = tempStatuses[idx];
                            tempStatuses.splice(idx, 1);
                            delete tempColors[name];
                            container.innerHTML = renderList();
                            attachEvents();
                        });
                    });

                    // Add button
                    document.getElementById('btn-add-status-item').onclick = () => {
                        const newName = "Trạng thái mới " + (tempStatuses.length + 1);
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
            
            // Update in-place to maintain references if any, but also re-assign for safety
            statusOptions.length = 0;
            statusOptions.push(...tempStatuses);
            statusColors = tempColors;

            try {
                await setDoc(doc(db, "settings", SETTINGS_DOC), { 
                    statusOptions: statusOptions,
                    statusColors: statusColors 
                }, { merge: true });

                // Update each status column definition directly using Column Component
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

    // Manually Color Rows
    document.getElementById("btn-color-row").addEventListener("click", async () => {
        const selectedRows = table.getSelectedRows();
        if (selectedRows.length === 0) return Swal.fire('Chú ý', 'Chọn các dòng (ô vuông đầu dòng) để tô màu.', 'warning');

        const { value: color } = await Swal.fire({
            title: 'Chọn màu nền',
            input: 'select',
            inputOptions: {
                '#ffffff': 'Trắng (Xoá màu)',
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
            let promises = [];
            for (let row of selectedRows) {
                const data = row.getData();
                if (data.id) {
                    promises.push(updateDoc(doc(db, COLLECTION_NAME, data.id), { rowColor: color }));
                    row.update({ rowColor: color });
                }
            }
            await Promise.all(promises);
            table.deselectRow(); 
            table.redraw(true); 
            setSyncing(false);
        }
    });

    // Connect Drive Listener
    document.getElementById("btn-connect-drive").addEventListener("click", connectGoogleDrive);

    // Import Logic
    document.getElementById("btn-import-trigger").addEventListener("click", () => {
        document.getElementById("file-import-csv").click();
    });

    document.getElementById("file-import-csv").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const result = await Swal.fire({
            title: 'Nhập dữ liệu',
            text: `Bạn muốn nhập dữ liệu vào tháng ${currentMonth}?`,
            icon: 'question',
            showCancelButton: true
        });

        if (result.isConfirmed) {
            setSyncing(true);
            const reader = new FileReader();
            reader.onload = async (event) => {
                const text = event.target.result;
                const rows = text.split('\n').filter(r => r.trim().length > 0);
                const headers = rows[0].split(',').map(h => h.replace(/"/g, '').trim());
                
                let addedCount = 0;
                for (let i = 1; i < rows.length; i++) {
                    const values = rows[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || rows[i].split(',');
                    const rowData = { createdAt: serverTimestamp() };
                    headers.forEach((h, index) => {
                        let val = values[index] ? values[index].replace(/"/g, '').trim() : "";
                        rowData[h] = val;
                    });
                    try {
                        delete rowData.id; 
                        const docRef = await addDoc(collection(db, COLLECTION_NAME), rowData);
                        table.addRow({ id: docRef.id, ...rowData }, true);
                        addedCount++;
                    } catch (e) { console.error(e); }
                }
                Swal.fire('Thành công', `Đã nhập ${addedCount} dòng mới`, 'success');
                setSyncing(false);
            };
            reader.readAsText(file);
        }
        e.target.value = ''; 
    });

    // Delete Rows
    document.getElementById("btn-delete-rows").addEventListener("click", async () => {
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
                for (let row of selectedRows) {
                    const id = row.getData().id;
                    if (id) await deleteDoc(doc(db, COLLECTION_NAME, id));
                    row.delete();
                }
            } catch (err) { console.error(err); }
            setSyncing(false);
        }
    });

    // Export Excel
    document.getElementById("btn-export").addEventListener("click", () => {
        table.download("xlsx", `SanPham_Nevo_${currentMonth}.xlsx`, {
            sheetName: "Data",
        });
    });

    // Global Search Logic
    document.getElementById("global-search").addEventListener("keyup", function(e) {
        const value = e.target.value.toLowerCase();
        if (!value) {
            table.clearFilter();
            return;
        }

        table.setFilter(function(data) {
            const fields = ['ma10', 'ma16', 'phanLoai', 'ghiChu', 'linkAnh'];
            return fields.some(f => data[f] && data[f].toString().toLowerCase().includes(value));
        });
    });

    updateDriveButton();

    console.log("App Initialized");
    setSyncing(false);
}

init();
