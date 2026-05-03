/* 
  APP CONFIGURATION & CONSTANTS
  Shared between index.html and admin.html
*/

export const firebaseConfig = {
  apiKey: "AIzaSyDkcMFNMsw0rzuW3PVaFk-q4oIVRY4NIg0",
  authDomain: "nevotask.firebaseapp.com",
  projectId: "nevotask",
  storageBucket: "nevotask.firebasestorage.app",
  messagingSenderId: "1031918825498",
  appId: "1:1031918825498:web:16f85584b81072db0be1a3"
};

export const DEFAULT_DEPTS = [
    "Ban Giám Đốc", "Kế toán", "Kỹ thuật", "Logistics", "Marketing", "Nhân sự", "Sản xuất", "IT",
    "Phòng Kế hoạch & Kinh doanh", "Ban Điều hành Dự án", "Phòng Nhân sự", "Tổ Kỹ thuật - Hạ tầng"
];

export const DEFAULT_STATUSES = [
    { name: "Chờ duyệt", order: 1, color: "bg-blue-50 text-blue-700" },
    { name: "Đang xử lý", order: 2, color: "bg-amber-50 text-amber-700" },
    { name: "Hoàn thành", order: 3, color: "bg-emerald-50 text-emerald-700" },
    { name: "Từ chối", order: 4, color: "bg-rose-50 text-rose-700" }
];

export const APP_VERSION = "2.0.0-Premium";
