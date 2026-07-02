// ============================================================
// confirmDialog — Custom confirm modal thay thế window.confirm
// Dùng: await confirmDialog({ message: '...', danger: true })
// ============================================================

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;       // true → nút xác nhận màu đỏ
}

// Singleton overlay — tạo một lần, tái sử dụng cho tất cả lần gọi
let _overlay: HTMLElement | null = null;

/** Tạo hoặc tái sử dụng overlay singleton để hiển thị hộp thoại xác nhận. */
function ensureOverlay(): HTMLElement {
  if (_overlay && document.body.contains(_overlay)) return _overlay;

  _overlay = document.createElement('div');
  _overlay.id = 'custom-confirm-overlay';
  _overlay.innerHTML = `
    <div id="custom-confirm-box" style="
      background: var(--admin-panel);
      border: 1px solid var(--admin-border);
      border-radius: 0;
      box-shadow: var(--admin-shadow-lg, 0 10px 30px rgba(0,0,0,0.3));
      padding: 0;
      min-width: 320px;
      max-width: 420px;
      width: 90%;
      overflow: hidden;
      transform: scale(0.92);
      transition: transform 0.15s ease;
    ">
      <div style="
        background: var(--admin-bg);
        padding: 14px 20px;
        border-bottom: 1px solid var(--admin-border);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
      ">
        <span id="ccd-icon" style="font-size: 1.1rem; display: flex; align-items: center;"></span>
        <span id="ccd-title" style="font-size: 0.8rem; font-weight: 800; color: var(--admin-text); text-transform: uppercase; letter-spacing: 0.5px;"></span>
      </div>
      <div style="padding: 18px 20px;">
        <p id="ccd-message" style="margin: 0 0 20px; font-size: 0.82rem; color: var(--admin-text); opacity: 0.85; line-height: 1.6; text-align: center;"></p>
        <div style="display: flex; gap: 10px; justify-content: flex-end;">
          <button id="ccd-cancel" style="
            padding: 8px 18px;
            background: var(--admin-bg);
            border: 1px solid var(--admin-border);
            border-radius: 0;
            color: var(--admin-text);
            font-size: 0.78rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s;"
            onmouseover="this.style.background='var(--admin-hover)'"
            onmouseout="this.style.background='var(--admin-bg)'">
          </button>
          <button id="ccd-confirm" style="
            padding: 8px 18px;
            border: none;
            border-radius: 0;
            font-size: 0.78rem;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.15s;">
          </button>
        </div>
      </div>
    </div>
  `;
  Object.assign(_overlay.style, {
    position: 'fixed', inset: '0', zIndex: '9999',
    background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(3px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    opacity: '0', transition: 'opacity 0.15s ease',
  });
  document.body.appendChild(_overlay);
  return _overlay;
}

/**
 * Hiển thị hộp thoại xác nhận tùy chỉnh thay thế window.confirm.
 * Trả về Promise<true> nếu người dùng xác nhận, Promise<false> nếu hủy.
 */
export function confirmDialog(opts: ConfirmOptions | string): Promise<boolean> {
  const options: ConfirmOptions = typeof opts === 'string' ? { message: opts } : opts;
    const {
      title       = options.danger ? 'Xác nhận xóa' : 'Xác nhận',
      message,
      confirmText = options.danger ? 'Xóa' : 'Xác nhận',
      cancelText  = '',
      danger      = false,
    } = options;

  return new Promise(resolve => {
    const overlay = ensureOverlay();

    (overlay.querySelector('#ccd-icon')     as HTMLElement).textContent = danger ? '⚠️' : 'ℹ️';
    (overlay.querySelector('#ccd-title')    as HTMLElement).textContent = title;
    (overlay.querySelector('#ccd-message')  as HTMLElement).textContent = message;
    const cancelBtn = overlay.querySelector('#ccd-cancel') as HTMLElement;
    cancelBtn.textContent = cancelText || 'X';
    cancelBtn.title = cancelText ? cancelText : 'Đóng';
    Object.assign(cancelBtn.style, cancelText
      ? {
          minWidth: '',
          padding: '8px 18px',
        }
      : {
          minWidth: '42px',
          padding: '8px 12px',
          textAlign: 'center',
          fontWeight: '800',
        });

    const confirmBtn = overlay.querySelector('#ccd-confirm') as HTMLElement;
    confirmBtn.textContent = confirmText;
    Object.assign(confirmBtn.style, {
      background: danger ? '#ef4444' : 'var(--admin-accent, #3b82f6)',
      color: '#ffffff',
      border: 'none',
      boxShadow: danger ? '0 2px 8px rgba(239, 68, 68, 0.3)' : '0 2px 8px rgba(59, 130, 246, 0.3)',
    });

    // Hover effect cho confirm button
    confirmBtn.onmouseover = () => {
      confirmBtn.style.transform = 'translateY(-1px)';
      confirmBtn.style.boxShadow = danger ? '0 4px 12px rgba(239, 68, 68, 0.4)' : '0 4px 12px rgba(59, 130, 246, 0.4)';
    };
    confirmBtn.onmouseout = () => {
      confirmBtn.style.transform = 'translateY(0)';
      confirmBtn.style.boxShadow = danger ? '0 2px 8px rgba(239, 68, 68, 0.3)' : '0 2px 8px rgba(59, 130, 246, 0.3)';
    };

    // Animate in
    overlay.style.display = 'flex';
    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      (overlay.querySelector('#custom-confirm-box') as HTMLElement).style.transform = 'scale(1)';
    });

    const close = (result: boolean) => {
      overlay.style.opacity = '0';
      (overlay.querySelector('#custom-confirm-box') as HTMLElement).style.transform = 'scale(0.92)';
      setTimeout(() => { overlay.style.display = 'none'; }, 150);
      resolve(result);
    };

    // Clone node để xóa event listener cũ — tránh gọi callback sai khi mở lại
    const newCancel  = (overlay.querySelector('#ccd-cancel')  as HTMLElement).cloneNode(true) as HTMLElement;
    const newConfirm = (overlay.querySelector('#ccd-confirm') as HTMLElement).cloneNode(true) as HTMLElement;
    overlay.querySelector('#ccd-cancel')!.replaceWith(newCancel);
    overlay.querySelector('#ccd-confirm')!.replaceWith(newConfirm);

    newCancel.addEventListener('click',  () => close(false));
    newConfirm.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); }, { once: true });

    // Keyboard: Enter = confirm, Escape = cancel
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter')  { document.removeEventListener('keydown', onKey); close(true); }
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(false); }
    };
    document.addEventListener('keydown', onKey);
  });
}
