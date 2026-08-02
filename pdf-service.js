/* 
  PDF SERVICE
  Generate and print high-quality PDF purchase/material order vouchers
*/

export function printOrderVoucher(order) {
    if (!order) return;

    const printWindow = window.open('', '_blank', 'width=900,height=800');
    if (!printWindow) {
        alert('Trình duyệt đã chặn cửa sổ bật lên. Vui lòng cho phép popup để in phiếu đơn hàng.');
        return;
    }

    const createdDate = order.createdAt ? new Date(order.createdAt).toLocaleDateString('vi-VN') : new Date().toLocaleDateString('vi-VN');
    const items = order.items || order.materials || [];
    const totalAmount = order.totalCost ? new Number(order.totalCost).toLocaleString('vi-VN') + ' ₫' : (order.amount ? new Number(order.amount).toLocaleString('vi-VN') + ' ₫' : 'N/A');

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <title>Phiếu Đơn Hàng Nguyên Liệu #${order.code || order.id || ''}</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
            body { font-family: 'Inter', sans-serif; background: #fff; color: #1e293b; padding: 40px; margin: 0; }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #b80035; padding-bottom: 20px; margin-bottom: 30px; }
            .logo-area { display: flex; align-items: center; gap: 12px; }
            .logo-title { font-size: 24px; font-weight: 800; color: #b80035; margin: 0; text-transform: uppercase; letter-spacing: -0.5px; }
            .logo-sub { font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }
            .voucher-title { text-align: right; }
            .voucher-title h1 { font-size: 22px; margin: 0; color: #0f172a; font-weight: 800; text-transform: uppercase; }
            .voucher-title p { font-size: 13px; color: #64748b; margin: 4px 0 0; }
            
            .grid-info { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 30px; background: #f8fafc; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; }
            .info-item { font-size: 13px; }
            .info-label { font-weight: 600; color: #64748b; margin-bottom: 4px; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
            .info-val { font-weight: 700; color: #0f172a; font-size: 14px; }

            table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
            th { background: #f1f5f9; text-align: left; padding: 12px 16px; font-size: 11px; font-weight: 700; color: #475569; text-transform: uppercase; border-bottom: 2px solid #cbd5e1; }
            td { padding: 14px 16px; font-size: 13px; border-bottom: 1px solid #e2e8f0; color: #334155; }
            tr:last-child td { border-bottom: none; }
            
            .summary { display: flex; justify-content: space-between; align-items: flex-start; margin-top: 20px; }
            .qr-code { width: 100px; height: 100px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #94a3b8; text-align: center; }
            .total-box { text-align: right; background: #fff1f2; border: 1px solid #fecdd3; padding: 16px 24px; border-radius: 12px; }
            .total-label { font-size: 12px; color: #9f1239; font-weight: 700; text-transform: uppercase; }
            .total-val { font-size: 24px; color: #b80035; font-weight: 800; margin-top: 4px; }

            .footer-signatures { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 60px; text-align: center; }
            .sig-box { font-size: 12px; }
            .sig-title { font-weight: 700; color: #334155; margin-bottom: 60px; text-transform: uppercase; font-size: 11px; }
            .sig-name { font-weight: 600; color: #64748b; border-top: 1px dashed #cbd5e1; pt-2; display: inline-block; width: 80%; }

            @media print {
                body { padding: 0; }
                .no-print { display: none; }
            }
        </style>
    </head>
    <body>
        <div class="header">
            <div class="logo-area">
                <div>
                    <h2 class="logo-title">NEVO TASK</h2>
                    <div class="logo-sub">Hệ thống Quản lý Nguyên liệu & Đơn hàng</div>
                </div>
            </div>
            <div class="voucher-title">
                <h1>PHIẾU ĐƠN HÀNG NGUYÊN LIỆU</h1>
                <p>Mã đơn: <strong>#${order.code || order.id || 'N/A'}</strong> | Ngày: ${createdDate}</p>
            </div>
        </div>

        <div class="grid-info">
            <div>
                <div class="info-item" style="margin-bottom: 12px;">
                    <div class="info-label">Đơn vị / Phòng ban</div>
                    <div class="info-val">${order.dept || order.department || 'Chưa xác định'}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Người yêu cầu</div>
                    <div class="info-val">${order.createdByName || order.createdBy || 'N/A'}</div>
                </div>
            </div>
            <div>
                <div class="info-item" style="margin-bottom: 12px;">
                    <div class="info-label">Trạng thái phê duyệt</div>
                    <div class="info-val" style="color: #b80035;">${order.status || 'Chờ duyệt'}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Model / Dòng máy</div>
                    <div class="info-val">${order.model || order.modelName || 'Mặc định'}</div>
                </div>
            </div>
        </div>

        <table>
            <thead>
                <tr>
                    <th style="width: 50px;">STT</th>
                    <th>Tên Nguyên liệu / Vật tư</th>
                    <th style="width: 100px; text-align: center;">Đơn vị</th>
                    <th style="width: 100px; text-align: right;">Số lượng</th>
                    <th style="width: 140px; text-align: right;">Đơn giá (₫)</th>
                    <th style="width: 150px; text-align: right;">Thành tiền (₫)</th>
                </tr>
            </thead>
            <tbody>
                ${items.length > 0 ? items.map((item, idx) => `
                    <tr>
                        <td>${idx + 1}</td>
                        <td><strong>${item.name || item.materialName || 'Nguyên liệu'}</strong></td>
                        <td style="text-align: center;">${item.unit || 'Cái'}</td>
                        <td style="text-align: right; font-weight: 700;">${item.qty || item.quantity || 1}</td>
                        <td style="text-align: right;">${item.price ? new Number(item.price).toLocaleString('vi-VN') : '0'}</td>
                        <td style="text-align: right; font-weight: 700;">${item.price && (item.qty || item.quantity) ? new Number(item.price * (item.qty || item.quantity)).toLocaleString('vi-VN') : '0'}</td>
                    </tr>
                `).join('') : `
                    <tr>
                        <td>1</td>
                        <td><strong>${order.title || order.name || 'Chi phí nguyên liệu tổng hợp'}</strong></td>
                        <td style="text-align: center;">Bộ</td>
                        <td style="text-align: right; font-weight: 700;">1</td>
                        <td style="text-align: right;">${totalAmount}</td>
                        <td style="text-align: right; font-weight: 700;">${totalAmount}</td>
                    </tr>
                `}
            </tbody>
        </table>

        <div class="summary">
            <div class="qr-code">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=90x90&data=NEVO-TASK-${order.code || order.id}" alt="QR" style="width:90px;height:90px;border-radius:4px;"/>
            </div>
            <div class="total-box">
                <div class="total-label">Tổng tiền đơn hàng</div>
                <div class="total-val">${totalAmount}</div>
            </div>
        </div>

        <div class="footer-signatures">
            <div class="sig-box">
                <div class="sig-title">Người Lập Phiếu</div>
                <div class="sig-name">(Ký & Họ tên)</div>
            </div>
            <div class="sig-box">
                <div class="sig-title">Trưởng Phòng Xạ / Duyệt</div>
                <div class="sig-name">(Ký & Họ tên)</div>
            </div>
            <div class="sig-box">
                <div class="sig-title">Kế Toán / Duyệt Chi</div>
                <div class="sig-name">(Ký & Họ tên)</div>
            </div>
        </div>

        <script>
            window.onload = function() {
                setTimeout(function() {
                    window.print();
                }, 500);
            };
        </script>
    </body>
    </html>
    `;

    printWindow.document.open();
    printWindow.document.write(htmlContent);
    printWindow.document.close();
}

window.printOrderVoucher = printOrderVoucher;
