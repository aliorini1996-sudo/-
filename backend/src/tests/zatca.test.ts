// اختبارات ترميز ZATCA TLV — يفكّك الرمز الناتج ويطابقه مع المواصفة (المرحلة الأولى)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zatcaQrBase64, zatcaProvider } from '../compliance/zatca';

// يفكّك سلسلة TLV إلى خريطة {وسم → قيمة} مع التحقق من أن الطول = طول البايتات فعلاً
function parseTlv(base64: string): Map<number, string> {
  const buf = Buffer.from(base64, 'base64');
  const out = new Map<number, string>();
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i];
    const len = buf[i + 1];
    const val = buf.subarray(i + 2, i + 2 + len);
    assert.equal(val.length, len, `طول الحقل ${tag} لا يطابق المعلَن`);
    out.set(tag, val.toString('utf8'));
    i += 2 + len;
  }
  return out;
}

test('TLV: الحقول الخمسة بقيمها الصحيحة، وطول العربية بالبايت لا بالحرف', () => {
  const qr = zatcaQrBase64({
    sellerName: 'شركة الاختبار',            // عربي — كل حرف 2 بايت UTF-8
    vatNumber: '310123456789003',
    timestampIso: '2026-07-02T10:30:00Z',
    total: '115.00',
    vatTotal: '15.00',
  });
  const f = parseTlv(qr);
  assert.equal(f.get(1), 'شركة الاختبار');
  assert.equal(f.get(2), '310123456789003');
  assert.equal(f.get(3), '2026-07-02T10:30:00Z');
  assert.equal(f.get(4), '115.00');
  assert.equal(f.get(5), '15.00');
  assert.equal(f.size, 5);
});

test('التفكيك يعيد البناء بايتاً ببايت (لا فقد ولا زيادة)', () => {
  const qr = zatcaQrBase64({ sellerName: 'X', vatNumber: '3', timestampIso: 'T', total: '1.00', vatTotal: '0.15' });
  const buf = Buffer.from(qr, 'base64');
  // مجموع الأطوال: لكل حقل 2 (وسم+طول) + طول القيمة
  const expected = 2 + 1 + 2 + 1 + 2 + 1 + 2 + 4 + 2 + 4;
  assert.equal(buf.length, expected);
});

test('zatcaProvider.build: ينجح ويعيد qr بحالة generated ومبالغ بخانتين', async () => {
  const res = await zatcaProvider.build({
    seller: { name: 'مؤسسة التوزيع', taxNumber: '311111111111113' },
    issuedAt: new Date('2026-07-02T08:00:00Z'),
    total: 230,
    vatTotal: 30,
    currency: 'SAR',
  });
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'zatca');
  assert.equal(res.status, 'generated');
  const f = parseTlv(res.qr!);
  assert.equal(f.get(4), '230.00');
  assert.equal(f.get(5), '30.00');
});
