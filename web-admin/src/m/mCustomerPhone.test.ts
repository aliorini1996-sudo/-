import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as mPhone from './mCustomerPhone';
import { M_CUSTOMER_PHONE_MAX, mCustomerPhonePayload, mCustomerTel } from './mCustomerPhone';

/**
 * جوال العميل في تطبيق الإدارة على الجوال — حرٌّ تماماً (طلب المالك ٧ نوفمبر ٢٠٢٦: «فك القيد بالكامل» ثم «اجعل تسجيل الجوال
 * ليس اجباري»، ثم ٩ نوفمبر: «بلا قيود على العميل»). ما يحرسه هذا الملف:
 * - لا حقل يمنع الحفظ: لا اسم مطلوب ولا فحص للجوال — زرّ الحفظ موقوفٌ أثناء الإرسال والتقاط الموقع وحدهما.
 * - الفارغ يُرسل '' في الإنشاء (العمود NOT NULL)، والتعديل يرسل الجوال حين يتغيّر وحده.
 * - لا رابط tel: لجوالٍ فارغ أو عبثيّ في شاشات العميل.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, 'src', ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('بلا قيود (٩ نوفمبر): لا فحص صلاحية يمنع الحفظ — أُزيل mCustomerFormValid، وطول الخانة بقدر ما يحفظه الخادم', () => {
  assert.equal('mCustomerFormValid' in mPhone, false, 'فحص الاسم/الجوال المانع عاد');
  assert.equal(M_CUSTOMER_PHONE_MAX, 200);
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

test('MCustomerForm بلا قيود: الاسم والجوال بلا نجمة الإلزام، والحفظ لا ينتظر حقلاً، والحمولة عبر المساعد', () => {
  const f = read('m', 'MCustomerForm.tsx');
  assert.ok(
    f.includes(`<Field label={tr('رقم الجوال')} dir="ltr" value={form.phone} onChange={v => set('phone', v)} type="tel" maxLength={M_CUSTOMER_PHONE_MAX} />`),
    'حقل الجوال اختياريّ بطول الخادم',
  );
  assert.ok(f.includes(`<Field label={tr('اسم العميل')} value={form.name} onChange={v => set('name', v)} />`), 'الاسم عاد إلزامياً');
  assert.doesNotMatch(f, /tr\('رقم الجوال'\)\} required/, 'نجمة الإلزام عادت على الجوال');
  assert.doesNotMatch(f, /form\.phone\.trim\(\)\.length > 0/, 'شرط الجوال عاد إلى صلاحية الحفظ');
  assert.doesNotMatch(f, /mCustomerFormValid|!valid/, 'فحص صلاحيةٍ يمنع الحفظ عاد');
  assert.ok(f.includes('<button onClick={onSave} disabled={save.isPending || geoBusy}'));
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
