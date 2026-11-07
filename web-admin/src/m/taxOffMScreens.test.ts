import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * «إزالة الضريبة» في شاشات /m — طلب المالك ٧ نوفمبر ٢٠٢٦: «في حال ازالة الضريبة لا يكون لها ذكر في اي سطر في النظام».
 *
 * الشاشات تستورد api/client (import.meta.env لا يُقرأ في node) فلا تُرسم هنا — والحارس نصّي على طريقة بقية /m: **كل** عبارة
 * ضريبةٍ مرئية في مصدر /m (بعد حذف التعليقات) يجب أن تقع داخل حاجزٍ على علم الشركة (`!taxOff && …`، أو فرع `else` لـ`taxOff ? …`)،
 * أو داخل حاجز المرحلة الثانية (`zatcaCollect`/`showBuyer`) الذي لا يجتمع مع إزالة الضريبة (الخادم يرفض القلب ما دام الربط مفعّلاً،
 * ويرفض الربط ما دامت الضريبة مزالة). فعبارةٌ جديدة بلا حاجز تُسقط هذا الاختبار. والمطفأ: الحاجز `!false` فالشاشة كما كانت.
 */

const M = path.join(process.cwd(), 'src', 'm');
const read = (f: string) => fs.readFileSync(path.join(M, f), 'utf8').replace(/\r\n/g, '\n');
/** المصدر بلا تعليقات (/* *\/ و{/* *\/} و//) — الطول نفسه (تُستبدل مسافات) فتبقى المواضع صالحة */
function stripComments(s: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  // `/*` تعليقٌ حين يسبقه فراغ أو قوس أو فاصلة — لا داخل نصٍّ مثل accept="image/*"
  return s
    .replace(/(^|[\s{(,;])\/\*[\s\S]*?\*\//g, (m, pre: string) => pre + blank(m.slice(pre.length)))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, pre: string) => pre + blank(m.slice(pre.length)));
}

/** ما يُعدّ ذكراً للضريبة في نصٍّ مرئي */
const TAX_RE = /ضريب|\bVAT\b|ض\.ق\.م|الرقم الضريبي/g;

/** فتحات `{` المحيطة بموضعٍ ما، من الأقرب إلى الأبعد (عدّ الأقواس إلى الخلف) */
function enclosingBraces(s: string, at: number): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) out.push(i);
      else depth--;
    }
  }
  return out;
}

/** حواجز العلم المقبولة: محتوى `{` المحيط يبدأ بها */
const TAX_GATES: RegExp[] = [
  /^!taxOff\s*&&/,
  /^!\(taxOff && rev\)\s*&&/,
  /^receive && !taxOff\s*&&/,
  /^accountingOn && !taxOff(?: && c\.taxNumber)?\s*&&/,
  /^\(u\.price == null \|\| !taxOff\)\s*&&/,
];
/** حاجز المرحلة الثانية (لا يجتمع مع إزالة الضريبة) */
const PHASE2_GATES: RegExp[] = [/^zatcaCollect && accountingOn\s*&&/, /^showBuyer\s*&&/, /^zatcaCollect\s*&&/];

type Hit = { file: string; line: number; text: string; gate: 'tax' | 'phase2' | null };

function scan(file: string): Hit[] {
  const raw = read(file);
  const s = stripComments(raw);
  const hits: Hit[] = [];
  for (const m of s.matchAll(TAX_RE)) {
    const at = m.index ?? 0;
    let gate: Hit['gate'] = null;
    for (const open of enclosingBraces(s, at)) {
      const inner = s.slice(open + 1, at).replace(/^\s+/, '');
      if (TAX_GATES.some(g => g.test(inner))) { gate = 'tax'; break; }
      // ternary على العلم: الذكر في فرع else وحده (بعد « : »)
      if (/^taxOff\s*\?/.test(inner) && /\s:\s/.test(inner)) { gate = 'tax'; break; }
      if (PHASE2_GATES.some(g => g.test(inner))) { gate = 'phase2'; break; }
    }
    const line = s.slice(0, at).split('\n').length;
    hits.push({ file, line, text: raw.split('\n')[line - 1].trim(), gate });
  }
  return hits;
}

const SOURCES = fs.readdirSync(M).filter(f => /\.tsx?$/.test(f) && !f.endsWith('.test.ts')).sort();

test('كل ذكرٍ مرئي للضريبة في شاشات /m خلف حاجز «بلا ضريبة» (أو حاجز المرحلة الثانية الذي لا يجتمع معه)', () => {
  const bad = SOURCES.flatMap(scan).filter(h => h.gate === null);
  assert.deepEqual(bad.map(h => `${h.file}:${h.line} ${h.text}`), [], 'عبارة ضريبةٍ تظهر لشركةٍ أزالت الضريبة');
});

test('جرد الحواجز: كل شاشةٍ فيها عبارات ضريبة محروسةٌ بعددها المعروف — والحارس نفسه يرى ما يجب أن يراه', () => {
  const count = (f: string, g: Hit['gate']) => scan(f).filter(h => h.gate === g).length;
  // الأعداد تثبّت أن الحارس يقرأ المواضع فعلاً (لا يمرّ لأنه لا يجد شيئاً)
  assert.equal(count('MInvoiceCreate.tsx', 'tax'), 5, 'الفاتورة: التلميح ونسبة الصنف والمجموع والضريبة (+ «الضريبة» في السطر)');
  assert.ok(count('MProducts.tsx', 'tax') >= 17, 'المنتجات');
  assert.equal(count('MWarehouse.tsx', 'tax'), 7, 'المستودع');
  assert.equal(count('MCustomerForm.tsx', 'tax'), 2, 'نموذج العميل: القسم والرقم');
  assert.equal(count('MCustomers.tsx', 'tax'), 1, 'ملف العميل: الرقم');
  assert.ok(count('MCustomers.tsx', 'phase2') >= 3, 'نواقص الفاتورة الضريبية خلف zatcaCollect');
  // الحارس يكشف الذكر غير المحروس فعلاً
  const probe = stripComments("<p>{tr('قبل الضريبة')}</p>{!taxOff && <b>{tr('الضريبة')}</b>}{taxOff ? tr('السعر') : tr('السعر والضريبة')}");
  const gates = [...probe.matchAll(TAX_RE)].map(m => enclosingBraces(probe, m.index ?? 0)
    .map(o => probe.slice(o + 1, m.index).replace(/^\s+/, ''))
    .some(inner => TAX_GATES.some(g => g.test(inner)) || (/^taxOff\s*\?/.test(inner) && /\s:\s/.test(inner))));
  assert.deepEqual(gates, [false, true, true]);
});

test('القوقعة: العلم من إعدادات الشركة (=== true) بسياقٍ واحد لكل الشاشات، وحدث الجلب الفوري مركّبٌ ومُزال', () => {
  const app = read('MobileApp.tsx');
  assert.ok(app.includes("import { MTaxOffContext, M_COMPANY_REFETCH_EVENT, mTaxOffOf } from './mTaxMode';"));
  assert.ok(app.includes('const taxOff = mTaxOffOf(company);'));
  assert.ok(app.includes('<MTaxOffContext.Provider value={taxOff}>{body}</MTaxOffContext.Provider>'), 'المزوّد يلفّ كل الشاشات');
  // داخل أثر جلب الشركة نفسه (حارس docFreshness يقرأ هذا الأثر): الحدث يجلب فوراً بلا فجوة، ويُزال عند تبدّل الجلسة
  const i = app.indexOf('const { data } = await companyApi.get();');
  const effect = app.slice(app.lastIndexOf('useEffect(() => {', i), app.indexOf('}, [token]);', i));
  assert.match(effect, /const onTaxMode = \(\) => \{ last = Date\.now\(\); void pull\(\); \};/);
  assert.match(effect, /window\.addEventListener\(M_COMPANY_REFETCH_EVENT, onTaxMode\);/);
  assert.match(effect, /window\.removeEventListener\(M_COMPANY_REFETCH_EVENT, onTaxMode\);/);
});

test('فاتورة الجوال: النسبة الفعلية في البند والاحتياطية، وإعادة النسبة عند تبدّل الوضع، و409 يجلب الإعدادات ولا يُسقط البنود', () => {
  const s = read('MInvoiceCreate.tsx');
  assert.ok(s.includes('const taxOff = isTaxOff(taxCo);'));
  assert.ok(s.includes('setLines(ls => addInvoiceLine(ls, p, c, priceOf, taxCo));'), 'البند الجديد بنسبته الفعلية');
  assert.ok(s.includes('invoiceTotals(lines, discountPct, taxCo), [lines, discountPct, taxCo]'), 'الاحتياطية فعليّة');
  assert.match(s, /setLines\(ls => retaxInvoiceLines\(ls, catalog, taxCo\)\);[\s\S]{0,200}\}, \[taxOff\]\);/, 'تبدّل الوضع يعيد نسبة البنود');
  assert.match(s, /if \(taxModeChangedOf\(e\)\) \{\s*requestCompanyRefetch\(\);\s*toast\.error\(tr\(TAX_MODE_MESSAGES\.TAX_MODE_CHANGED\)\);\s*return;\s*\}/);
  // الجسم بالنسبة التي على البند (صفر بعد الإعادة) — لا مفتاح شمول، والسعر صافٍ كما كان
  assert.ok(s.includes('unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.taxPct,'));
  assert.doesNotMatch(s, /pricesIncludeTax/);
  // لا نسبة ١٥ مكتوبة خارج حاجز العرض: البند من lineTaxPct (mUnits) لا من p.taxPct ?? 15
  const raw15 = [...stripComments(s).matchAll(/taxPct \?\? 15/g)].length;
  assert.equal(raw15, 1, 'نسبة الصنف تُعرض في المنتقي وحده (خلف !taxOff)');
  const units = read('mUnits.ts');
  assert.ok(units.includes('taxPct: lineTaxPct(p, tax),'));
  assert.doesNotMatch(stripComments(units), /Number\(p\.taxPct \?\? 15\)/);
  const math = read('docMath.ts');
  assert.ok(math.includes('companyVat: effectiveTaxPct(company, 15),'));
  assert.doesNotMatch(math, /companyVat: 15,/);
});

test('المستودع: لا استخراج ضريبة من التكلفة في المعاينة ولا مؤشّر يبقى مضبوطاً بعد الإزالة', () => {
  const s = read('MWarehouse.tsx');
  assert.ok(s.includes('return costsIncludeTax && !taxOff && r.taxPct > 0 ? c / (1 + r.taxPct / 100) : c;'));
  assert.ok(s.includes('useEffect(() => { if (taxOff) setCostsIncludeTax(false); }, [taxOff]);'));
  assert.ok(s.includes('{receive && !taxOff && ('), 'خانة «شاملة الضريبة» مخفيّة');
});

test('الشاشات تقرأ العلم من السياق نفسه (لا نسخة ثانية من القاعدة)', () => {
  for (const f of ['MProducts.tsx', 'MWarehouse.tsx', 'MCustomerForm.tsx', 'MCustomers.tsx']) {
    const s = read(f);
    assert.ok(s.includes("import { useMTaxOff } from './mTaxMode';"), f);
    assert.doesNotMatch(s, /taxDisabled/, `${f}: قراءة العلم مباشرةً بدل useMTaxOff`);
  }
  // نموذج العميل: السجل التجاري يبقى (بيانات عميل لا ضريبة) وينتقل إلى البيانات الأساسية حين يُخفى القسم
  const form = read('MCustomerForm.tsx');
  assert.ok(form.includes('{accountingOn && taxOff && (\n            <Field label={tr(\'السجل التجاري\')}'));
  assert.ok(form.includes("{accountingOn && !taxOff && (\n          <Group title={tr('بيانات ضريبية')}>"));
});
