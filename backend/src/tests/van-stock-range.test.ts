import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldStock, type LoadRow, type InvRow } from '../routes/vanStock';

/**
 * تصفية مخزون السيارة بالتاريخ — الفرق بين الرصيد والتدفّق.
 *
 * الفخّ الذي تحرسه هذه الاختبارات: «المحمَّل» و«المُباع» تدفّقات تُصفَّى بالمدّة،
 * لكن «المتبقّي» **رصيدٌ** لا يخصّ مدّة. لو صُفِّي هو الآخر داخل النافذة لظهر
 * مندوبٌ حُمِّل الشهر الماضي وباع هذا الشهر برصيد **سالب** — وهو رقمٌ يقرأه
 * المالك على أنه عجز في السيارة ولا وجود له.
 *
 * الصفوف تصل هنا مقيَّدةً بنهاية المدّة من الاستعلام، و`from` يُرشَّح داخل الطيّ.
 */

const D = (s: string) => new Date(s + 'T10:00:00.000Z');
const load = (productId: string, qty: number, date: string, type = 'LOAD'): LoadRow =>
  ({ productId, qty, vanLoad: { type, createdAt: D(date) } });
const sale = (productId: string, qty: number, date: string, type = 'CASH', returnToStock: boolean | null = null): InvRow =>
  ({ productId, qty, invoice: { type, returnToStock, invoiceDate: D(date) } });

const remaining = (b: { loaded: number; unloaded: number; adjusted: number; sold: number; returned: number }) =>
  b.loaded - b.unloaded + b.adjusted - b.sold + b.returned;

test('بلا نافذة: التدفّق يساوي الرصيد — السلوك القديم محفوظ حرفياً', () => {
  const { acc, bal } = foldStock([load('p', 100, '2026-08-01')], [sale('p', 30, '2026-08-05')], undefined);
  assert.deepEqual(acc.get('p'), bal.get('p'));
  assert.equal(remaining(bal.get('p')!), 70);
});

test('الفخّ: تحميلٌ قبل المدّة وبيعٌ داخلها لا يُنتج رصيداً سالباً', () => {
  // حُمِّل 100 في أغسطس، بيع 30 في سبتمبر. النافذة سبتمبر وحده.
  const { acc, bal } = foldStock(
    [load('p', 100, '2026-08-01')],
    [sale('p', 30, '2026-09-10')],
    D('2026-09-01'),
  );
  // التدفّق: لا تحميل داخل المدّة، ومبيعات 30
  assert.equal(acc.get('p')!.loaded, 0);
  assert.equal(acc.get('p')!.sold, 30);
  // الرصيد تراكميّ فيبقى موجباً — ولو صُفِّي بالنافذة لصار −30
  assert.equal(remaining(bal.get('p')!), 70);
  assert.ok(remaining(bal.get('p')!) > 0, 'الرصيد لا يجوز أن يكون سالباً هنا');
});

test('صنفٌ لم يتحرّك داخل المدّة يبقى في الجدول برصيده لا يختفي', () => {
  const { acc, bal } = foldStock([load('p', 40, '2026-07-01')], [], D('2026-09-01'));
  assert.equal(acc.has('p'), false, 'لا تدفّق داخل المدّة');
  assert.equal(remaining(bal.get('p')!), 40, 'لكن رصيده قائم');
  // المسار يمرّ على bal لا acc، فهذا الصنف يُعرض بمحمَّل صفر ومتبقٍّ 40
});

test('التصفية تفصل صنفاً عن صنف — لا تسرّب بين المنتجات', () => {
  const { acc, bal } = foldStock(
    [load('a', 10, '2026-09-02'), load('b', 5, '2026-08-02')],
    [sale('a', 4, '2026-09-03')],
    D('2026-09-01'),
  );
  assert.equal(acc.get('a')!.loaded, 10);
  assert.equal(acc.get('a')!.sold, 4);
  assert.equal(acc.has('b'), false);
  assert.equal(remaining(bal.get('a')!), 6);
  assert.equal(remaining(bal.get('b')!), 5);
});

test('حدّ المدّة شامل ليومه — حركةٌ في تاريخ البداية تدخل النافذة', () => {
  const { acc } = foldStock([load('p', 7, '2026-09-01')], [], D('2026-09-01'));
  assert.equal(acc.get('p')!.loaded, 7, 'حركة يوم البداية داخل المدّة');
});

test('المرتجع لا يعود للسيارة إلا بـreturnToStock', () => {
  const noBack = foldStock([], [sale('p', 5, '2026-09-02', 'RETURN', false)], undefined);
  assert.equal(noBack.bal.get('p')!.returned, 0);
  const back = foldStock([], [sale('p', 5, '2026-09-02', 'RETURN', true)], undefined);
  assert.equal(back.bal.get('p')!.returned, 5);
  // ولا يُحسب مبيعاً في الحالتين
  assert.equal(noBack.bal.get('p')!.sold, 0);
});

test('بندٌ بلا معرّف منتج يُتجاهل ولا يفتح صفّاً بمفتاح فارغ', () => {
  const { bal } = foldStock([], [{ productId: null, qty: 9, invoice: { type: 'CASH', returnToStock: null, invoiceDate: D('2026-09-02') } }], undefined);
  assert.equal(bal.size, 0);
});

test('التنزيل والتسوية يدخلان النافذة كما يدخل التحميل', () => {
  const { acc, bal } = foldStock(
    [load('p', 100, '2026-08-01'), load('p', 20, '2026-09-05', 'UNLOAD'), load('p', 3, '2026-09-06', 'ADJUST')],
    [],
    D('2026-09-01'),
  );
  assert.equal(acc.get('p')!.unloaded, 20);
  assert.equal(acc.get('p')!.adjusted, 3);
  assert.equal(acc.get('p')!.loaded, 0, 'تحميل أغسطس خارج المدّة');
  assert.equal(remaining(bal.get('p')!), 83, '100 − 20 + 3');
});
