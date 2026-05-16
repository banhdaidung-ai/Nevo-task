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
let statusColors = {
    "Hoàn tất": "#dcfce7", // green
    "Đang xử lý": "#fef08a", // yellow
    "Chưa có": "#ffffff" // white
};

// Custom Formatter for Status
const statusFormatter = function(cell, formatterParams) {
    let val = cell.getValue() || "Chưa có";
    if (val === "Hoàn tất") return `<span class="status-badge status-hoan-tat">${val}</span>`;
    if (val === "Đang xử lý") return `<span class="status-badge status-dang-xu-ly">${val}</span>`;
    return `<span class="status-badge status-chua-co">${val}</span>`;
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
        }
    } catch (e) { console.log("No config found"); }

    const tableData = await loadTableData();

    // Base Columns
    let columns = [
        { rowHandle:true, formatter:"handle", headerSort:false, frozen:true, width:30, minWidth:30 },
        { formatter:"rowSelection", titleFormatter:"rowSelection", hozAlign:"center", headerSort:false, width:40, frozen:true },
        { title: "STT", formatter:"rownum", hozAlign:"center", width:50, frozen:true, headerSort:false },
        { title: "Mã 10", field: "ma10", editor: "input", width: 120 },
        { title: "Mã Màu (mã 16)", field: "ma16", editor: "input", width: 140 },
        { title: "Phân loại", field: "phanLoai", editor: "input", width: 120 },
        { title: "Số lượng về", field: "soLuongVe", editor: "input", width: 100 },
        { title: "Ngày về kho Media", field: "ngayVeKho", editor: dateEditor, formatter: dateDisplayFormatter, width: 110 },
        { 
            title: "Link Ảnh", 
            field: "linkAnh", 
            editor: "input", 
            width: 150, 
            formatter: function(cell) {
                let val = cell.getValue();
                if (val && (typeof val === 'string') && (val.toLowerCase().startsWith("http") || val.toLowerCase().startsWith("www"))) {
                    let url = val.toLowerCase().startsWith("http") ? val : "https://" + val;
                    return `<a href="${url}" target="_blank" class="text-blue-600 hover:underline inline-flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">link</span> Truy cập</a>`;
                }
                return val || "";
            }
        },
        {
            title: "Hình ảnh trải sàn",
            columns: [
                { title: "Ngày chụp", field: "anhTraiSanNgay", editor: dateEditor, formatter: dateDisplayFormatter, width: 100 },
                { title: "Trạng thái", field: "anhTraiSanTrangThai", editor: "list", editorParams:{values:["Hoàn tất", "Đang xử lý", "Chưa có"]}, formatter: statusFormatter, width: 130 }
            ]
        },
        {
            title: "Hình ảnh model",
            columns: [
                { title: "Ngày chụp", field: "anhModelNgay", editor: dateEditor, formatter: dateDisplayFormatter, width: 100 },
                { title: "Trạng thái", field: "anhModelTrangThai", editor: "list", editorParams:{values:["Hoàn tất", "Đang xử lý", "Chưa có"]}, formatter: statusFormatter, width: 130 }
            ]
        },
        {
            title: "Video model",
            columns: [
                { title: "Ngày quay", field: "videoModelNgay", editor: dateEditor, formatter: dateDisplayFormatter, width: 100 },
                { title: "Trạng thái", field: "videoModelTrangThai", editor: "list", editorParams:{values:["Hoàn tất", "Đang xử lý", "Chưa có"]}, formatter: statusFormatter, width: 130 }
            ]
        },
        { title: "Ghi chú", field: "ghiChu", editor: "textarea", width: 250 }
    ];

    // Define Header Menu for Custom Columns
    const headerMenu = [
        {
            label: "<i class='fas fa-edit text-blue-500 w-4'></i> Đổi tên cột",
            action: async function(e, column){
                const { value: newName } = await Swal.fire({
                    title: 'Đổi tên cột',
                    input: 'text',
                    inputValue: column.getDefinition().title,
                    showCancelButton: true
                });
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
            label: "<span class='text-red-500 font-bold'><i class='fas fa-trash w-4'></i> Xoá cột này</span>",
            action: async function(e, column){
                let field = column.getField();
                const result = await Swal.fire({
                    title: 'Xoá cột?',
                    text: `Bạn muốn xoá cột "${column.getDefinition().title}" khỏi mọi tháng?`,
                    icon: 'warning',
                    showCancelButton: true
                });
                if(result.isConfirmed) {
                    setSyncing(true);
                    column.delete();
                    try {
                        const configSnap = await getDoc(doc(db, "settings", SETTINGS_DOC));
                        let cols = configSnap.exists() ? configSnap.data().customColumns || [] : [];
                        cols = cols.filter(c => c.field !== field);
                        await setDoc(doc(db, "settings", SETTINGS_DOC), { customColumns: cols }, { merge: true });
                        Swal.fire('Thành công', 'Đã xoá cột', 'success');
                    } catch(e) {}
                    setSyncing(false);
                }
            }
        }
    ];

    // Append custom columns
    customCols.forEach(col => {
        columns.push({ title: col.title, field: col.field, editor: "input", width: 150, headerMenu: headerMenu });
    });

    // Setup Tabulator
    table = new Tabulator("#products-table", {
        data: tableData,
        layout: "fitColumns",
        height: "100%", // Fill flex container
        history: true, 
        clipboard: true, // Allow copying OUT
        clipboardPasteParser: function(clipboard) {
            return false;
        },
        selectable: "highlight",
        reactiveData: true,
        rowFormatter: rowColorFormatter,
        movableColumns: true, 
        movableRows: true, // Enable row reordering
        persistence: {
            columns: true,
            rows: true, // Persist row order
        },
        persistenceID: "productsTable",
        columns: columns,
    });

    let lastClickedCell = null;
    table.on("cellClick", function(e, cell) {
        lastClickedCell = cell;
    });

    // Deselect row when editing starts to avoid the "select on edit" behavior
    table.on("cellEditing", function(cell) {
        cell.getRow().deselect();
    });

    table.on("dataLoaded", function(data) {
        updateStats(data);
    });
    table.on("dataChanged", function(data) {
        updateStats(data);
    });

    // --- FIREBASE SYNC LOGIC ---

    // Single Cell Edit
    table.on("cellEdited", async function(cell) {
        const row = cell.getRow();
        const data = row.getData();
        const field = cell.getField();
        
        if (data.id) {
            setSyncing(true);
            try {
                const docRef = doc(db, COLLECTION_NAME, data.id);
                await updateDoc(docRef, {
                    [field]: cell.getValue() || "",
                    updatedAt: serverTimestamp()
                });
            } catch (err) { console.error(err); }
            row.reformat();
            setSyncing(false);
        }
    });

    // --- DRAG TO FILL LOGIC (Kéo thả thông tin) ---
    let isFilling = false;
    let fillSourceValue = null;
    let fillSourceField = null;
    let fillStartRowIndex = -1;

    function incrementString(str, steps) {
        if (!str) return str;
        let match = str.match(/(.*?)(\d+)$/);
        if (match) {
            let prefix = match[1];
            let numStr = match[2];
            let num = parseInt(numStr, 10) + steps;
            return prefix + num.toString().padStart(numStr.length, '0');
        }
        return str; // No number to increment
    }

    table.on("cellMouseDown", function(e, cell) {
        if (e.altKey) {
            isFilling = true;
            fillSourceValue = cell.getValue() || "";
            fillSourceField = cell.getField();
            let rows = table.getRows();
            fillStartRowIndex = rows.findIndex(r => r === cell.getRow());
            e.preventDefault();
        }
    });

    table.on("cellMouseEnter", function(e, cell) {
        if (isFilling && fillSourceField === cell.getField()) {
            let data = cell.getData();
            if (data.id) {
                let rows = table.getRows();
                let currentIndex = rows.findIndex(r => r === cell.getRow());
                let directionalSteps = currentIndex - fillStartRowIndex;
                let newValue = incrementString(fillSourceValue, directionalSteps);
                
                if (cell.getValue() !== newValue) {
                    cell.setValue(newValue);
                    // Background sync
                    updateDoc(doc(db, COLLECTION_NAME, data.id), {
                        [fillSourceField]: newValue,
                        updatedAt: serverTimestamp()
                    }).catch(err => console.error(err));
                }
            }
        }
    });

    document.addEventListener("mouseup", function() {
        if (isFilling) {
            isFilling = false;
            if(table) table.redraw(true); // format colors after mass update
        }
    });

    // Custom Excel Paste Handler (Cell-level pasting)
    document.getElementById('products-table').addEventListener("paste", async function(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        
        let text = (e.clipboardData || window.clipboardData).getData('text');
        if (!text) return;
        
        if (!lastClickedCell) {
            Swal.fire('Chú ý', 'Vui lòng nhấp chuột vào 1 ô trên bảng để chọn vị trí bắt đầu dán', 'warning');
            return;
        }
        
        e.preventDefault(); // Stop native Tabulator full-table replace
        
        let startCell = lastClickedCell;
        let startRow = startCell.getRow();
        let startCol = startCell.getColumn();
        
        // Robust TSV Parsing (Handles newlines and tabs inside quotes)
        let parsedRows = [];
        let currentRow = [];
        let currentCell = "";
        let insideQuotes = false;
        for (let i = 0; i < text.length; i++) {
            let char = text[i];
            if (insideQuotes) {
                if (char === '"') {
                    if (i + 1 < text.length && text[i + 1] === '"') {
                        currentCell += '"'; // Escaped quote
                        i++;
                    } else {
                        insideQuotes = false;
                    }
                } else {
                    currentCell += char;
                }
            } else {
                if (char === '"') {
                    insideQuotes = true;
                } else if (char === '\t') {
                    currentRow.push(currentCell);
                    currentCell = "";
                } else if (char === '\n') {
                    currentRow.push(currentCell);
                    parsedRows.push(currentRow);
                    currentRow = [];
                    currentCell = "";
                } else if (char === '\r') {
                    // Ignore Windows carriage return
                } else {
                    currentCell += char;
                }
            }
        }
        if (currentCell !== "" || currentRow.length > 0) {
            currentRow.push(currentCell);
            parsedRows.push(currentRow);
        }

        // Clean up last empty row
        if (parsedRows.length > 0 && parsedRows[parsedRows.length - 1].length === 1 && parsedRows[parsedRows.length - 1][0] === "") {
            parsedRows.pop();
        }
        
        let currentTableRows = table.getRows();
        let rowIdx = currentTableRows.findIndex(r => r === startRow);
        if (rowIdx === -1) return;
        
        // Find the index of the startCell within its row's cells (Visual Order)
        let rowCells = startRow.getCells();
        let cellIdx = rowCells.findIndex(c => c === startCell);
        if (cellIdx === -1) cellIdx = 0;
        
        setSyncing(true);
        let promises = [];
        
        for (let i = 0; i < parsedRows.length; i++) {
            let r = currentTableRows[rowIdx + i];
            
            // If we run out of rows, add a new one
            if (!r) {
                const newDocRef = await addDoc(collection(db, COLLECTION_NAME), { createdAt: serverTimestamp() });
                await table.addRow({ id: newDocRef.id });
                currentTableRows = table.getRows(); // refresh
                r = currentTableRows[rowIdx + i];
            }
            
            let rowPastedData = parsedRows[i];
            let updateData = {};
            let id = r.getData().id;
            
            let cells = r.getCells(); // Cells in visual order
            
            // Map the pasted data robustly
            let pasteDataIdx = 0;
            for (let j = 0; j < cells.length; j++) {
                if (pasteDataIdx >= rowPastedData.length) break; // Finished parsing this row
                if (j < cellIdx) continue; // Skip cells before the selected one
                
                let cell = cells[j];
                let field = cell.getField();
                
                // Skip system/non-data columns
                if (!field || field === "rowSelection") continue;
                
                updateData[field] = rowPastedData[pasteDataIdx].trim();
                pasteDataIdx++;
            }
            
            if (Object.keys(updateData).length > 0) {
                r.update(updateData);
                updateData.updatedAt = serverTimestamp();
                promises.push(updateDoc(doc(db, COLLECTION_NAME, id), updateData));
            }
        }
        
        try {
            await Promise.all(promises);
            table.redraw(true); 
            Swal.fire('Thành công', `Đã dán và cập nhật ${parsedRows.length} dòng`, 'success');
        } catch(err) {
            console.error("Paste Error", err);
            Swal.fire('Lỗi', 'Có lỗi khi lưu dữ liệu', 'error');
        }
        setSyncing(false);
    });

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
            table.addRow({ id: docRef.id, ...newDoc }, true); // Add to TOP
        } catch (err) { console.error(err); }
        setSyncing(false);
    });

    // Delete Row
    document.getElementById("btn-delete-row").addEventListener("click", async () => {
        const selectedRows = table.getSelectedRows();
        if (selectedRows.length === 0) return Swal.fire('Chú ý', 'Chọn ít nhất 1 dòng', 'warning');

        const result = await Swal.fire({
            title: 'Xác nhận xoá?',
            text: `Bạn muốn xoá ${selectedRows.length} dòng ở tháng này?`,
            icon: 'warning',
            showCancelButton: true
        });

        if (result.isConfirmed) {
            setSyncing(true);
            for (let row of selectedRows) {
                const id = row.getData().id;
                if (id) await deleteDoc(doc(db, COLLECTION_NAME, id));
                row.delete();
            }
            setSyncing(false);
        }
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

    // Manually Color Rows
    document.getElementById("btn-color-row").addEventListener("click", async () => {
        const selectedRows = table.getSelectedRows();
        if (selectedRows.length === 0) return Swal.fire('Chú ý', 'Click vào các ô vuông ở cột đầu tiên để chọn dòng cần tô màu.', 'warning');

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
            table.deselectRow(); // Unselect so the color is immediately visible (because selected rows have an overlay)
            table.redraw(true); // Re-run formatters
            setSyncing(false);
        }
    });

    // Export CSV (with UTF-8 BOM for Excel compatibility)
    document.getElementById("btn-export-csv").addEventListener("click", () => {
        table.download("csv", `SanPham_${currentMonth}.csv`, { 
            bom: true,
            delimiter: ",",
        });
    });

    // Import CSV (File listener)
    document.getElementById("file-import-csv").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const result = await Swal.fire({
            title: 'Nhập dữ liệu',
            text: `Dữ liệu sẽ được đẩy vào ${currentMonth}. Tiếp tục?`,
            icon: 'info',
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
                    const rowData = {};
                    headers.forEach((h, index) => {
                        let val = values[index] ? values[index].replace(/"/g, '').trim() : "";
                        rowData[h] = val;
                    });
                    try {
                        delete rowData.id; 
                        const docRef = await addDoc(collection(db, COLLECTION_NAME), rowData);
                        table.addRow({ id: docRef.id, ...rowData });
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
}

init();
