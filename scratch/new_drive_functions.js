    // Helper: all Drive API calls go through here with Authorization header
    async function driveApiFetch(url, token) {
        return await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
    }

    async function findImageInFolder(folderId, searchCode, token) {
        // 1. List files in folder (Shared Drive compatible via corpora + header auth)
        const q = `'${folderId}' in parents and trashed = false`;
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=200`;
        
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
            const subUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(subQ)}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=200`;
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
