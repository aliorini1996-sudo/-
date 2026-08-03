import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

test('نطاق عملاء فقط: مجموعة واحدة، والسجلّ بلا عميل يبقى مرئيّاً', () => {
  const w = composeRecordWhere(CUST, {}) as { AND: { OR: unknown[] }[] };
  assert.equal(w.AND.length, 1);
  assert.deepEqual(w.AND[0].OR[0], { customer: { adminScopes: { some: { adminId: 'u1' } } } });
  // الاستثناء: إشعار على مستوى الشركة بلا عميل — قيدُ العلاقة وحده كان يُخفيه
  assert.deepEqual(w.AND[0].OR[1], { customerId: null });
});

test('نطاق مناديب فقط: السجلّات بلا مندوب تبقى مرئيّة', () => {
  const w = composeRecordWhere({}, REP) as { AND: { OR: unknown[] }[] };
  assert.equal(w.AND.length, 1);
  // الفرع الثاني هو الاستثناء: فاتورة/سند أنشأته الإدارة بلا مندوب
  assert.deepEqual(w.AND[0].OR[1], { salesRepId: null });
});

test('القائمتان معاً: AND لا OR — العميل شرطٌ مستقلّ عن المندوب', () => {
  const w = composeRecordWhere(CUST, REP) as { AND: { OR: unknown[] }[] };
  // مجموعتان داخل AND ⇒ يجب تحقّقهما معاً.
  // لو دُمجتا في OR واحد لسرّبت فاتورةُ عميلٍ مرئيّ اسمَ مندوبها المخفيّ.
  assert.deepEqual(Object.keys(w), ['AND']);
  assert.equal(w.AND.length, 2);
  assert.deepEqual(w.AND[0].OR[0], { customer: { adminScopes: { some: { adminId: 'u1' } } } });
  assert.deepEqual(w.AND[1].OR[0], { salesRep: { adminScopes: { some: { adminId: 'u1' } } } });
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

/**
 * حارس ثابت (static) على صنف الخطأ الذي وقع فعلاً وسُرِّبت به بيانات:
 * `customerScope` تُرجع كائناً بمفتاحين (`assignments` للمندوب، `adminScopes`
 * للإداري)، وبوّابتان في customers.ts كانتا تفحصان `scope.assignments` وحده
 * ⇒ المستخدم الإداري المقيّد (لا `assignments` له) يتخطّى البوّابة كلّياً.
 *
 * القاعدة المفروضة هنا: **لا يفحص مسارٌ مفاتيحَ النطاق بنفسه** — البوّابة
 * تمرّ عبر `canAccessCustomer` التي تفحص المفتاحين معاً. مفتاحٌ ثالث يوماً ما
 * يبقى بلا أثر على المسارات.
 */
test('حارس ثابت: لا مسار يفحص مفتاح نطاق بعينه (استخدم canAccessCustomer)', () => {
  // من جذر المشروع لا من موقع الملفّ المُصرَّف: التصريف إلى dist يجعل المجلّد
  // بلا ملفّات .ts فيمرّ الاختبار فارغاً — نجاحٌ كاذب. والتأكيد أدناه يمنع ذلك.
  const dir = path.join(process.cwd(), 'src', 'routes');
  assert.ok(fs.existsSync(dir), `مجلّد المسارات غير موجود: ${dir}`);
  const offenders: string[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/\.(assignments|adminScopes)\b/.test(line) && !line.trim().startsWith('*')) {
        offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `فحص مفاتيح النطاق داخل مسار:\n${offenders.join('\n')}`);
});
