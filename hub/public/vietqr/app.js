(() => {
  const $ = id => document.getElementById(id);
  const form = $('qr-form');
  const fields = ['account', 'amount', 'purpose', 'bin', 'service', 'mode', 'merchant', 'city'];
  let revision = 0;
  let logoRevision = 0;
  let logoReady = Promise.resolve(null);
  let renderedAccount = '';

  function showError(error) {
    $('error').textContent = error.message || 'Không thể tạo mã QR. Vui lòng thử lại.';
    $('error').hidden = false;
  }
  function invalidate() {
    revision++;
    $('qr-output').replaceChildren();
    $('qr-empty').hidden = false;
    $('preview-meta').hidden = true;
    $('download').disabled = true;
    $('error').hidden = true;
  }
  form.addEventListener('input', invalidate);
  form.addEventListener('change', invalidate);

  function loadLogo(file) {
    if (!file) return Promise.resolve(null);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return Promise.reject(new Error('Chọn ảnh PNG, JPG hoặc WebP.'));
    if (file.size > 2 * 1024 * 1024) return Promise.reject(new Error('Logo cần nhỏ hơn 2 MB.'));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const fail = () => reject(new Error('Không đọc được logo. Hãy chọn ảnh PNG, JPG hoặc WebP hợp lệ.'));
      reader.onerror = fail;
      reader.onabort = fail;
      reader.onload = () => {
        const image = new Image();
        image.onerror = fail;
        image.onload = () => resolve(image);
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
  $('logo').addEventListener('change', event => {
    const selected = ++logoRevision;
    const file = event.target.files[0];
    $('file-name').hidden = true;
    logoReady = loadLogo(file);
    logoReady.then(() => {
      if (selected !== logoRevision || !file) return;
      $('file-name').textContent = '✓ ' + file.name;
      $('file-name').hidden = false;
    }).catch(error => { if (selected === logoRevision) showError(error); });
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    invalidate();
    const current = revision;
    const values = Object.fromEntries(fields.map(id => [id, $(id).value.trim()]));
    try {
      const payload = VietQR.buildPayload(values);
      const logo = await logoReady;
      const canvas = document.createElement('canvas');
      await QRCode.toCanvas(canvas, payload, {
        errorCorrectionLevel: 'H', margin: 4, width: 580,
        color: { dark: '#071b35', light: '#ffffff' },
      });
      // The renderer sets fixed CSS dimensions too. Let responsive CSS size the
      // preview while keeping the 580 x 580 bitmap for the PNG download.
      canvas.style.removeProperty('width');
      canvas.style.removeProperty('height');
      if (logo) {
        const ctx = canvas.getContext('2d');
        const box = canvas.width * .15;
        const scale = box / Math.max(logo.naturalWidth, logo.naturalHeight);
        const width = logo.naturalWidth * scale;
        const height = logo.naturalHeight * scale;
        const x = (canvas.width - width) / 2;
        const y = (canvas.height - height) / 2;
        ctx.fillStyle = '#fff';
        ctx.fillRect(x - 4, y - 4, width + 8, height + 8);
        ctx.drawImage(logo, x, y, width, height);
      }
      if (current !== revision) return;
      $('qr-output').replaceChildren(canvas);
      renderedAccount = values.account;
      $('qr-empty').hidden = true;
      $('preview-meta').hidden = false;
      $('download').disabled = false;
      $('preview-name').textContent = VietQR.normalize(values.merchant, 25) || 'VietQR';
      $('preview-account').textContent = values.account;
      $('preview-amount').textContent = values.amount ? Number(values.amount).toLocaleString('vi-VN') + ' ₫' : 'Nhập số tiền khi thanh toán';
    } catch (error) { if (current === revision) showError(error); }
  });

  document.querySelectorAll('.segment').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.segment').forEach(b => b.classList.remove('active'));
    button.classList.add('active');
    $('service').value = button.dataset.target === 'card' ? 'QRIBFTTC' : 'QRIBFTTA';
    $('account').placeholder = button.dataset.target === 'card' ? 'Nhập số thẻ' : 'Nhập số tài khoản';
    invalidate();
  }));
  $('download').addEventListener('click', () => {
    const canvas = $('qr-output').querySelector('canvas');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = 'vietqr-' + renderedAccount + '.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  });
})();
