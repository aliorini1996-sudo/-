import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { M_CUSTOMER_PHONE_MAX, mCustomerFormValid, mCustomerPhonePayload, mCustomerTel } from './mCustomerPhone';

/**
 * جوال العميل في تطبيق الإدارة على الجوال — حرٌّ تماماً (طلب المالك ٧ نوفمبر ٢٠٢٦: «فك القيد بالكامل» ثم «اجعل تسجيل الجوال
 * ليس اجباري»). ما يحرسه هذا الملف:
 * - الاسم وحده يفتح زرّ الحفظ: جوالٌ فارغ أو قصير أو بحروف لا يمنع الحفظ، وسقف الأمان ٣٠ بعد القصّ.
 * - الفارغ يُرسل '' في الإنشاء (العمود NOT NULL)، والتعديل يرسل الجوال حين يتغيّر وحده.
 * - لا رابط tel: لجوالٍ فارغ أو عبثيّ في شاشات العميل.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, 'src', ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('صلاحية النموذج: الاسم وحده إلزاميّ — والجوال حرّ بلا حدّ أدنى ولا صيغة', () => {
  assert.equal(mCustomerFormValid({ name: 'محل', phone: '' }), true, 'بلا جوال');
  assert.equal(mCustomerFormValid({ name: 'محل', phone: '   ' }), true, 'مسافات وحدها');
  assert.equal(mCustomerFormValid({ name: 'محل', phone: '1' }), true, 'رقم واحد');
  assert.equal(mCustomerFormValid({ name: 'محل', phone: '920' }), true, 'أقل من ٩ أرقام');
  assert.equal(mCustomerFormValid({ name: 'محل', phone: 'لا يوجد' }), true, 'نصّ بلا أرقام');
  assert.equal(mCustomerFormValid({ name: '', phone: '0551234567' }), false, 'بلا اسم');
  assert.equal(mCustomerFormValid({ name: '   ', phone: '0551234567' }), false, 'اسم مسافات');
});

test('سقف الأمان ٣٠ بعد القصّ — ورقمٌ قديمٌ أطول لم يُمسّ لا يمنع تعديل باقي الحقول', () => {
  assert.equal(M_CUSTOMER_PHONE_MAX, 30);
  const at = '1'.repeat(30), over = '1'.repeat(31);
  assert.equal(mCustomerFormValid({ name: 'م', phone: at }), true);
  assert.equal(mCustomerFormValid({ name: 'م', phone: `  ${at}  ` }), true, 'المسافات المحيطة لا تُحسب');
  assert.equal(mCustomerFormValid({ name: 'م', phone: over }), false, 'جديدٌ فوق السقف');
  assert.equal(mCustomerFormValid({ name: 'م', phone: over }, over), true, 'قديمٌ لم يُمسّ');
  assert.equal(mCustomerFormValid({ name: 'م', phone: over + '2' }, over), false, 'قديمٌ عُدّل فصار فوق السقف');
  assert.equal(mCustomerFormValid({ name: '', phone: over }, over), false, 'الاسم يبقى إلزامياً');
});

test('حمولة الجوال: الإنشاء يرسل المقصوص دائماً ("" بلا جوال)، والتعديل حين يتغيّر وحده', () => {
  // إنشاء (stored = null)
  assert.deepEqual(mCustomerPhonePayload('', null), { phone: '' });
  assert.deepEqual(mCustomerPhonePayload('   ', null), { phone: '' });
  assert.deepEqual(mCustomerPhonePayload(' 055 ', null), { phone: '055' });
  assert.deepEqual(mCustomerPhonePayload('0551234567'), { phone: '0551234567' });
  // تعديل
  assert.deepEqual(mCustomerPhonePayload('0551234567', '0551234567'), {}, 'لم يتغيّر');
  assert.deepEqual(mCustomerPhonePayload(' 0551234567 ', '0551234567'), {}, 'مسافاتٌ لا تُعدّ تغييراً');
  assert.deepEqual(mCustomerPhonePayload('', '0551234567'), { phone: '' }, 'تفريغه عمداً يُرسَل');
  assert.deepEqual(mCustomerPhonePayload('', ''), {}, 'بلا جوال وبقي بلا جوال');
  assert.deepEqual(mCustomerPhonePayload('12', ''), { phone: '12' }, 'أُضيف لعميلٍ بلا جوال');
});

test('رابط الاتصال: الفارغ والعبثيّ بلا رابط — والرقم الحقيقيّ يُطلَب', () => {
  for (const junk of ['', '   ', 'لا يوجد', 'abc', '-', '12', '1234', null, undefined]) {
    assert.equal(mCustomerTel(junk), null, `«${String(junk)}» لا رابط له`);
  }
  assert.equal(mCustomerTel('0551234567'), 'tel:0551234567');
  assert.equal(mCustomerTel('+966 55 123 4567'), 'tel:+966551234567');
  assert.equal(mCustomerTel('٠٥٥١٢٣٤٥٦٧'), 'tel:0551234567', 'الأرقام العربية-الهندية');
  assert.equal(mCustomerTel('1'.repeat(16)), null, 'أطول من E.164');
});

test('MCustomerForm: الجوال بلا نجمة الإلزام وبسقف ٣٠، والحفظ بالاسم وحده، والحمولة عبر المساعد', () => {
  const f = read('m', 'MCustomerForm.tsx');
  assert.ok(
    f.includes(`<Field label={tr('رقم الجوال')} dir="ltr" value={form.phone} onChange={v => set('phone', v)} type="tel" maxLength={M_CUSTOMER_PHONE_MAX} />`),
    'حقل الجوال اختياريّ بسقف',
  );
  assert.doesNotMatch(f, /tr\('رقم الجوال'\)\} required/, 'نجمة الإلزام عادت على الجوال');
  assert.doesNotMatch(f, /form\.phone\.trim\(\)\.length > 0/, 'شرط الجوال عاد إلى صلاحية الحفظ');
  assert.ok(f.includes("const valid = mCustomerFormValid(form, customer ? customer.phone ?? '' : null);"));
  assert.ok(f.includes("...mCustomerPhonePayload(form.phone, customer ? customer.phone ?? '' : null),"));
  assert.doesNotMatch(f, /phone: form\.phone\.trim\(\),/, 'الحمولة تتجاوز المساعد');
  assert.ok(f.includes('maxLength={maxLength} onChange={e => onChange(e.target.value)}'), 'الحقل يمرّر السقف إلى الإدخال');
});

test('شاشات العميل في /m: لا tel: مبنيٌّ يدوياً من جوال العميل — كله عبر mCustomerTel/telHref', () => {
  const dir = path.join(root, 'src', 'm');
  // جوال المندوب (MSalesReps) خارج الطلب — قيده باقٍ
  const offenders: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.tsx') || name === 'MSalesReps.tsx') continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    if (src.includes('`tel:${')) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'رابط tel: يدويّ قد يكون فارغاً أو عبثياً');

  const c = read('m', 'MCustomers.tsx');
  assert.ok(c.includes("href={mCustomerTel(c.phone) ?? undefined}"), 'الجوال في تفاصيل العميل');
  assert.ok(c.includes("href={mCustomerTel(c.altPhone) ?? undefined}"), 'الرقم البديل');
  assert.ok(c.includes(`: <Info label={tr('الجوال')} value="—" />}`), 'الفارغ شرطة بلا رابط ولا أيقونة');

  const t = read('m', 'MTracking.tsx');
  assert.ok(t.includes('{mCustomerTel(pickedCustomer.phone) && ('), 'زرّ «اتصال» على الخريطة لرقمٍ يُطلَب وحده');
  assert.ok(t.includes('{mCustomerTel(q.data.customer?.phone) ? ('), 'جوال عميل الزيارة');
});
