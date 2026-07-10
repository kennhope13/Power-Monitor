// ============================================================
// auto-device-test.js — Tự động test workflow add/delete device
// Chạy: node test/auto-device-test.js
// Yêu cầu: backend + frontend đã chạy
// ============================================================

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const FRONTEND_URL = 'http://localhost:5173';
const ADMIN_USER = 'stationadmin';
const ADMIN_PASS = 'Station@123';

const screenshotDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const shot = async (page, name) => {
  const file = path.join(screenshotDir, `${Date.now()}_${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  log(`   📸 ${path.basename(file)}`);
};

(async () => {
  log('🚀 Khởi động Playwright (Chromium headless=true)');
  const browser = await chromium.launch({ headless: true, slowMo: 100 });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Bắt console error
  page.on('pageerror', err => log(`   ❌ Browser error: ${err.message}`));
  page.on('console', msg => {
    if (msg.type() === 'error') log(`   ⚠ Console: ${msg.text().slice(0, 200)}`);
  });

  try {
    // ── 1. LOGIN ──────────────────────────────────────────────
    log('1️⃣  Clear localStorage rồi mở /login');
    await page.goto(FRONTEND_URL);
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await page.goto(FRONTEND_URL + '/login');
    await page.waitForTimeout(1500);
    await shot(page, '01_login_page');

    log('   Điền thông tin config & admin');
    await page.fill('#serverIpInput', '127.0.0.1');
    await page.fill('#stationNameInput', 'Trạm Tân An 110kV');
    await page.fill('#loginUsername', ADMIN_USER);
    await page.fill('#loginPassword', ADMIN_PASS);
    await shot(page, '02_login_filled');

    log('   Submit form');
    await page.click('button.gm-btn-login, button[type="submit"]');
    await page.waitForTimeout(3000);
    await shot(page, '03_after_login');

    // ── 2. NAVIGATE TO DEVICE MANAGEMENT ─────────────────────
    log('2️⃣  Vào trang Device Management');
    await page.goto(`${FRONTEND_URL}/device-management`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await shot(page, '04_device_management');

    // Đếm số device hiện có
    const initialRows = await page.locator('table tbody tr').count();
    log(`   📊 Số device hiện có: ${initialRows}`);

    // ── 3. CLICK "+ Thêm thiết bị" ──────────────────────────
    log('3️⃣  Click nút "+ Thêm thiết bị"');
    const addBtn = page.locator('button:has-text("Thêm thiết bị")').first();
    if (await addBtn.count() > 0) {
      await addBtn.click();
      await page.waitForTimeout(1000);
      await shot(page, '05_add_device_modal');
    } else {
      log('   ⚠ Không tìm thấy nút "+ Thêm thiết bị" — bỏ qua add test');
    }

    // ── 4. Điền form ─────────────────────────────────────────
    log('4️⃣  Điền thông tin device test');
    try {
      await page.fill('input[placeholder*="PLC"], input[placeholder*="VD"]', 'Test Device Playwright');
      // Chọn type modbus_tcp (đơn giản)
      const typeSelect = page.locator('select').first();
      await typeSelect.selectOption({ value: 'modbus_tcp' });
      // Điền IP test
      const ipInput = page.locator('input[placeholder*="192.168"]').first();
      await ipInput.fill('10.0.0.99');
      await shot(page, '06_form_filled');

      log('   Click Lưu thiết bị');
      const saveBtn = page.locator('button:has-text("Lưu thiết bị")').first();
      await saveBtn.click();
      await page.waitForTimeout(2000);
      // Dismiss alert nếu có
      page.on('dialog', dialog => dialog.accept());
      await shot(page, '07_after_save');
    } catch (e) {
      log(`   ⚠ Lỗi điền form: ${e.message}`);
    }

    // ── 5. Verify device mới xuất hiện ──────────────────────
    log('5️⃣  Verify device mới đã hiện');
    await page.waitForTimeout(2000);
    const afterAddRows = await page.locator('table tbody tr').count();
    log(`   📊 Số device sau add: ${afterAddRows} (trước: ${initialRows})`);
    if (afterAddRows > initialRows) {
      log('   ✅ ADD device THÀNH CÔNG');
    } else {
      log('   ❌ ADD device KHÔNG TĂNG row — có thể lỗi');
    }
    await shot(page, '08_device_list_after_add');

    // ── 6. Xóa device vừa thêm ──────────────────────────────
    log('6️⃣  Tìm và xóa device "Test Device Playwright"');
    const row = page.locator('tr:has-text("Test Device Playwright")').first();
    if (await row.count() > 0) {
      const dropdownTrigger = row.locator('button[title="Thao tác"]').first();
      await dropdownTrigger.click();
      await page.waitForTimeout(1000);
      await shot(page, '08_5_dropdown_open');

      const deleteBtn = page.locator('button:has-text("Xóa thiết bị")').first();
      if (await deleteBtn.count() > 0) {
        await deleteBtn.click();
        await page.waitForTimeout(1000);
        await shot(page, '08_7_confirm_modal_visible');

        log('   Click nút xác nhận xóa (#ccd-confirm)');
        await page.locator('#ccd-confirm').click();
        await page.waitForTimeout(3000);
        await shot(page, '09_after_delete');

        const afterDeleteRows = await page.locator('table tbody tr').count();
        log(`   📊 Số device sau delete: ${afterDeleteRows}`);
        if (afterDeleteRows === initialRows) {
          log('   ✅ DELETE device THÀNH CÔNG (trở về số ban đầu)');
        } else {
          log(`   ⚠ Số row sau delete = ${afterDeleteRows}, expected ${initialRows}`);
        }
      } else {
        log('   ⚠ Không tìm thấy nút Xóa thiết bị trong dropdown');
      }
    } else {
      log('   ⚠ Không tìm thấy hàng chứa Test Device Playwright');
    }

    // ── 7. Kiểm tra các trang khác ──────────────────────────
    log('7️⃣  Vào trang Realtime Monitor');
    await page.goto(`${FRONTEND_URL}/realtime`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
    await shot(page, '10_realtime_monitor');

    log('8️⃣  Vào trang Dashboard');
    await page.goto(`${FRONTEND_URL}/dashboard`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
    await shot(page, '11_dashboard');

    log('9️⃣  Vào trang Analytics');
    await page.goto(`${FRONTEND_URL}/analytics`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
    await shot(page, '12_analytics');

    log('🎉 Test xong! Screenshots ở: ' + screenshotDir);

  } catch (e) {
    log(`❌ FATAL: ${e.message}`);
    await shot(page, 'fatal_error');
  } finally {
    await page.waitForTimeout(2000);
    await browser.close();
  }
})();
