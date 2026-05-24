try {
const window = {};
window._normalizeDateToYMD = function(dateVal) {
    if (!dateVal) return '';
    if (dateVal.toDate && typeof dateVal.toDate === 'function') {
        const d = dateVal.toDate();
        return `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`;
    }
    if (dateVal.seconds) {
        const d = new Date(dateVal.seconds * 1000);
        return `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`;
    }
    if (typeof dateVal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
        return dateVal;
    }
    if (typeof dateVal === 'string' && dateVal.includes('T')) {
        const d = new Date(dateVal);
        return `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`;
    }
    const d = new Date(dateVal);
    if (!isNaN(d)) {
        return `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`;
    }
    return '';
};

const toLocalDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const weekDates = [new Date()];
const weekDatesStr = weekDates.map(d => toLocalDateStr(d));
const assignedStaffNames = new Set();
window.allOrdersData = [{
    deployDate: "2026-05-21", deadline: "2026-05-21", assignedVideo: 'Dung', assignedPhoto: 'Hoa'
}];

// Simulate what we added
window.allOrdersData.forEach(o => {
    const dateStr = window._normalizeDateToYMD(o.deployDate) || window._normalizeDateToYMD(o.deadline) || '';
    if (weekDatesStr.includes(dateStr)) {
        if (o.assignedVideo && o.assignedVideo !== '-') assignedStaffNames.add(o.assignedVideo);
        if (o.assignedPhoto && o.assignedPhoto !== '-') assignedStaffNames.add(o.assignedPhoto);
        if (o.assignedDesign && o.assignedDesign !== '-') assignedStaffNames.add(o.assignedDesign);
        if (o.stylist && o.stylist !== '-') assignedStaffNames.add(o.stylist);
    }
});
console.log("No error!");
} catch(e) {
    console.log("Error:", e);
}
