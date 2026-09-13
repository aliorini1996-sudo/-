import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  USER_STATUS, CLAIM_STATUS, ATTRIBUTION_STATUS, COMMISSION_STATUS, PAYOUT_STATUS,
  COMPANY_STATUS, COMPANY_SOURCE, ADJUSTMENT_KIND, CLAIM_HOW, CLAIM_HOW_ORDER, labelOf, textOf,
} from './labels';
import { AX_DICT, AX_LANGS, type AxKey } from './i18n';

/**
 * كل قيمة حالة في المواصفة لها تسمية بخمس لغات (مفتاح قاموس) — والقوائم تُقرأ من
 * docs/affiliate/API.md نفسه لا من نسخةٍ هنا، فقيمةٌ تُضاف للمواصفة بلا
 * تسمية تُفشل الاختبار بدل أن تظهر للسفير نصّاً إنجليزياً خاماً.
 */
const API = readFileSync(new URL('../../../docs/affiliate/API.md', import.meta.url), 'utf8');
const ARABIC = /[؀-ۿ]/;

function unionOf(typeName: string): string[] {
  const m = API.match(new RegExp(`type ${typeName} = ([^;]+);`));
  assert.ok(m, `النوع ${typeName} غير موجود في API.md`);
  return [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

/** قائمة حرفية داخل سطر المسار، مثل status: 'trial'|'paid'|… */
function inlineUnion(anchor: string, field: string): string[] {
  const line = API.split('\n').find((l) => l.includes(anchor));
  assert.ok(line, `سطر ${anchor} غير موجود في API.md`);
  const m = line!.match(new RegExp(`${field}: ((?:'[a-z_]+'\\s*\\|\\s*)*'[a-z_]+')`));
  assert.ok(m, `الحقل ${field} غير موجود في سطر ${anchor}`);
  return [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

function assertLabelled(name: string, values: string[], map: Record<string, { key: AxKey } | AxKey>) {
  assert.ok(values.length >= 2, `${name}: قائمة قصيرة على نحوٍ مريب (${values.join(',')})`);
  for (const v of values) {
    const entry = map[v];
    assert.ok(entry, `${name}.${v} بلا تسمية`);
    const k = typeof entry === 'string' ? entry : entry.key;
    const dict = AX_DICT[k];
    assert.ok(dict, `${name}.${v}: المفتاح ${k} غير موجود في القاموس`);
    assert.match(dict.ar, ARABIC, `${name}.${v} تسميته العربية ليست عربية: ${dict.ar}`);
    for (const l of AX_LANGS) assert.ok(dict[l]?.trim(), `${name}.${v}: لا تسمية ${l}`);
    for (const l of AX_LANGS.filter((x) => x !== 'ar')) assert.doesNotMatch(dict[l], ARABIC, `${name}.${v}: نصٌّ عربي في ${l}`);
  }
  // ولا تسميات لقيمٍ خرجت من المواصفة
  assert.deepEqual(Object.keys(map).sort(), [...values].sort(), `${name}: مفاتيح التسميات لا تطابق المواصفة`);
}

test('حالات المستخدم', () => assertLabelled('UserStatus', unionOf('UserStatus'), USER_STATUS));
test('حالات الترشيح', () => assertLabelled('ClaimStatus', unionOf('ClaimStatus'), CLAIM_STATUS));
test('حالات الإسناد', () => assertLabelled('AttributionStatus', unionOf('AttributionStatus'), ATTRIBUTION_STATUS));
test('حالات العمولة', () => assertLabelled('CommissionStatus', unionOf('CommissionStatus'), COMMISSION_STATUS));
test('حالات الدفعة', () => assertLabelled('PayoutStatus', unionOf('PayoutStatus'), PAYOUT_STATUS));
test('كيف عرّفتهم', () => {
  const how = unionOf('ClaimHow');
  assertLabelled('ClaimHow', how, CLAIM_HOW);
  assert.deepEqual([...CLAIM_HOW_ORDER].sort(), [...how].sort(), 'خيارات النموذج لا تغطي المواصفة');
});
test('حالات «شركاتي» ومصدرها', () => {
  assertLabelled('companies.status', inlineUnion('GET /companies', 'status'), COMPANY_STATUS);
  assertLabelled('companies.source', inlineUnion('GET /companies', 'source'), COMPANY_SOURCE);
});
test('أنواع التسويات', () => {
  assertLabelled('adjustments.kind', inlineUnion('GET /adjustments', 'kind'), ADJUSTMENT_KIND);
});

test('التسميات المطلوبة حرفياً للسفير', () => {
  assert.deepEqual(
    ['pending', 'on_hold', 'approved', 'paid', 'reversed', 'declined'].map((k) => labelOf(COMMISSION_STATUS, k).label),
    ['معلّقة', 'موقوفة', 'معتمدة', 'مدفوعة', 'مُلغاة بالاسترداد', 'مرفوضة'],
  );
  assert.deepEqual(
    ['under_review', 'approved', 'rejected', 'withdrawn', 'expired', 'converted'].map((k) => labelOf(CLAIM_STATUS, k).label),
    ['قيد المراجعة', 'مقبول', 'مرفوض', 'مسحوب', 'منتهٍ', 'تحوّل لعميل'],
  );
  assert.deepEqual(
    ['trial', 'paid', 'disputed', 'void', 'expired'].map((k) => labelOf(COMPANY_STATUS, k).label),
    ['تجربة', 'دفعت', 'قيد المراجعة', 'ملغاة', 'انتهت المهلة'],
  );
});

test('قيمة مجهولة من خادمٍ أحدث لا تُسقط الواجهة', () => {
  assert.deepEqual(labelOf(COMMISSION_STATUS, 'brand_new'), { label: 'brand_new', tone: 'gray' });
  assert.deepEqual(labelOf(COMMISSION_STATUS, 'brand_new', 'en'), { label: 'brand_new', tone: 'gray' });
  assert.equal(textOf(CLAIM_HOW, 'brand_new'), 'brand_new');
});

test('التسميات بلغة العرض — والنبرة لا تتغيّر', () => {
  assert.deepEqual(labelOf(COMMISSION_STATUS, 'paid', 'en'), { label: 'Paid', tone: 'coral' });
  assert.deepEqual(labelOf(COMMISSION_STATUS, 'paid', 'fr'), { label: 'Versée', tone: 'coral' });
  assert.deepEqual(labelOf(CLAIM_STATUS, 'converted', 'tr'), { label: 'Müşteriye dönüştü', tone: 'coral' });
  assert.equal(labelOf(USER_STATUS, 'approved', 'zh').label, '已通过');
  assert.equal(textOf(CLAIM_HOW, 'visit', 'en'), 'Field visit');
  assert.equal(textOf(COMPANY_SOURCE, 'claim', 'ar'), 'ترشيح معتمد');
  assert.equal(textOf(ADJUSTMENT_KIND, 'correction', 'zh'), '更正');
});
