import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeRecordWhere,
  adminCustomerFilter,
  adminRepFilter,
  scopedRecordWhere,
  scopedRepRecordWhere,
} from './adminScope';
import { AuthRequest } from '../types';

/**
 * اختبارات نطاق المستخدم الإداري.
 *
 * الشقّ الأوّل يختبر **تركيب القيد** وحده (composeRecordWhere) بلا قاعدة بيانات.
 * والشقّ الثاني يختبر **من لا يُقيَّد أصلاً**: هذه المسارات ترجع قبل أي استعلام
 * (isCompanyUser false)، فتُنفَّذ بلا اتصال. وهي الاختبار الأهمّ عملياً: خطأ هنا
 * يعني تقييد المندوب أو مالك المنصّة بنطاقٍ ليس لهما فينكسر النظام كلّه.
 */

const req = (role?: string): AuthRequest =>
  ({ user: role ? { id: 'u1', role, name: 'x' } : undefined } as unknown as AuthRequest);

const CUST = { adminScopes: { some: { adminId: 'u1' } } };
const REP = { adminScopes: { some: { adminId: 'u1' } } };

test('بلا نطاق: قيد فارغ تماماً (رؤية كاملة، لا تقييد بالخطأ)', () => {
  assert.deepEqual(composeRecordWhere({}, {}), {});
});

test('نطاق عملاء فقط: يُقيَّد العميل ولا يُمسّ المندوب', () => {
  const w = composeRecordWhere(CUST, {});
  assert.deepEqual(w, { customer: { adminScopes: { some: { adminId: 'u1' } } } });
  assert.equal('OR' in w, false);
});

test('نطاق مناديب فقط: السجلّات بلا مندوب تبقى مرئيّة', () => {
  const w = composeRecordWhere({}, REP) as { OR: unknown[] };
  assert.equal('customer' in w, false);
  // الفرع الثاني هو الاستثناء: فاتورة/سند أنشأته الإدارة بلا مندوب
  assert.deepEqual(w.OR[1], { salesRepId: null });
});

test('القائمتان معاً: AND لا OR — العميل شرطٌ مستقلّ عن المندوب', () => {
  const w = composeRecordWhere(CUST, REP) as Record<string, unknown>;
  // مفتاحان على المستوى الأعلى ⇒ يجتمعان بـAND في Prisma.
  // لو دُمجا في OR واحد لسرّبت فاتورةُ عميلٍ مرئيّ اسمَ مندوبها المخفيّ.
  assert.deepEqual(Object.keys(w).sort(), ['OR', 'customer']);
  assert.deepEqual(w.customer, { adminScopes: { some: { adminId: 'u1' } } });
});

test('العزل لا يمسّ المندوب: كل الدوالّ ترجع فارغة لدور SALES_REP', async () => {
  const r = req('SALES_REP');
  assert.deepEqual(await adminCustomerFilter(r), {});
  assert.deepEqual(await adminRepFilter(r), {});
  assert.deepEqual(await scopedRecordWhere(r), {});
  assert.deepEqual(await scopedRepRecordWhere(r), {});
});

test('العزل لا يمسّ مالك المنصّة ولا الطلب بلا مستخدم', async () => {
  for (const r of [req('SUPER_ADMIN'), req()]) {
    assert.deepEqual(await scopedRecordWhere(r), {});
    assert.deepEqual(await scopedRepRecordWhere(r), {});
  }
});
