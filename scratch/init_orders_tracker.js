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
            if (currentPage === 'orders') window.renderOrdersTable();
            if (currentPage === 'dashboard') window.renderDashboardTable();
            
            if (currentPage === 'reports') {
                window.renderReports();
                if (typeof window.renderCategoryStats === 'function') window.renderCategoryStats();
            }
            if (currentPage === 'detailed-report') {
                if (typeof window.renderDetailedReport === 'function') window.renderDetailedReport();
            }
            if (currentPage === 'planning') {
                if (typeof window.renderPlanningReport === 'function') window.renderPlanningReport();
            }
            if (currentPage === 'budgetReport') {
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
