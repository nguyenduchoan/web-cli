// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const scope = {};
vm.runInNewContext(readFileSync(new URL('../../hub/public/vietqr/payload.js', import.meta.url), 'utf8'), scope);
const { buildPayload, crc16 } = scope.VietQR;
const base = { bin: '970403', account: '0011012345678', service: 'QRIBFTTA', mode: '11' };
function parse(text) {
  const result = {};
  for (let i = 0; i < text.length;) {
    const id = text.slice(i, i + 2), length = Number(text.slice(i + 2, i + 4));
    assert.ok(length > 0 && i + 4 + length <= text.length);
    assert.ok(!(id in result));
    result[id] = text.slice(i + 4, i + 4 + length);
    i += 4 + length;
  }
  return result;
}
test('CRC known vector and PDF static card example', () => {
  assert.equal(crc16('123456789'), '29B1');
  assert.equal(buildPayload({...base, account:'9704031101234567', service:'QRIBFTTC'}), '00020101021138600010A00000072701300006970403011697040311012345670208QRIBFTTC53037045802VN63044F52');
});
test('account/card static/dynamic nested TLV and checksum', () => {
  for (const mode of ['11', '12']) for (const service of ['QRIBFTTA', 'QRIBFTTC']) {
    const payload = buildPayload({...base, mode, service, amount:'180000', purpose:'Thanh toán đơn hàng'});
    const root = parse(payload), info = parse(root['38']), account = parse(info['01']);
    assert.equal(root['00'], '01'); assert.equal(root['01'], mode);
    assert.equal(info['00'], 'A000000727'); assert.equal(info['02'], service);
    assert.equal(account['00'], base.bin); assert.equal(account['01'], base.account);
    assert.equal(root['53'], '704'); assert.equal(root['54'], '180000'); assert.equal(root['58'], 'VN');
    assert.equal(parse(root['62'])['08'], 'THANH TOAN DON HANG');
    assert.equal(root['63'], crc16(payload.slice(0,-4)));
  }
});
test('VND amounts, identifiers and empty normalized optional fields', () => {
  for (const amount of ['0','-1','12.34','1e3','50 000','12345678901234']) assert.throws(()=>buildPayload({...base, amount}));
  for (const amount of ['50000','50000.']) assert.equal(parse(buildPayload({...base,amount}))['54'], amount);
  for (const account of ['', '12345678901234567890', '12 34']) assert.throws(()=>buildPayload({...base,account}));
  assert.throws(()=>buildPayload({...base,bin:'abc'}));
  const root=parse(buildPayload({...base,merchant:'😊',city:'😊'}));
  assert.equal(root['59'], undefined); assert.equal(root['60'], undefined);
});
