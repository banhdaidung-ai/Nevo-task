/* 
  PDF SERVICE
  Generate and print high-quality PDF purchase/creative order vouchers with Electronic Approval Stamps
*/

import { escapeHtml, parseCurrencyNumber, toLocalYMD } from "./security-utils.js";

export function printOrderVoucher(order) {
    if (!order) return;

    const printWindow = window.open('', '_blank', 'width=920,height=840');
    if (!printWindow) {
        alert('Trình duyệt đã chặn cửa sổ bật lên. Vui lòng cho phép popup để in phiếu đơn hàng.');
        return;
    }

    const createdYMD = toLocalYMD(order.orderDate || order.createdAt) || toLocalYMD(new Date());
    const createdDate = createdYMD ? createdYMD.split('-').reverse().join('/') : new Date().toLocaleDateString('vi-VN');
    const deadlineYMD = toLocalYMD(order.deadline);
    const deadlineDate = deadlineYMD ? deadlineYMD.split('-').reverse().join('/') : 'Chưa đặt';

    // Build cost / material line items cleanly
    const rawItems = Array.isArray(order.items || order.materials) ? (order.items || order.materials) : [];
    const costLabels = {
        model: 'Chi phí Booking Người mẫu (Model)',
        makeup: 'Chi phí Makeup & Làm tóc',
        studio: 'Chi phí Thuê Studio / Bối cảnh',
        travel: 'Chi phí Di chuyển & Vận chuyển',
        video: 'Chi phí Sản xuất / Hậu kỳ Video',
        photo: 'Chi phí Chụp & Retouch Hình ảnh',
        stylist: 'Chi phí Styling & Đạo cụ',
        assistant: 'Chi phí Trợ lý hiện trường',
        other: 'Chi phí Phát sinh khác'
    };

    const computedItems = rawItems.length > 0
        ? rawItems.map(item => ({
            name: item.name || item.materialName || 'Hạng mục nguyên liệu',
            unit: item.unit || 'Gói',
            qty: Number(item.qty || item.quantity || 1) || 1,
            price: parseCurrencyNumber(item.price)
        }))
        : Object.entries(order.costs || {})
            .filter(([k, v]) => k !== 'note' && parseCurrencyNumber(v) > 0)
            .map(([k, v]) => ({
                name: costLabels[k] || k,
                unit: 'Gói',
                qty: 1,
                price: parseCurrencyNumber(v)
            }));

    const totalNum = parseCurrencyNumber(order.totalCost || order.amount) ||
        computedItems.reduce((sum, it) => sum + it.price * it.qty, 0);
    const totalAmount = totalNum > 0 ? `${totalNum.toLocaleString('vi-VN')} ₫` : '0 ₫';

    const codeSafe = escapeHtml(order.code || order.id || 'N/A');
    const deptSafe = escapeHtml(order.dept || order.department || 'Chưa xác định');
    const requesterSafe = escapeHtml(order.requester || order.createdByName || order.createdBy || 'N/A');
    const statusSafe = escapeHtml(order.status || 'Chờ duyệt');
    const categorySafe = escapeHtml(order.category || order.model || order.modelName || 'Mặc định');
    const titleSafe = escapeHtml(order.title || order.name || 'Chi phí triển khai đơn hàng Creative');
    const approverSafe = escapeHtml(order.approvedBy || order.lastUpdatedBy || '');
    const isApproved = ['Hoàn thành', 'Đang xử lý', 'Đang sản xuất', 'Đang hậu kỳ'].includes(order.status) || order.proofStatus === 'approved';
    const verifyUrl = `${window.location.origin}/index.html#orders`;
    const qrData = encodeURIComponent(`${verifyUrl}?code=${order.code || order.id || ''}`);

    const rowsHtml = computedItems.length > 0
        ? computedItems.map((item, idx) => `
            <tr>
                <td>${idx + 1}</td>
                <td><strong>${escapeHtml(item.name)}</strong></td>
                <td style="text-align: center;">${escapeHtml(item.unit)}</td>
                <td style="text-align: right; font-weight: 700;">${item.qty}</td>
                <td style="text-align: right;">${item.price.toLocaleString('vi-VN')}</td>
                <td style="text-align: right; font-weight: 700;">${(item.price * item.qty).toLocaleString('vi-VN')}</td>
            </tr>
        `).join('')
        : `
            <tr>
                <td>1</td>
                <td><strong>${titleSafe}</strong>${order.costs?.note ? `<div style="font-size:11px;color:#64748b;margin-top:3px;">Ghi chú: ${escapeHtml(order.costs.note)}</div>` : ''}</td>
                <td style="text-align: center;">Đơn</td>
                <td style="text-align: right; font-weight: 700;">1</td>
                <td style="text-align: right;">${totalAmount}</td>
                <td style="text-align: right; font-weight: 700;">${totalAmount}</td>
            </tr>
        `;

    const electronicStampHtml = isApproved ? `
        <div class="e-stamp">
            <div class="e-stamp-badge">✓ XÁC NHẬN ĐIỆN TỬ HỆ THỐNG</div>
            <div class="e-stamp-meta">${approverSafe ? `Người xử lý: ${approverSafe}` : 'Đã ghi nhận trên Nevo-Task'}</div>
            <div class="e-stamp-meta">Trạng thái: ${statusSafe}</div>
        </div>
    ` : `<div style="height: 54px;"></div>`;

    const htmlContent = `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <title>Phiếu Đơn Hàng & Quyết Toán #${codeSafe}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        body { font-family: 'Inter', sans-serif; background: #fff; color: #1e293b; padding: 36px; margin: 0; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #b80035; padding-bottom: 18px; margin-bottom: 24px; }
        .logo-title { font-size: 24px; font-weight: 800; color: #b80035; margin: 0; text-transform: uppercase; letter-spacing: -0.5px; }
        .logo-sub { font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }
        .voucher-title { text-align: right; }
        .voucher-title h1 { font-size: 20px; margin: 0; color: #0f172a; font-weight: 800; text-transform: uppercase; }
        .voucher-title p { font-size: 12px; color: #64748b; margin: 4px 0 0; }
        .grid-info { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; background: #f8fafc; padding: 18px; border-radius: 12px; border: 1px solid #e2e8f0; }
        .info-label { font-weight: 600; color: #64748b; margin-bottom: 3px; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; }
        .info-val { font-weight: 700; color: #0f172a; font-size: 13px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
        th { background: #f1f5f9; text-align: left; padding: 10px 14px; font-size: 11px; font-weight: 700; color: #475569; text-transform: uppercase; border-bottom: 2px solid #cbd5e1; }
        td { padding: 12px 14px; font-size: 13px; border-bottom: 1px solid #e2e8f0; color: #334155; }
        tr:last-child td { border-bottom: none; }
        .summary { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; }
        .qr-wrap { display: flex; align-items: center; gap: 12px; }
        .qr-code { width: 96px; height: 96px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
        .total-box { text-align: right; background: #fff1f2; border: 1px solid #fecdd3; padding: 16px 24px; border-radius: 12px; }
        .total-label { font-size: 11px; color: #9f1239; font-weight: 700; text-transform: uppercase; }
        .total-val { font-size: 24px; color: #b80035; font-weight: 800; margin-top: 4px; }
        .footer-signatures { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 44px; text-align: center; }
        .sig-title { font-weight: 700; color: #334155; margin-bottom: 12px; text-transform: uppercase; font-size: 11px; }
        .sig-name { font-weight: 600; color: #64748b; border-top: 1px dashed #cbd5e1; padding-top: 8px; display: inline-block; width: 82%; margin-top: 10px; }
        .e-stamp { display: inline-block; border: 2px solid #059669; color: #059669; background: #ecfdf5; border-radius: 8px; padding: 6px 10px; transform: rotate(-2deg); }
        .e-stamp-badge { font-size: 10px; font-weight: 800; letter-spacing: 0.4px; }
        .e-stamp-meta { font-size: 9px; font-weight: 600; margin-top: 2px; color: #047857; }
        @media print { body { padding: 0; } .no-print { display: none; } }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h2 class="logo-title">NEVO TASK</h2>
            <div class="logo-sub">Hệ thống Quản lý Đơn hàng Creative & Nguyên liệu</div>
        </div>
        <div class="voucher-title">
            <h1>PHIẾU ĐƠN HÀNG & DỰ TOÁN CHI PHÍ</h1>
            <p>Mã đơn: <strong>#${codeSafe}</strong> | Ngày lập: ${escapeHtml(createdDate)} | Hạn chót: ${escapeHtml(deadlineDate)}</p>
        </div>
    </div>

    <div class="grid-info">
        <div>
            <div style="margin-bottom: 10px;">
                <div class="info-label">Tiêu đề đơn hàng</div>
                <div class="info-val">${titleSafe}</div>
            </div>
            <div style="margin-bottom: 10px;">
                <div class="info-label">Đơn vị / Phòng ban</div>
                <div class="info-val">${deptSafe}</div>
            </div>
            <div>
                <div class="info-label">Người yêu cầu</div>
                <div class="info-val">${requesterSafe}</div>
            </div>
        </div>
        <div>
            <div style="margin-bottom: 10px;">
                <div class="info-label">Trạng thái phê duyệt</div>
                <div class="info-val" style="color: #b80035;">${statusSafe}</div>
            </div>
            <div style="margin-bottom: 10px;">
                <div class="info-label">Hạng mục / Thể loại</div>
                <div class="info-val">${categorySafe}</div>
            </div>
            <div>
                <div class="info-label">Nhân sự thực hiện</div>
                <div class="info-val">${escapeHtml([order.stylist, order.assignedVideo, order.assignedPhoto, order.assignedDesign].filter(x => x && x !== '-').join(' • ') || 'Theo phân công bộ phận')}</div>
            </div>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th style="width: 44px;">STT</th>
                <th>Nội dung Hạng mục / Chi phí</th>
                <th style="width: 90px; text-align: center;">Đơn vị</th>
                <th style="width: 85px; text-align: right;">SL</th>
                <th style="width: 135px; text-align: right;">Đơn giá (₫)</th>
                <th style="width: 145px; text-align: right;">Thành tiền (₫)</th>
            </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
    </table>

    <div class="summary">
        <div class="qr-wrap">
            <div class="qr-code">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=86x86&data=${qrData}" alt="QR Tra cứu" style="width:86px;height:86px;border-radius:4px;"/>
            </div>
            <div style="font-size:11px;color:#64748b;max-width:240px;line-height:1.45;">
                <strong style="color:#0f172a;">Mã QR đối soát điện tử</strong><br/>
                Quét để tra cứu trạng thái, lịch sử phê duyệt và chứng từ gốc của đơn <strong>#${codeSafe}</strong>.
            </div>
        </div>
        <div class="total-box">
            <div class="total-label">Tổng dự toán / quyết toán</div>
            <div class="total-val">${totalAmount}</div>
        </div>
    </div>

    <div class="footer-signatures">
        <div>
            <div class="sig-title">Người Lập Phiếu</div>
            <div style="height: 54px; display:flex; align-items:center; justify-content:center; font-size:11px; color:#475569; font-weight:700;">${requesterSafe}</div>
            <div class="sig-name">(Ký & ghi rõ họ tên)</div>
        </div>
        <div>
            <div class="sig-title">Trưởng Bộ Phận / Duyệt</div>
            ${electronicStampHtml}
            <div class="sig-name">${approverSafe || '(Ký & ghi rõ họ tên)'}</div>
        </div>
        <div>
            <div class="sig-title">Kế Toán / Duyệt Chi</div>
            <div style="height: 54px;"></div>
            <div class="sig-name">(Ký & ghi rõ họ tên)</div>
        </div>
    </div>

    <script>
        window.onload = function() {
            setTimeout(function() { window.print(); }, 450);
        };
    </script>
</body>
</html>`;

    printWindow.document.open();
    printWindow.document.write(htmlContent);
    printWindow.document.close();
}

window.printOrderVoucher = printOrderVoucher;
