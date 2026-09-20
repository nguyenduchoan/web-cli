(() => {
  const normalize = (value, max) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/Đ/g, 'D').replace(/đ/g, 'd').toUpperCase().replace(/[^A-Z0-9 .\-_/]/g, '').slice(0, max);
  const tlv = (id, value) => { if (!value.length || value.length > 99) throw new Error('Độ dài trường dữ liệu phải từ 1 đến 99 ký tự.'); return id + String(value.length).padStart(2, '0') + value; };
  function crc16(text) { let crc = 0xFFFF; for (let i = 0; i < text.length; i++) { crc ^= text.charCodeAt(i) << 8; for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF; } return crc.toString(16).toUpperCase().padStart(4, '0'); }
  function buildPayload(fields) {
    const account = (fields.account || '').trim();
    const amount = (fields.amount || '').trim();
    const purpose = normalize((fields.purpose || '').trim(), 25);
    if (!/^\d{1,19}$/.test(account)) throw new Error('Số tài khoản / số thẻ chỉ được gồm 1–19 chữ số.');
    if (amount && (amount.length > 13 || !/^\d+\.?$/.test(amount) || Number(amount) <= 0)) throw new Error('Số tiền VND phải là số nguyên dương, tối đa 13 ký tự.');
    if (!/^\d{6}$/.test(fields.bin)) throw new Error('Mã ngân hàng phải gồm 6 chữ số.');
    if (!['11', '12'].includes(fields.mode) || !['QRIBFTTA', 'QRIBFTTC'].includes(fields.service)) throw new Error('Loại mã hoặc dịch vụ không hợp lệ.');
    const nested = tlv('00', 'A000000727') + tlv('01', tlv('00', (fields.bin || '')) + tlv('01', account)) + tlv('02', (fields.service || ''));
    let payload = tlv('00', '01') + tlv('01', (fields.mode || '')) + tlv('38', nested) + tlv('53', '704');
    if (amount) payload += tlv('54', amount);
    payload += tlv('58', 'VN');
    const merchant = normalize((fields.merchant || '').trim(), 25);
    if (merchant) payload += tlv('59', merchant);
    const city = normalize((fields.city || '').trim(), 15);
    if (city) payload += tlv('60', city);
    if (purpose) payload += tlv('62', tlv('08', purpose));
    return payload + '6304' + crc16(payload + '6304');
  }
  globalThis.VietQR = { normalize, crc16, buildPayload };
})();
