// M1 — قوالب الدفاتر (DESIGN.md §4.2–§4.5، §7.8، §8.7): شجرة SA_6D والقالب العام والضرائب والمربعات والسياق الجاهز.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCOUNT_TYPES, CASH_FLOW_TAGS, CONTROL_KINDS, JOURNAL_CODE_BY_SYSTEM_KEY, JOURNAL_SYSTEM_KEYS, MAPPING_KEYS,
  VAT_BOXES_SA, isAccountType, type MappingKey,
} from '../services/gl/types';
import {
  CASH_EQUIVALENT_CODES, LEDGER_LANGS, MAPPING_KEY_ALLOWED_TYPES, MAPPING_KEY_CONTROL_KIND, SA_6D_ACCOUNTS,
  SA_6D_ACCOUNT_DESCRIPTIONS, SA_6D_ACCOUNT_GROUPS, SA_6D_ACCOUNT_SYNONYMS, SA_6D_JOURNALS, SA_6D_MAPPINGS,
  SA_6D_ROOT_GROUPS, SA_6D_TEMPLATE, VAT_ACCOUNT_CODES, mappingsFromAccounts,
  type TemplateNames,
} from '../services/gl/coa/sa';
import { SA_TAXES, SA_TAX_GROUPS } from '../services/gl/taxes/sa';
import { genericSettings, genericTemplate, standardTaxKey } from '../services/gl/coa/generic';
import {
  LINE_VAT_BOXES_SA, SA_CORRECTION_DISCLOSURE_THRESHOLD_MILLI, VAT_RETURN_BOXES_SA, isLineVatBoxSA, vatBoxDef,
  vatBoxLineTaxMilli,
} from '../services/gl/vat/boxesSA';
import { accountIdOf, genericContext, journalIdOf, saContext, taxIdOf } from '../services/gl/testing/fixtures';

const DESIGN = join(__dirname, '..', '..', '..', 'docs', 'accounting', 'DESIGN.md');
const doc = existsSync(DESIGN) ? readFileSync(DESIGN, 'utf8') : null;
const byCode = new Map(SA_6D_ACCOUNTS.map((a) => [a.code, a]));
const ARABIC = /[؀-ۿ]/;

/** مقطع الوثيقة بين عنوانين */
function section(from: string, to: string): string {
  assert.ok(doc);
  const s = doc.indexOf(from);
  const e = doc.indexOf(to, s + from.length);
  assert.ok(s >= 0 && e > s, `لم يُعثر على ${from}`);
  return doc.slice(s, e);
}
const cells = (row: string) => row.split('|').slice(1, -1).map((c) => c.trim());

function assertNames(names: TemplateNames, where: string) {
  for (const l of LEDGER_LANGS) {
    assert.equal(typeof names[l], 'string', `${where}: ${l}`);
    assert.ok(names[l].trim().length > 0, `${where}: اسم ${l} فارغ`);
    assert.ok(!names[l].includes("'"), `${where}: فاصلة عليا ASCII في ${l} (§8.7)`);
  }
  assert.match(names.ar, ARABIC, `${where}: العربية بلا حرف عربي`);
  assert.doesNotMatch(names.en, ARABIC, `${where}: الإنجليزية فيها عربي`);
}

// ═══ الحسابات ═══

test('SA_6D: 137 حساباً بعدد جدول §4.2، رموز فريدة من ٦ أرقام وأنواع صالحة وكل أب موجود', () => {
  assert.equal(SA_6D_ACCOUNTS.length, 137);
  assert.equal(byCode.size, SA_6D_ACCOUNTS.length, 'رموز مكررة');
  const groups = new Set(SA_6D_ACCOUNT_GROUPS.map((g) => g.code));
  assert.equal(groups.size, SA_6D_ACCOUNT_GROUPS.length);
  for (const a of SA_6D_ACCOUNTS) {
    assert.match(a.code, /^\d{6}$/);
    assert.ok(isAccountType(a.type), `${a.code}: نوع ${a.type}`);
    assert.ok(groups.has(a.parentCode), `${a.code}: أب ${a.parentCode} غير موجود`);
    assert.ok(a.code.startsWith(a.parentCode));
    assert.equal(a.templateRef, a.code);
    assert.equal(a.isActive, true);
    if (a.controlKind !== null) assert.ok((CONTROL_KINDS as readonly string[]).includes(a.controlKind));
    if (a.cashFlowTag !== null) assert.ok((CASH_FLOW_TAGS as readonly string[]).includes(a.cashFlowTag));
  }
  // كل نوع من §4.1 مستعمل مرة على الأقل
  for (const t of ACCOUNT_TYPES) assert.ok(SA_6D_ACCOUNTS.some((a) => a.type === t), `النوع ${t} غير مستعمل`);
});

test('SA_6D يطابق جدول §4.2 في الوثيقة صفاً صفاً (الرمز، الاسم، النوع، التسوية، المفاتيح، الرئيسي، الوسم)', (t) => {
  if (!doc) return t.skip('DESIGN.md غير موجود');
  const rows = section('### 4.2 الحسابات المزروعة', '### 4.3').split('\n').filter((l) => /^\| \d{6} \|/.test(l)).map(cells);
  assert.equal(rows.length, SA_6D_ACCOUNTS.length, 'عدد صفوف الجدول');
  rows.forEach(([code, name, typeCell, rec, keyCell], i) => {
    const a = SA_6D_ACCOUNTS[i];
    assert.equal(a.code, code, `الترتيب عند الصف ${i + 1}`);
    assert.ok(name === a.names.ar || name.startsWith(`${a.names.ar} (`), `${code}: الاسم «${name}» ≠ «${a.names.ar}»`);
    const docType = typeCell.split(' ')[0];
    assert.equal(a.type, docType, `${code}: النوع`);
    assert.equal(a.reconcile, rec.startsWith('✓'), `${code}: التسوية`);
    const tag = /وسم (\w+)/.exec(typeCell)?.[1];
    assert.deepEqual([...a.tags], tag ? [tag] : [], `${code}: الوسم`);
    const outside = keyCell.replace(/\([^)]*\)/g, ' ');
    const keys = outside.match(/\b[A-Z][A-Z_]+\b/g) ?? [];
    assert.deepEqual([...a.mappingKeys], keys, `${code}: المفاتيح`);
    const ck = [...keyCell.matchAll(/\(([A-Z_]+)\)/g)].map((m) => m[1]).find((x) => (CONTROL_KINDS as readonly string[]).includes(x));
    assert.equal(a.controlKind, ck ?? null, `${code}: controlKind`);
  });
  // رؤوس المجموعات — الجذور وحدها في الوثيقة؛ عقد المستويين الثاني والثالث للعرض (م‑7)
  const heads = section('### 4.2 الحسابات المزروعة', '### 4.3').split('\n').filter((l) => /^\| \*\*\d\*\* \|/.test(l)).map(cells);
  assert.deepEqual(heads.map((h) => h[0].replace(/\*/g, '')), SA_6D_ROOT_GROUPS.map((g) => g.code));
  heads.forEach((h, i) => assert.equal(h[1].replace(/\*/g, ''), SA_6D_ROOT_GROUPS[i].names.ar));
});

test('reconcile لا يُضبط على asset_cash، والمعادلة للنقد موسومة CASH_EQUIVALENT وحدها', () => {
  for (const a of SA_6D_ACCOUNTS) {
    if (a.type === 'asset_cash') assert.equal(a.reconcile, false, a.code);
    assert.equal(a.cashFlowTag === 'CASH_EQUIVALENT', CASH_EQUIVALENT_CODES.includes(a.code), a.code);
  }
  assert.deepEqual([...CASH_EQUIVALENT_CODES], ['111003', '112001', '112002', '112003', '112004', '112005', '112006', '112009']);
  for (const c of CASH_EQUIVALENT_CODES) assert.ok(byCode.has(c));
});

test('أسماء خمس لغات غير فارغة لكل حساب ومجموعة ودفتر وضريبة ومربع، والعربية فيها حرف عربي', () => {
  for (const a of SA_6D_ACCOUNTS) assertNames(a.names, `حساب ${a.code}`);
  for (const g of SA_6D_ACCOUNT_GROUPS) assertNames(g.names, `مجموعة ${g.code}`);
  for (const j of SA_6D_JOURNALS) assertNames(j.names, `دفتر ${j.code}`);
  for (const t of SA_TAXES) assertNames(t.names, `ضريبة ${t.key}`);
  for (const g of SA_TAX_GROUPS) assertNames(g.names, `مجموعة ضرائب ${g.key}`);
  for (const b of VAT_RETURN_BOXES_SA) assertNames(b.names, `مربع ${b.id}`);
  for (const cc of ['EG', 'KW', 'NG']) {
    const g = genericTemplate(cc);
    for (const a of g.accounts) assertNames(a.names, `${cc} حساب ${a.code}`);
    for (const t of g.taxes) assertNames(t.names, `${cc} ضريبة ${t.key}`);
    for (const tg of g.taxGroups) assertNames(tg.names, `${cc} مجموعة ${tg.key}`);
  }
});

// ═══ أوصاف الحسابات (م‑5: «لا أوصاف تحت الحسابات») ═══

test('كل حساب في القالب له وصف عربي من ١٠ إلى ٢٠ كلمة، غير مكرر ولا يعيد صياغة الاسم', () => {
  assert.equal(Object.keys(SA_6D_ACCOUNT_DESCRIPTIONS).length, SA_6D_ACCOUNTS.length, 'عدد الأوصاف ≠ عدد الحسابات');
  const seen = new Map<string, string>();
  for (const a of SA_6D_ACCOUNTS) {
    const d = a.description;
    assert.equal(typeof d, 'string', a.code);
    assert.ok(d.length > 0, `${a.code}: وصف فارغ`);
    assert.equal(d, d.trim(), `${a.code}: مسافات على الطرفين`);
    assert.match(d, ARABIC, `${a.code}: وصف بلا حرف عربي`);
    assert.ok(!d.includes("'"), `${a.code}: فاصلة عليا ASCII في الوصف (§8.7)`);
    const words = d.split(/\s+/).length;
    assert.ok(words >= 10 && words <= 20, `${a.code}: ${words} كلمة (المطلوب ١٠–٢٠)`);
    assert.notEqual(d, a.names.ar, `${a.code}: الوصف يعيد الاسم`);
    const prev = seen.get(d);
    assert.equal(prev, undefined, `${a.code}: وصف مكرر حرفياً مع ${prev}`);
    seen.set(d, a.code);
    assert.equal(SA_6D_ACCOUNT_DESCRIPTIONS[a.code], d, `${a.code}: الوصف لا يأتي من السجل`);
  }
  for (const code of Object.keys(SA_6D_ACCOUNT_DESCRIPTIONS)) assert.ok(byCode.has(code), `وصف لرمز خارج القالب: ${code}`);
  // نبرة المثالين في مراجعة الخبير
  assert.match(byCode.get('611003')!.description, /بنزين/, '611003: كلمة المحاسب');
  assert.match(byCode.get('113001')!.description, /العملاء/, '113001: ما على العملاء');
});

// ═══ عقد شجرة الحسابات (م‑7: «أرقام عارية بلا أسماء») ═══

test('كل بادئة في القالب (مستوى ١ و٢ و٣) لها عقدة مسمّاة بخمس لغات، بلا عقدة زائدة ولا اسم مكرر', () => {
  const prefixes = new Set<string>();
  for (const a of SA_6D_ACCOUNTS) for (const len of [1, 2, 3]) prefixes.add(a.code.slice(0, len));
  const byGroup = new Map(SA_6D_ACCOUNT_GROUPS.map((g) => [g.code, g]));
  assert.equal(byGroup.size, SA_6D_ACCOUNT_GROUPS.length, 'رمز عقدة مكرر');
  for (const p of prefixes) assert.ok(byGroup.has(p), `البادئة ${p} تظهر في الشجرة رقماً عارياً`);
  for (const g of SA_6D_ACCOUNT_GROUPS) {
    assert.ok(prefixes.has(g.code), `عقدة ${g.code} لا يقابلها حساب في القالب`);
    assertNames(g.names, `عقدة ${g.code}`);
    assert.doesNotMatch(g.names.ar, /^\d+$/, `عقدة ${g.code}: اسم رقمي`);
    if (g.code.length > 1) assert.ok(byGroup.has(g.code.slice(0, -1)), `عقدة ${g.code}: أبوها مفقود`);
  }
  const ar = SA_6D_ACCOUNT_GROUPS.map((g) => g.names.ar);
  assert.equal(new Set(ar).size, ar.length, 'اسم عقدة عربي مكرر');
  assert.deepEqual(SA_6D_ROOT_GROUPS.map((g) => g.code), ['1', '2', '3', '4', '5', '6', '7', '9']);
  assert.equal(byGroup.get('611')?.names.ar, 'مصروفات فرق البيع والسيارات');
  assert.equal(byGroup.get('62')?.names.ar, 'المصروفات الإدارية والعمومية');
});

// ═══ مرادفات البحث (م‑1: «بنزين» لا تطابق «وقود وزيوت السيارات») ═══

test('المرادفات: كل رمز موجود، ولا مرادف يصلح لحسابين، ولا مرادف يطابق اسم حساب آخر', () => {
  const owner = new Map<string, string>();
  const nameToCode = new Map(SA_6D_ACCOUNTS.map((a) => [a.names.ar, a.code]));
  for (const [code, list] of Object.entries(SA_6D_ACCOUNT_SYNONYMS)) {
    assert.ok(byCode.has(code), `مرادفات لرمز خارج القالب: ${code}`);
    assert.ok(list.length > 0, `${code}: قائمة مرادفات فارغة`);
    assert.equal(new Set(list).size, list.length, `${code}: مرادف مكرر داخل الحساب`);
    for (const s of list) {
      assert.equal(s, s.trim(), `${code}: مسافات حول «${s}»`);
      assert.ok(s.length >= 2, `${code}: مرادف أقصر من حرفين «${s}»`);
      assert.match(s, ARABIC, `${code}: مرادف بلا حرف عربي «${s}»`);
      assert.ok(!s.includes("'"), `${code}: فاصلة عليا ASCII في «${s}»`);
      const prev = owner.get(s);
      assert.equal(prev, undefined, `المرادف «${s}» على حسابين: ${prev} و${code}`);
      owner.set(s, code);
      const other = nameToCode.get(s);
      assert.ok(other === undefined || other === code, `المرادف «${s}» هو اسم الحساب ${other}`);
    }
  }
  // الكلمات التي ذكرها الخبير (وأخواتها) تصيب حسابها
  const expected = [
    ['بنزين', '611003'], ['محروقات', '611003'], ['سولار', '611003'],
    ['أجرة', '621004'], ['إيجار المحل', '621004'], ['كهربا', '621006'], ['مياه', '621006'],
    ['مرتبات', '621001'], ['أجور', '621001'], ['تليفون', '621007'], ['جوال', '621007'],
    ['صيانة', '621010'], ['تنظيف', '621011'], ['قهوة', '621012'], ['دعاية', '611006'],
    ['عمولة المندوب', '611002'], ['توصيل', '611010'], ['مبيعات', '411001'], ['مدينون', '113001'],
    ['كاش', '111001'], ['بنك', '111101'], ['مخزن', '114001'], ['مشتريات', '512001'], ['زكاة', '721001'],
  ] as const;
  for (const [word, code] of expected) assert.equal(owner.get(word), code, `«${word}» ⇐ ${code}`);
  // تغطية: كل مصروف تشغيلي وكل حساب إيراد ونقد وذمم له مرادف واحد على الأقل
  for (const a of SA_6D_ACCOUNTS) {
    const needs = /^(61|62|41|42|111|113)/.test(a.code);
    if (needs) assert.ok(SA_6D_ACCOUNT_SYNONYMS[a.code]?.length, `${a.code} «${a.names.ar}» بلا مرادفات`);
  }
});

// ═══ مفاتيح الربط ═══

test('كل مفتاح ربط §4.5 يشير لحساب موجود مرة واحدة ومن نوع متوافق، ومفاتيح الرئيسي على حسابها الرئيسي', () => {
  assert.equal(Object.keys(SA_6D_MAPPINGS).length, MAPPING_KEYS.length);
  for (const k of MAPPING_KEYS) {
    const code = SA_6D_MAPPINGS[k];
    const a = byCode.get(code);
    assert.ok(a, `${k} ← ${code} غير موجود`);
    assert.ok(MAPPING_KEY_ALLOWED_TYPES[k].includes(a.type), `${k} ← ${code} نوعه ${a.type}`);
    assert.equal(MAPPING_KEY_ALLOWED_TYPES[k][0], a.type, `${k}: النوع الأول المسموح = نوع القالب`);
    const ck = MAPPING_KEY_CONTROL_KIND[k];
    if (ck) assert.equal(a.controlKind, ck, `${k}: controlKind`);
  }
  assert.equal(SA_6D_MAPPINGS.PAYLINK_PAYOUT_ACCOUNT, '112001');
  assert.equal(SA_6D_MAPPINGS.OUTSTANDING_RECEIPTS, '112001');
  // كل حساب رئيسي مربوط بمفتاح (لا رئيسي يتيم)
  for (const a of SA_6D_ACCOUNTS) if (a.controlKind) assert.ok(a.mappingKeys.length > 0, a.code);
  // المفاتيح في الوثيقة = MAPPING_KEYS
  if (doc) {
    const line = section('### 4.5 مفاتيح الربط', '**الزرع').split('\n').find((l) => l.startsWith('`AR_CONTROL'));
    assert.ok(line);
    assert.deepEqual(line.replace(/`/g, '').split(',').map((s) => s.trim()), [...MAPPING_KEYS]);
  }
});

test('mappingsFromAccounts يرفض المفتاح المكرر والناقص', () => {
  const dup = SA_6D_ACCOUNTS.map((a) => (a.code === '111002' ? { ...a, mappingKeys: ['MAIN_CASH' as MappingKey] } : a));
  assert.throws(() => mappingsFromAccounts(dup), /مكرر/);
  const missing = SA_6D_ACCOUNTS.map((a) => (a.code === '611003' ? { ...a, mappingKeys: [] } : a));
  assert.throws(() => mappingsFromAccounts(missing), /FUEL/);
});

// ═══ الدفاتر ═══

test('الدفاتر الستة عشر تطابق §4.3: الرمز والنوع وsystemKey والترقيم والحساب الافتراضي واللوحة', () => {
  assert.equal(SA_6D_JOURNALS.length, JOURNAL_SYSTEM_KEYS.length);
  assert.equal(new Set(SA_6D_JOURNALS.map((j) => j.code)).size, SA_6D_JOURNALS.length);
  for (const j of SA_6D_JOURNALS) {
    assert.equal(JOURNAL_CODE_BY_SYSTEM_KEY[j.systemKey], j.code);
    assert.ok(/^[A-Z0-9]{1,6}$/.test(j.code));
    if (j.defaultAccountCode) assert.ok(byCode.has(j.defaultAccountCode), `${j.code}: ${j.defaultAccountCode}`);
  }
  const bnk = SA_6D_JOURNALS.find((j) => j.code === 'BNK1');
  assert.equal(bnk?.useOutstandingAccounts, true);
  assert.equal(SA_6D_JOURNALS.filter((j) => j.useOutstandingAccounts).length, 1);
  assert.equal(SA_6D_JOURNALS.find((j) => j.code === 'INV')?.refundSequencePrefix, 'RINV');
  assert.equal(SA_6D_JOURNALS.find((j) => j.code === 'BILL')?.refundSequencePrefix, 'RBILL');

  if (!doc) return;
  const rows = section('### 4.3 الدفاتر المزروعة', '### 4.4').split('\n').filter((l) => /^\| [A-Z0-9]+ \|/.test(l)).map(cells);
  assert.equal(rows.length, SA_6D_JOURNALS.length);
  rows.forEach(([code, name, type, sk, seq, def, dash], i) => {
    const j = SA_6D_JOURNALS[i];
    assert.equal(j.code, code);
    assert.ok(name === j.names.ar || name.startsWith(`${j.names.ar} (`), `${code}: الاسم`);
    assert.equal(j.type, type, `${code}: النوع`);
    assert.equal(j.systemKey, sk, `${code}: systemKey`);
    assert.equal(j.sequenceReset, seq.startsWith('شهري') ? 'MONTHLY' : 'YEARLY', `${code}: الترقيم`);
    assert.equal(j.defaultAccountCode, /\d{6}/.exec(def)?.[0] ?? null, `${code}: الحساب الافتراضي`);
    assert.equal(j.showOnDashboard, dash.startsWith('✓'), `${code}: اللوحة`);
  });
});

// ═══ الضرائب ═══

test('الضرائب الثلاث عشرة تطابق §4.4 في الوثيقة (المفتاح، الاسم، الاستخدام، النسبة، الفئة، الحساب، المربع)', (t) => {
  assert.equal(SA_TAXES.length, 13);
  assert.equal(new Set(SA_TAXES.map((x) => x.key)).size, 13);
  if (!doc) return t.skip('DESIGN.md غير موجود');
  const rows = section('### 4.4 الضرائب المزروعة', '### 4.5').split('\n').filter((l) => /^\| [A-Z][A-Z0-9_]+ \|/.test(l)).map(cells);
  assert.equal(rows.length, SA_TAXES.length);
  rows.forEach(([key, name, use, rate, cat, acct, box], i) => {
    const x = SA_TAXES[i];
    assert.equal(x.key, key);
    assert.equal(x.names.ar, name, `${key}: الاسم`);
    assert.equal(x.use, use);
    assert.equal(x.rate, Number(rate));
    assert.equal(x.vatCategory, cat);
    const codes = acct.match(/\d{6}/g) ?? [];
    assert.equal(x.accountCode, codes[0] ?? null, `${key}: الحساب`);
    assert.equal(x.rcOutputAccountCode, codes[1] ?? null, `${key}: حساب الاحتساب العكسي`);
    assert.equal(x.vatBox, /SA_\d+/.exec(box)?.[0] ?? null, `${key}: المربع`);
    assert.equal(x.deductible, !acct.includes('deductible=false'), `${key}: قابلية الخصم`);
    assert.equal(x.needsZatcaVerification, box.includes('⚠️'), `${key}: تحقق ZATCA`);
  });
});

test('كل ضريبة: حسابها موجود ومن الجانب الصحيح، ومربعها معرّف ومن قسم استخدامها، وذات المربع لها حساب قابل للحل', () => {
  const ctx = saContext();
  for (const x of SA_TAXES) {
    assert.ok(x.isActive);
    assert.equal(x.priceInclude, false);
    if (x.accountCode) {
      const a = byCode.get(x.accountCode);
      assert.ok(a, `${x.key}: ${x.accountCode}`);
      assert.equal(a.controlKind, x.use === 'SALE' ? 'VAT_OUT' : 'VAT_IN', x.key);
    }
    if (x.rcOutputAccountCode) assert.equal(byCode.get(x.rcOutputAccountCode)?.type, 'liability_current');
    if (x.vatCategory === 'O') {
      assert.equal(x.accountCode, null);
      assert.equal(x.vatBox, null);
    }
    if (x.vatBox) {
      const def = vatBoxDef(x.vatBox);
      assert.ok(def && def.onLines, `${x.key}: مربع ${x.vatBox}`);
      assert.equal(def.section, x.use === 'SALE' ? 'SALES' : 'PURCHASES', `${x.key}: قسم المربع`);
      assert.equal(def.taxNature, x.rate > 0 ? 'RATED' : 'ZERO', `${x.key}: طبيعة المربع`);
      const tr = ctx.taxes.byKey(x.key);
      assert.ok(tr);
      const resolved = tr.accountId ? ctx.accounts.byId(tr.accountId) : ctx.accounts.byKey(x.use === 'SALE' ? 'OUTPUT_VAT' : 'INPUT_VAT');
      assert.ok(resolved, `${x.key}: لا حساب قابل للحل`);
    }
  }
  // كل مربع سطور مستعمل بضريبة واحدة بالضبط
  for (const b of LINE_VAT_BOXES_SA) assert.equal(SA_TAXES.filter((x) => x.vatBox === b).length, 1, b);
  assert.equal(SA_TAXES.find((x) => x.key === 'NONDED15')?.deductible, false);
  assert.equal(SA_TAXES.find((x) => x.key === 'RC15')?.rcOutputAccountCode, '212003');
  for (const x of SA_TAXES) assert.ok(SA_TAX_GROUPS.some((g) => g.key === x.groupKey));
});

// ═══ مربعات الإقرار ═══

test('مربعات الإقرار الستة عشر: السطور 1–5 و7–11، المجاميع 6 و12، و13–16 محسوبة بمعانيها', () => {
  assert.equal(VAT_RETURN_BOXES_SA.length, 16);
  VAT_RETURN_BOXES_SA.forEach((b, i) => {
    assert.equal(b.no, i + 1);
    assert.equal(b.id, `SA_${i + 1}`);
  });
  assert.deepEqual([...LINE_VAT_BOXES_SA], ['SA_1', 'SA_2', 'SA_3', 'SA_4', 'SA_5', 'SA_7', 'SA_8', 'SA_9', 'SA_10', 'SA_11']);
  for (const id of VAT_BOXES_SA) assert.ok(vatBoxDef(id), id);
  assert.equal(isLineVatBoxSA('SA_6'), false);
  assert.equal(isLineVatBoxSA('SA_3'), true);
  assert.equal(isLineVatBoxSA('SA_16'), false);
  assert.deepEqual(vatBoxDef('SA_6')?.sumOf, ['SA_1', 'SA_2', 'SA_3', 'SA_4', 'SA_5']);
  assert.deepEqual(vatBoxDef('SA_12')?.sumOf, ['SA_7', 'SA_8', 'SA_9', 'SA_10', 'SA_11']);
  assert.equal(vatBoxDef('SA_12')?.deductibleTaxOnly, true);
  assert.equal(vatBoxDef('SA_14')?.kind, 'CORRECTION');
  assert.equal(vatBoxDef('SA_14')?.allowsManualAmount, true);
  assert.equal(vatBoxDef('SA_15')?.kind, 'CARRY_FORWARD');
  assert.equal(vatBoxDef('SA_16')?.kind, 'NET');
  for (const id of ['SA_2', 'SA_9', 'SA_13', 'SA_14']) assert.equal(vatBoxDef(id)?.needsZatcaVerification, true, id);
  for (const b of VAT_RETURN_BOXES_SA) if (b.kind === 'LINE') assert.deepEqual(b.columns, { amount: true, adjustments: true, tax: true });
  assert.equal(SA_CORRECTION_DISCLOSURE_THRESHOLD_MILLI, 5_000_000n);
  // إشارة الضريبة: المبيعات دائن − مدين، والمشتريات مدين − دائن
  assert.equal(vatBoxLineTaxMilli('SA_1', 0n, 150_000n), 150_000n);
  assert.equal(vatBoxLineTaxMilli('SA_7', 5_350n, 0n), 5_350n);
  assert.equal(vatBoxLineTaxMilli('SA_1', 15_000n, 0n), -15_000n);
  assert.equal(vatBoxLineTaxMilli('SA_6', 1n, 0n), null);
  if (doc) {
    const rows = section('### 7.8 إقرار ضريبة القيمة المضافة', '### 7.9').split('\n').filter((l) => /^\| (\*\*)?\d+ /.test(l));
    assert.equal(rows.length, 16);
    rows.forEach((r, i) => {
      const title = cells(r)[0].replace(/\*/g, '').replace(/^\d+ /, '').replace(/ ⚠️$/, '').trim();
      assert.equal(VAT_RETURN_BOXES_SA[i].names.ar, title, `المربع ${i + 1}`);
    });
  }
});

// ═══ القالب العام ═══

test('GENERIC_6D: نفس هيكل SA_6D (الرموز والأنواع والمفاتيح والدفاتر) بأسماء ضريبة عامة', () => {
  const g = genericTemplate('EG');
  assert.equal(g.key, 'GENERIC_6D');
  assert.equal(g.vatPct, 14);
  assert.deepEqual(g.accounts.map((a) => [a.code, a.type, a.reconcile, a.controlKind, a.mappingKeys.join()]),
    SA_6D_ACCOUNTS.map((a) => [a.code, a.type, a.reconcile, a.controlKind, a.mappingKeys.join()]));
  assert.deepEqual(g.mappings, SA_6D_MAPPINGS);
  assert.equal(g.journals, SA_6D_TEMPLATE.journals);
  for (const a of g.accounts) {
    assert.equal(a.isActive, true);
    if (VAT_ACCOUNT_CODES.includes(a.code)) assert.doesNotMatch(a.names.ar, /^ضريبة القيمة المضافة/);
  }
  assert.match(g.accounts.find((a) => a.code === '212001')!.names.ar, /ضريبة المبيعات\/القيمة المضافة/);
  const keys = g.taxes.map((x) => x.key);
  assert.deepEqual(keys, ['S14_SALE', 'Z_SALE', 'E_SALE', 'O_SALE', 'S14_PURCH', 'Z_PURCH', 'E_PURCH', 'O_PURCH']);
  for (const x of g.taxes) {
    assert.equal(x.vatBox, null, `${x.key}: بلا مربعات ZATCA`);
    assert.equal(x.isActive, true);
    if (x.accountCode) assert.ok(g.accounts.some((a) => a.code === x.accountCode));
  }
  assert.equal(g.zeroRatedSalesTaxKey, 'Z_SALE');
  assert.equal(g.defaultPurchaseTaxKey, 'S14_PURCH');
  assert.equal(standardTaxKey('SALE', 7.5), 'S7_5_SALE');
  assert.equal(genericTemplate('NG').taxes[0].key, 'S7_5_SALE');
  assert.throws(() => genericTemplate('XX'), RangeError);
  const s = genericSettings('EG');
  assert.equal(s.templateKey, 'GENERIC_6D');
  assert.equal(s.taxDeadlineRule, 'DAYS_AFTER');
  assert.ok(Number.isInteger(s.taxDeadlineDays) && (s.taxDeadlineDays as number) >= 0);
});

test('GENERIC_6D: أوصاف الحسابات موروثة من القالب السعودي إلا حسابات الضريبة فبصيغة عامة', () => {
  for (const cc of ['EG', 'KW']) {
    const g = genericTemplate(cc);
    for (const a of g.accounts) {
      const sa = byCode.get(a.code);
      assert.ok(sa, a.code);
      assert.ok(a.description.trim().length > 0, `${cc} ${a.code}: وصف فارغ`);
      const words = a.description.split(/\s+/).length;
      assert.ok(words >= 10 && words <= 20, `${cc} ${a.code}: ${words} كلمة`);
      if (VAT_ACCOUNT_CODES.includes(a.code)) {
        assert.notEqual(a.description, sa.description, `${cc} ${a.code}: الوصف لم يُعمَّم`);
        assert.doesNotMatch(a.description, /الهيئة|الزكاة/, `${cc} ${a.code}: وصف ضريبة بصيغة سعودية`);
      } else {
        assert.equal(a.description, sa.description, `${cc} ${a.code}`);
      }
    }
    const descriptions = g.accounts.map((a) => a.description);
    assert.equal(new Set(descriptions).size, descriptions.length, `${cc}: وصف مكرر`);
  }
});

test('GENERIC_6D لدول 0٪ (الكويت، قطر، العراق، ليبيا، سوريا، الصومال): حسابات الضريبة مؤرشفة والضرائب غير نشطة وبلا مفتاح صفري', () => {
  for (const cc of ['KW', 'QA', 'IQ', 'LY', 'SY', 'SO']) {
    const g = genericTemplate(cc);
    assert.equal(g.vatPct, 0, cc);
    for (const a of g.accounts) assert.equal(a.isActive, !VAT_ACCOUNT_CODES.includes(a.code), `${cc} ${a.code}`);
    assert.ok(g.taxes.length > 0);
    for (const x of g.taxes) {
      assert.equal(x.isActive, false, `${cc} ${x.key}`);
      assert.equal(x.rate, 0);
    }
    assert.equal(g.zeroRatedSalesTaxKey, null);
    assert.equal(g.defaultPurchaseTaxKey, null);
    assert.equal(genericSettings(cc).zeroRatedSalesTaxKey, null);
    // 911001 يبقى نشطاً لاستقبال ضريبة بند بنسبة موجبة (§4.2)
    assert.equal(g.accounts.find((a) => a.code === '911001')?.isActive, true);
  }
  assert.deepEqual([...VAT_ACCOUNT_CODES].sort(), ['116001', '116002', '212001', '212002', '212003', '212006']);
});

// ═══ السياق الجاهز ═══

test('saContext: يحل كل مفتاح ورمز ودفتر وضريبة بمعرّفات حتمية، والإعدادات سعودية', () => {
  const ctx = saContext();
  for (const k of MAPPING_KEYS) {
    const a = ctx.accounts.byKey(k);
    assert.ok(a, k);
    assert.equal(a.id, accountIdOf(SA_6D_MAPPINGS[k]));
  }
  const ar = ctx.accounts.byCode('113001');
  assert.deepEqual(ar, { id: 'acc_113001', code: '113001', name: 'ذمم العملاء', type: 'asset_receivable', isActive: true, reconcile: false, controlKind: 'AR' });
  for (const j of SA_6D_JOURNALS) {
    const r = ctx.journals.bySystemKey(j.systemKey);
    assert.equal(r?.id, journalIdOf(j.code));
    assert.equal(r?.defaultAccountId, j.defaultAccountCode ? accountIdOf(j.defaultAccountCode) : null);
  }
  const s15 = ctx.taxes.byKey('S15_SALE');
  assert.equal(s15?.id, taxIdOf('S15_SALE'));
  assert.equal(s15?.accountId, 'acc_212001');
  assert.equal(s15?.vatBox, 'SA_1');
  assert.equal(ctx.taxes.byKey('RC15')?.rcOutputAccountId, 'acc_212003');
  assert.equal(ctx.taxes.byKey('O_SALE')?.accountId, null);
  assert.equal(ctx.taxes.byUseAndRate('SALE', 15)?.key, 'S15_SALE');
  assert.equal(ctx.taxes.byUseAndRate('PURCHASE', 15)?.key, 'S15_PURCH');
  assert.equal(ctx.settings.templateKey, 'SA_6D');
  assert.equal(ctx.settings.currency, 'SAR');
  assert.equal(ctx.settings.zeroRatedSalesTaxKey, 'Z_SALE');
  assert.equal(ctx.settings.defaultPurchaseTaxId, 'tax_S15_PURCH');
  assert.equal(ctx.settings.paylinkFeeTaxInvoiceFrom, null);
  assert.equal(ctx.categoryAccounts('x'), null);
  assert.equal(ctx.repAnalytic('r'), null);
});

test('saContext(overrides): أرشفة وإعادة ربط وإزالة ربط وتعديل ضريبة وإعدادات وفئات وتحليلي — دون تسرب بين الاستدعاءات', () => {
  const ctx = saContext({
    settings: { paylinkFeeTaxInvoiceFrom: '2027-03-01', postSalesDiscountSeparately: false },
    accounts: { '212001': { isActive: false }, '991002': null },
    mappings: { SALES_REVENUE: '411002', FUEL: null },
    taxes: { Z_SALE: { isActive: false }, NONDED15: null },
    categoryAccounts: { cat1: { incomeAccountId: 'acc_411002', expenseAccountId: null, cogsAccountId: null, inventoryAccountId: null } },
    repAnalytics: { rep1: 'an1' },
  });
  assert.equal(ctx.accounts.byCode('212001')?.isActive, false);
  assert.equal(ctx.accounts.byKey('OUTPUT_VAT')?.isActive, false);
  assert.equal(ctx.accounts.byCode('991002'), null);
  assert.equal(ctx.accounts.byKey('SALES_REVENUE')?.code, '411002');
  assert.equal(ctx.accounts.byKey('FUEL'), null);
  assert.equal(ctx.taxes.byKey('Z_SALE')?.isActive, false);
  assert.equal(ctx.taxes.byKey('NONDED15'), null);
  assert.equal(ctx.settings.paylinkFeeTaxInvoiceFrom, '2027-03-01');
  assert.equal(ctx.settings.postSalesDiscountSeparately, false);
  assert.equal(ctx.settings.defaultPurchaseTaxId, 'tax_S15_PURCH');
  assert.equal(ctx.categoryAccounts('cat1')?.incomeAccountId, 'acc_411002');
  assert.equal(ctx.repAnalytic('rep1'), 'an1');
  const fresh = saContext();
  assert.equal(fresh.accounts.byCode('212001')?.isActive, true);
  assert.equal(fresh.accounts.byKey('SALES_REVENUE')?.code, '411001');
  assert.equal(fresh.accounts.byKey('FUEL')?.code, '611003');
  assert.equal(fresh.taxes.byKey('Z_SALE')?.isActive, true);
});

test('genericContext: الكويت بحسابات ضريبة مؤرشفة وضرائب غير نشطة، ومصر بـS14 نشطة', () => {
  const kw = genericContext('KW');
  assert.equal(kw.settings.templateKey, 'GENERIC_6D');
  assert.equal(kw.settings.currency, 'KWD');
  assert.equal(kw.settings.currencyDecimals, 3);
  assert.equal(kw.settings.zeroRatedSalesTaxKey, null);
  assert.equal(kw.settings.defaultPurchaseTaxId, null);
  assert.equal(kw.accounts.byKey('OUTPUT_VAT')?.isActive, false);
  assert.equal(kw.accounts.byKey('POSTING_SUSPENSE')?.isActive, true);
  assert.equal(kw.taxes.byUseAndRate('SALE', 0), null, 'لا ضريبة نشطة ⇒ لا علامة');
  assert.equal(kw.taxes.byUseAndRate('SALE', 15), null);
  const eg = genericContext('EG');
  assert.equal(eg.taxes.byUseAndRate('SALE', 14)?.key, 'S14_SALE');
  assert.equal(eg.taxes.byKey('S14_SALE')?.vatBox, null);
  assert.equal(eg.settings.defaultPurchaseTaxId, 'tax_S14_PURCH');
  assert.equal(eg.settings.zeroRatedSalesTaxKey, 'Z_SALE');
});

// ═══ نقاء الوحدات ═══

test('ملفات القوالب صرفة: لا prisma ولا I/O', () => {
  const root = join(__dirname, '..', 'services', 'gl');
  const files = ['coa/sa.ts', 'coa/generic.ts', 'taxes/sa.ts', 'vat/boxesSA.ts', 'testing/fixtures.ts'];
  for (const f of files) {
    const p = join(root, f);
    assert.ok(existsSync(p) && statSync(p).isFile(), f);
    const src = readFileSync(p, 'utf8');
    assert.doesNotMatch(src, /prisma|@prisma\/client|from ['"](node:)?(fs|http|https|net|child_process)['"]|process\.env/, f);
  }
  assert.ok(readdirSync(join(root, 'coa')).length >= 2);
});
