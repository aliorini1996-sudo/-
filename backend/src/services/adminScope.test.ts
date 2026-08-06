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
  SHAPE_INVOICE_RECEIPT,
  SHAPE_VISIT,
  SHAPE_NOTIFICATION,
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
  assert.deepEqual(composeRecordWhere({}, {}, SHAPE_INVOICE_RECEIPT), {});
  assert.deepEqual(composeRecordWhere({}, {}, SHAPE_VISIT), {});
});

test('حقل اختياريّ (إشعار): يُضاف استثناء null فيبقى سجلّ بلا عميل/مندوب مرئيّاً', () => {
  const w = composeRecordWhere(CUST, REP, SHAPE_NOTIFICATION) as { AND: { OR: unknown[] }[] };
  assert.equal(w.AND.length, 2);
  assert.deepEqual(w.AND[0].OR[0], { customer: { adminScopes: { some: { adminId: 'u1' } } } });
  assert.deepEqual(w.AND[0].OR[1], { customerId: null });   // customerId اختياريّ ⇒ null صالح ومطلوب
  assert.deepEqual(w.AND[1].OR[1], { salesRepId: null });
});

test('حقل إلزاميّ (فاتورة/سند): قيد العلاقة وحده بلا استثناء null — وإلا رماه Prisma', () => {
  // customer إلزاميّ ⇒ لا فرع {customerId:null} (يرميه Prisma على حقلٍ إلزاميّ ⇒ 500).
  // salesRep اختياريّ ⇒ يبقى استثناء {salesRepId:null} لسجلّ المكتب.
  const w = composeRecordWhere(CUST, REP, SHAPE_INVOICE_RECEIPT) as { AND: unknown[] };
  assert.deepEqual(w.AND[0], { customer: { adminScopes: { some: { adminId: 'u1' } } } });
  assert.deepEqual(w.AND[1], { OR: [{ salesRep: { adminScopes: { some: { adminId: 'u1' } } } }, { salesRepId: null }] });
});

test('حقلان إلزاميّان (زيارة): قيدا علاقة مباشران بلا أي استثناء null', () => {
  const w = composeRecordWhere(CUST, REP, SHAPE_VISIT) as { AND: unknown[] };
  assert.deepEqual(w.AND, [
    { customer: { adminScopes: { some: { adminId: 'u1' } } } },
    { salesRep: { adminScopes: { some: { adminId: 'u1' } } } },
  ]);
});

test('القائمتان معاً: AND لا OR — العميل شرطٌ مستقلّ عن المندوب', () => {
  // مجموعتان داخل AND ⇒ يجب تحقّقهما معاً.
  // لو دُمجتا في OR واحد لسرّبت فاتورةُ عميلٍ مرئيّ اسمَ مندوبها المخفيّ.
  for (const shape of [SHAPE_INVOICE_RECEIPT, SHAPE_VISIT, SHAPE_NOTIFICATION]) {
    const w = composeRecordWhere(CUST, REP, shape) as { AND: unknown[] };
    assert.deepEqual(Object.keys(w), ['AND']);
    assert.equal(w.AND.length, 2);
  }
});

/**
 * حارسُ الخلل الذي عطّل الميزة عند أوّل استعمال حقيقيّ: استثناء `{ …Id: null }`
 * على حقلٍ **إلزاميّ** يرفضه Prisma (نوع الفلتر لا يقبل null) فيرمي 500. الاختبار
 * القديم جرّب بنية الكائن لا استعلام Prisma فمرّ. هنا نفرض: لا يظهر `…Id: null`
 * إطلاقاً حيث صرّح الشكلُ أن الحقل إلزاميّ.
 */
test('حارس: لا يُبعث {…Id: null} على حقل إلزاميّ (صنف الخلل الذي عطّل اللوحة)', () => {
  const hasNull = (o: unknown, key: string): boolean => {
    if (Array.isArray(o)) return o.some((x) => hasNull(x, key));
    if (o && typeof o === 'object') {
      return Object.entries(o as Record<string, unknown>).some(
        ([k, v]) => (k === key && v === null) || hasNull(v, key),
      );
    }
    return false;
  };
  // فاتورة/سند: العميل إلزاميّ ⇒ ممنوع customerId:null ؛ المندوب اختياريّ ⇒ يُسمح salesRepId:null
  const ir = composeRecordWhere(CUST, REP, SHAPE_INVOICE_RECEIPT);
  assert.equal(hasNull(ir, 'customerId'), false);
  assert.equal(hasNull(ir, 'salesRepId'), true);
  // زيارة: كلاهما إلزاميّ ⇒ ممنوع الاثنان
  const v = composeRecordWhere(CUST, REP, SHAPE_VISIT);
  assert.equal(hasNull(v, 'customerId'), false);
  assert.equal(hasNull(v, 'salesRepId'), false);
  // إشعار: كلاهما اختياريّ ⇒ يُسمح الاثنان
  const n = composeRecordWhere(CUST, REP, SHAPE_NOTIFICATION);
  assert.equal(hasNull(n, 'customerId'), true);
  assert.equal(hasNull(n, 'salesRepId'), true);
});

/**
 * حارسٌ ضدّ انحراف المخطّط: ثوابت الأشكال تصف nullability حقول النماذج. لو صار
 * حقلٌ إلزاميّاً أو اختيارياً في schema.prisma دون تحديث الثابت، يعود الخلل صامتاً.
 * نقرأ المخطّط ونتحقّق أن كل ثابت يطابق واقع نموذجه.
 */
test('حارس: ثوابت الأشكال تطابق nullability المخطّط الفعليّ', () => {
  const schema = fs.readFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
  const kindOf = (model: string, field: string): 'required' | 'nullable' => {
    const body = new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(schema);
    assert.ok(body, `النموذج ${model} غير موجود في المخطّط`);
    const line = body![1].split('\n').find((l) => new RegExp(`^\\s*${field}\\s+String`).test(l));
    assert.ok(line, `الحقل ${field} غير موجود في ${model}`);
    return /String\?/.test(line!) ? 'nullable' : 'required';
  };
  // Invoice و Receipt يتشاركان SHAPE_INVOICE_RECEIPT
  for (const m of ['Invoice', 'Receipt']) {
    assert.equal(kindOf(m, 'customerId'), SHAPE_INVOICE_RECEIPT.customer, `${m}.customerId`);
    assert.equal(kindOf(m, 'salesRepId'), SHAPE_INVOICE_RECEIPT.rep, `${m}.salesRepId`);
  }
  assert.equal(kindOf('RepVisit', 'customerId'), SHAPE_VISIT.customer);
  assert.equal(kindOf('RepVisit', 'salesRepId'), SHAPE_VISIT.rep);
  assert.equal(kindOf('Notification', 'customerId'), SHAPE_NOTIFICATION.customer);
  assert.equal(kindOf('Notification', 'salesRepId'), SHAPE_NOTIFICATION.rep);
});

test('العزل لا يمسّ المندوب: كل الدوالّ ترجع فارغة لدور SALES_REP', async () => {
  const r = req('SALES_REP');
  assert.deepEqual(await adminCustomerFilter(r), {});
  assert.deepEqual(await adminRepFilter(r), {});
  assert.deepEqual(await scopedRecordWhere(r, SHAPE_INVOICE_RECEIPT), {});
  assert.deepEqual(await scopedRepRecordWhere(r), {});
});

test('العزل لا يمسّ مالك المنصّة ولا الطلب بلا مستخدم', async () => {
  for (const r of [req('SUPER_ADMIN'), req()]) {
    assert.deepEqual(await scopedRecordWhere(r, SHAPE_INVOICE_RECEIPT), {});
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

/**
 * حارس ثابت ثانٍ، على خلل وقع فعلاً أيضاً: مسارا `/:id/scope` أُضيفا بلا
 * `requireCompanyOwner`. راوتر `company-users` يحمل `requireAdmin` فقط، وهو
 * يقبل المشرف والمحاسب بلا فحص صلاحيات ⇒ أي مستخدم شركة كان يفكّ عزل نفسه
 * بطلب واحد.
 *
 * القاعدة: **كل معالج في هذا الملفّ يبدأ بحارس**. لا يكفي أن يتذكّر كاتبُ
 * المسار القادم — الحارس هنا يفشل إن نسي.
 */
test('حارس ثابت: كل مسار في companyUsers يفتتح بحارس صلاحية', () => {
  const file = path.join(process.cwd(), 'src', 'routes', 'companyUsers.ts');
  assert.ok(fs.existsSync(file), `الملفّ غير موجود: ${file}`);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const GUARDS = /requireCompanyOwner|guardScopeAdmin/;
  const unguarded: string[] = [];

  lines.forEach((line, i) => {
    if (!/^router\.(get|post|put|patch|delete)\(/.test(line)) return;
    // الحارس يجب أن يقع في أوّل أسطر المعالج لا في عمقه
    const head = lines.slice(i, i + 6).join('\n');
    if (!GUARDS.test(head)) unguarded.push(`${i + 1}: ${line.trim().slice(0, 70)}`);
  });

  assert.ok(lines.some((l) => /^router\.(get|post|put|patch|delete)\(/.test(l)), 'لم يُعثر على أي مسار — تغيّر النمط والحارس صار بلا أثر');
  assert.deepEqual(unguarded, [], `مسار بلا حارس صلاحية:\n${unguarded.join('\n')}`);
});

/**
 * حارس ثابت ثالث — على ثغرةٍ **نقضت الحارسين السابقين وهما يمرّان**.
 *
 * `scopeEnabled` كان مُدرَجاً في `userSchema` العامّ، فيمرّ عبر
 * `updateData = { ...data }` إلى `admin.update` من `PUT /:id` — وهو مسارٌ
 * حارسه `requireCompanyOwner` لا `guardScopeAdmin`. فمستخدمٌ مقيّد يملك
 * `canManageCompanyUsers` **يفكّ عزل نفسه بطلب واحد**.
 *
 * والحارس الثابت السابق كان **يمرّ على هذا المسار** لأنه يقبل أيّاً من
 * الحارسين — فالفحص الصحيح ليس «هل للمسار حارس» بل «هل يُكتب النطاق خارج
 * مساره المحروس».
 */
test('حارس ثابت: النطاق لا يُكتب إلا داخل مسار /:id/scope المحروس', () => {
  const file = path.join(process.cwd(), 'src', 'routes', 'companyUsers.ts');
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  // مسارا `/:id/scope` (القراءة والكتابة) محروسان بـ`guardScopeAdmin`، وهما
  // وحدهما المسموح لهما بلمس النطاق. الحدّ = أوّلهما ظهوراً في الملفّ.
  const scopeStart = lines.findIndex((l) => /^router\.(get|put)\('\/:id\/scope'/.test(l));
  assert.ok(scopeStart > 0, 'لم يُعثر على مسارات /:id/scope — تغيّر الملفّ والحارس بلا أثر');

  const offenders: string[] = [];
  lines.forEach((line, i) => {
    if (i >= scopeStart) return;                       // داخل المسارين المحروسين: مسموح
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;  // تعليق
    if (t.startsWith('delete ')) return;                // حذفُ الحقل حمايةٌ لا كتابة
    if (/scopeEnabled/.test(line)) offenders.push(`${i + 1}: ${t.slice(0, 80)}`);
  });

  assert.deepEqual(offenders, [], `ذكرٌ لـscopeEnabled خارج مساره المحروس:\n${offenders.join('\n')}`);
});
