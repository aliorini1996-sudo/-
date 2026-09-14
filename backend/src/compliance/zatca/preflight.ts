// ============================================================================
// ZATCA المرحلة الثانية (Z1) — الفحص المسبق: يمنع الإصدار **قبل** استهلاك أي ICV
// ----------------------------------------------------------------------------
// design §3 Z1 «Preflight». كل مخالفة بالعربية وتُسمّي الحقل؛ severity='error' تمنع الإصدار
// (422 ZATCA_PREFLIGHT) و'warning' تُعرض فقط. يعمل على المستند نفسه (النصوص التي ستُكتب)
// لا على بيانات قاعدة البيانات — فما يُفحص هو ما يُرسل حرفياً.
// الفحوص الحسابية (BR-CO-10..17 · BR-KSA-51) دفاعية: amounts.ts يضمنها بالبناء، وهنا تُمسك
// أي مستند بُني أو عُدِّل خارج ذلك المسار.
// ============================================================================

import { Dec, decFromString, divRoundHalfUp, isAmountString, parseAmount, pow10 } from './decimal';
import { UblDocument, VAT_CATEGORIES, ZatcaIssue } from './model';
import { isIsoDate, isIsoTime } from './time';
import { buyerIssues, charLength, sanitizeText, sellerIssues, TEXT_MAX_CHARS, VATEX_CATEGORY } from './validators';

const err = (rule: string, field: string, messageAr: string): ZatcaIssue => ({ rule, field, messageAr, severity: 'error' });
const warn = (rule: string, field: string, messageAr: string): ZatcaIssue => ({ rule, field, messageAr, severity: 'warning' });
/** فارغ كما سيُكتب: نصّ من محارف تحكّم فقط يحذفه المُسلسِل فهو فارغ. */
const blank = (s: unknown) => typeof s !== 'string' || sanitizeText(s).trim() === '';

/**
 * كل نصّ في المستند يجب أن يكون بصيغته النهائية (sanitizeText) كما يبنيه mapInvoice؛ وإلا كتب
 * المُسلسِل غير ما في النموذج واللقطة ومصدر QR (وسم 1). يمشي الشجرة كلها فلا يفوته حقل.
 */
function textIssues(value: unknown, path: string, out: ZatcaIssue[]) {
  if (typeof value === 'string') {
    if (sanitizeText(value) !== value) {
      out.push(err('XML-TEXT', path, `نصّ الحقل ${path} يحتوي محارف تحكّم أو نهايات أسطر غير مسموحة — أعد إدخاله`));
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => textIssues(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) textIssues(v, path ? `${path}.${k}` : k, out);
  }
}

const tooLong = (s: string | undefined) => typeof s === 'string' && charLength(s) > TEXT_MAX_CHARS;

const DECIMAL = /^\d+(\.\d+)?$/;

function amountOrNull(out: ZatcaIssue[], value: unknown, field: string, label: string): bigint | null {
  if (!isAmountString(value)) {
    out.push(err('BR-DEC', field, `${label}: صيغة مبلغ غير صالحة (المطلوب خانتان عشريتان)`));
    return null;
  }
  const v = parseAmount(value);
  if (v < 0n) out.push(err('BR-KSA-F-04', field, `${label}: المبالغ يجب ألا تكون سالبة`));
  return v;
}

function decOrNull(value: unknown): Dec | null {
  return typeof value === 'string' && DECIMAL.test(value) ? decFromString(value) : null;
}

/** r2(taxable × percent / 100) بالهللات. */
function taxOf(taxable: bigint, percent: Dec): bigint {
  return divRoundHalfUp(taxable * percent.units, 100n * pow10(percent.scale));
}

/** هل النسبة تساوي عدداً صحيحاً معيّناً؟ */
function pctEquals(p: Dec, n: bigint): boolean {
  return p.units === n * pow10(p.scale);
}

/**
 * يعيد كل مخالفات المستند. kind يأتي من النوع الفرعي المجمَّد (01 ⇒ standard).
 * لا يرمي أبداً — المستند قد يكون ناقصاً أو مشوّهاً وهذا بالضبط ما يُبلَّغ عنه.
 */
export function preflightIssues(doc: UblDocument, kind: 'standard' | 'simplified'): ZatcaIssue[] {
  const out: ZatcaIssue[] = [];
  const isNote = doc.typeCode === '381' || doc.typeCode === '383';
  textIssues(doc, '', out);

  // ═══ الترويسة ═══
  if (blank(doc.id)) out.push(err('BR-02', 'id', 'رقم الفاتورة مفقود'));
  else if (doc.id.length > 127) out.push(err('BR-KSA-F-06', 'id', 'رقم الفاتورة أطول من 127 حرفاً'));
  if (typeof doc.uuid !== 'string' || !/^[0-9A-Za-z-]+$/.test(doc.uuid)) {
    out.push(err('BR-KSA-03', 'uuid', 'المعرّف الفريد للفاتورة (UUID) غير صالح'));
  }
  if (!isIsoDate(doc.issueDate)) out.push(err('BR-03', 'issueDate', 'تاريخ الإصدار غير صالح (YYYY-MM-DD)'));
  if (!isIsoTime(doc.issueTime)) out.push(err('BR-KSA-70', 'issueTime', 'وقت الإصدار غير صالح (HH:mm:ss)'));
  if (!['388', '381', '383'].includes(doc.typeCode)) out.push(err('BR-KSA-05', 'typeCode', 'رمز نوع المستند غير مدعوم (388 أو 381 أو 383)'));
  if (typeof doc.typeName !== 'string' || !/^(01|02)00000$/.test(doc.typeName)) {
    out.push(err('BR-KSA-06', 'typeName', 'تصنيف الفاتورة غير صالح (المدعوم 0100000 أو 0200000)'));
  } else if ((kind === 'standard') !== doc.typeName.startsWith('01')) {
    out.push(err('BR-KSA-06', 'typeName', 'نوع الفحص لا يطابق نوع الفاتورة المجمَّد (ضريبية/مبسطة)'));
  }
  if (!Number.isSafeInteger(doc.icv) || doc.icv < 1) out.push(err('BR-KSA-33', 'icv', 'عدّاد الفواتير (ICV) يجب أن يكون عدداً صحيحاً موجباً'));
  if (typeof doc.pih !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(doc.pih)) out.push(err('BR-KSA-61', 'pih', 'تجزئة الفاتورة السابقة (PIH) مفقودة أو غير صالحة'));
  if (doc.currency !== 'SAR') {
    out.push(err('ZATCA_CURRENCY', 'currency', `عملة الفاتورة يجب أن تكون الريال السعودي SAR للشركات على المرحلة الثانية (الحالية: ${doc.currency || 'غير محددة'})`));
  }

  // ═══ الإشعارات الدائنة والمدينة ═══
  if (isNote) {
    const refs = (doc.billingReferences ?? []).filter(r => !blank(r));
    if (!refs.length) out.push(err('BR-KSA-56', 'billingReferences', 'رقم الفاتورة الأصلية مفقود — الإشعار يجب أن يُربط بفاتورته'));
    else if (refs.join(',').length > 5000) out.push(err('BR-KSA-56', 'billingReferences', 'مراجع الفواتير الأصلية أطول من 5000 حرف'));
    if (blank(doc.instructionNote)) out.push(err('BR-KSA-17', 'instructionNote', 'سبب إصدار الإشعار مفقود'));
    if (blank(doc.paymentMeansCode)) out.push(err('BR-49', 'paymentMeansCode', 'طريقة الدفع مفقودة (مطلوبة مع سبب الإشعار)'));
  }
  if (!blank(doc.paymentMeansCode) && !/^\d{1,3}$/.test(doc.paymentMeansCode!)) {
    out.push(err('BR-KSA-16', 'paymentMeansCode', 'رمز طريقة الدفع غير صالح'));
  }
  if (tooLong(doc.instructionNote)) {
    out.push(err('BR-KSA-F-06', 'instructionNote', `سبب إصدار الإشعار أطول من ${TEXT_MAX_CHARS} حرف — اختصره`));
  }
  if (doc.supplyDate !== undefined && !isIsoDate(doc.supplyDate)) {
    out.push(err('BR-KSA-F-01', 'supplyDate', 'تاريخ التوريد غير صالح (YYYY-MM-DD)'));
  } else if (kind === 'standard' && doc.typeCode === '388' && blank(doc.supplyDate)) {
    out.push(err('BR-KSA-15', 'supplyDate', 'تاريخ التوريد مفقود — إلزامي في الفاتورة الضريبية'));
  }

  // ═══ الأطراف ═══
  out.push(...sellerIssues(doc.supplier));
  out.push(...buyerIssues(kind, doc.customer));

  // ═══ البنود ═══
  const lines = doc.lines ?? [];
  if (!lines.length) out.push(err('BR-16', 'lines', 'الفاتورة بلا بنود'));
  let sumLines: bigint | null = 0n;
  const lineNet = new Map<string, bigint>(); // (فئة|نسبة) ⇒ Σ BT-131
  const lineCodes = new Map<string, Set<string>>();
  lines.forEach((l, i) => {
    const n = i + 1;
    const f = (x: string) => `lines[${i}].${x}`;
    const label = blank(l.name) ? `البند ${n}` : `البند ${n} «${l.name}»`;
    if (!Number.isInteger(l.id) || l.id < 1 || l.id > 999999) out.push(err('BR-21', f('id'), `رقم ${label} غير صالح`));
    if (blank(l.name)) out.push(err('BR-25', f('name'), `اسم الصنف في البند ${n} مفقود`));
    else if (tooLong(l.name)) out.push(err('BR-KSA-F-06', f('name'), `اسم الصنف في البند ${n} أطول من ${TEXT_MAX_CHARS} حرف — اختصره في بطاقة المنتج`));
    if (blank(l.unitCode)) out.push(err('BR-22', f('unitCode'), `وحدة القياس في ${label} مفقودة`));

    const q = decOrNull(l.quantity);
    if (!q || q.units <= 0n) out.push(err('BR-KSA-F-04', f('quantity'), `الكمية في ${label} يجب أن تكون أكبر من صفر`));
    const price = decOrNull(l.priceAmount);
    if (!price) out.push(err('BR-KSA-F-04', f('priceAmount'), `سعر الوحدة في ${label} غير صالح أو سالب`));

    const ext = amountOrNull(out, l.lineExtension, f('lineExtension'), `صافي ${label}`);
    const tax = amountOrNull(out, l.taxAmount, f('taxAmount'), `ضريبة ${label}`);
    const rnd = amountOrNull(out, l.roundingAmount, f('roundingAmount'), `إجمالي ${label} شامل الضريبة`);
    // UNVERIFIED(U5): قبول البنود صفرية القيمة (هدية/خصم 100%) — design §6.2؛ تُمنع حتى تُحسم في Z6
    if ((price && price.units === 0n) || ext === 0n) {
      out.push(err('ZERO-VALUE-LINE', f('priceAmount'), `${label} بقيمة صفرية — البنود المجانية غير مدعومة في المرحلة الثانية حالياً`));
    }
    if (ext !== null && tax !== null && rnd !== null && rnd !== ext + tax) {
      out.push(err('BR-KSA-51', f('roundingAmount'), `إجمالي ${label} لا يساوي صافيه مضافاً إليه ضريبته`));
    }
    let allowance = 0n;
    if (l.allowance) {
      const a = amountOrNull(out, l.allowance.amount, f('allowance.amount'), `خصم ${label}`);
      if (a !== null) allowance = a;
      if (blank(l.allowance.reason)) out.push(err('BR-42', f('allowance.reason'), `سبب خصم ${label} مفقود`));
      const hasMul = !blank(l.allowance.multiplier);
      const hasBase = !blank(l.allowance.baseAmount);
      if (hasMul !== hasBase) {
        out.push(err('BR-KSA-EN16931-04', f('allowance'), `خصم ${label}: النسبة والمبلغ الأساس يجب أن يُذكرا معاً`));
      } else if (hasMul && a !== null) {
        const m = decOrNull(l.allowance.multiplier);
        const b = amountOrNull(out, l.allowance.baseAmount, f('allowance.baseAmount'), `أساس خصم ${label}`);
        if (!m || m.scale > 2) out.push(err('BR-KSA-DEC-01', f('allowance.multiplier'), `نسبة خصم ${label} يجب ألا تتجاوز خانتين عشريتين`));
        else if (b !== null && taxOf(b, m) !== a) out.push(err('BR-KSA-EN16931-03', f('allowance.amount'), `مبلغ خصم ${label} لا يساوي الأساس × النسبة`));
      }
    }
    if (q && price && ext !== null) {
      const gross = divRoundHalfUp(q.units * price.units * 100n, pow10(q.scale + price.scale));
      if (gross - allowance !== ext) {
        out.push(warn('BR-KSA-EN16931-11', f('lineExtension'), `صافي ${label} لا يساوي الكمية × السعر − الخصم (قد تُعيده الهيئة تحذيراً)`));
      }
    }

    // الفئة والنسبة والإعفاء
    const cat = l.vat?.category;
    const pct = decOrNull(l.vat?.percent);
    if (!(VAT_CATEGORIES as readonly string[]).includes(cat)) {
      out.push(err('BR-KSA-18', f('vat.category'), `فئة الضريبة في ${label} غير صالحة (S أو Z أو E أو O)`));
    } else if (!pct) {
      out.push(err('BR-KSA-DEC-02', f('vat.percent'), `نسبة الضريبة في ${label} غير صالحة`));
    } else if (cat === 'S') {
      // BR-KSA-84 (SDK ≥ 3.2.9، مصدر ثانوي [REL]): الفئة S بنسبة 5 أو 15 فقط
      if (!pctEquals(pct, 15n) && !pctEquals(pct, 5n)) out.push(err('BR-KSA-84', f('vat.percent'), `نسبة الضريبة القياسية في ${label} يجب أن تكون 15% أو 5%`));
      if (!blank(l.vat.exemptionCode) || !blank(l.vat.exemptionReason)) out.push(err('BR-S-10', f('vat.exemptionCode'), `${label} خاضع للنسبة القياسية ولا يحمل رمز إعفاء`));
    } else {
      if (pct.units !== 0n) out.push(err(`BR-${cat}-05`, f('vat.percent'), `${label} في الفئة ${cat} يجب أن تكون نسبته 0%`));
      const code = l.vat.exemptionCode;
      if (blank(code)) out.push(err('BR-KSA-23', f('vat.exemptionCode'), `رمز سبب الإعفاء/الصفرية مفقود في ${label} — اختره في بطاقة المنتج`));
      else if (VATEX_CATEGORY[code!] !== cat) out.push(err('BR-KSA-CL-04', f('vat.exemptionCode'), `رمز الإعفاء ${code} غير صالح للفئة ${cat} في ${label}`));
      if (blank(l.vat.exemptionReason)) out.push(err('BR-KSA-24', f('vat.exemptionReason'), `نصّ سبب الإعفاء/الصفرية مفقود في ${label}`));
    }
    if (cat && l.vat?.percent) {
      const key = `${cat}|${l.vat.percent}`;
      if (ext !== null) lineNet.set(key, (lineNet.get(key) ?? 0n) + ext);
      if (!lineCodes.has(key)) lineCodes.set(key, new Set());
      lineCodes.get(key)!.add(l.vat.exemptionCode ?? '');
    }
    sumLines = ext !== null && sumLines !== null ? sumLines + ext : null;
  });

  // ═══ خصومات المستند ═══
  let sumAllowances: bigint | null = 0n;
  const docAllow = new Map<string, bigint>();
  (doc.docAllowances ?? []).forEach((a, i) => {
    const f = (x: string) => `docAllowances[${i}].${x}`;
    const v = amountOrNull(out, a.amount, f('amount'), `خصم الفاتورة ${i + 1}`);
    if (!(VAT_CATEGORIES as readonly string[]).includes(a.category) || blank(a.percent)) {
      out.push(err('BR-32', f('category'), `خصم الفاتورة ${i + 1} بلا فئة ضريبية صالحة`));
    }
    if (blank(a.reason) && blank(a.reasonCode)) out.push(err('BR-33', f('reason'), `سبب خصم الفاتورة ${i + 1} مفقود`));
    const key = `${a.category}|${a.percent}`;
    if (v !== null) docAllow.set(key, (docAllow.get(key) ?? 0n) + v);
    sumAllowances = v !== null && sumAllowances !== null ? sumAllowances + v : null;
  });

  // ═══ تفصيل الضريبة ═══
  let sumTax: bigint | null = 0n;
  const subtotalKeys = new Set<string>();
  const subtotals = doc.subtotals ?? [];
  if (!subtotals.length) out.push(err('BR-CO-18', 'subtotals', 'تفصيل الضريبة حسب الفئة مفقود'));
  subtotals.forEach((s, i) => {
    const f = (x: string) => `subtotals[${i}].${x}`;
    const key = `${s.category}|${s.percent}`;
    if (subtotalKeys.has(key)) out.push(err('BR-CO-18', f('category'), `تفصيل الضريبة مكرّر للفئة ${s.category} بنسبة ${s.percent}%`));
    subtotalKeys.add(key);
    const taxable = amountOrNull(out, s.taxable, f('taxable'), `وعاء الفئة ${s.category}`);
    const tax = amountOrNull(out, s.tax, f('tax'), `ضريبة الفئة ${s.category}`);
    const pct = decOrNull(s.percent);
    if (!(VAT_CATEGORIES as readonly string[]).includes(s.category)) {
      out.push(err('BR-KSA-18', f('category'), `فئة ضريبية غير صالحة في التفصيل (${String(s.category)})`));
    } else if (s.category !== 'S') {
      if (blank(s.exemptionCode)) out.push(err('BR-KSA-23', f('exemptionCode'), `رمز سبب الإعفاء مفقود لتفصيل الفئة ${s.category}`));
      if (blank(s.exemptionReason)) out.push(err('BR-KSA-24', f('exemptionReason'), `نصّ سبب الإعفاء مفقود لتفصيل الفئة ${s.category}`));
      // UNVERIFIED (xml report §5.8؛ غير مدرج في design §6.2): رموز إعفاء مختلفة داخل (فئة، نسبة) واحدة لا يسعها تفصيل واحد — تُمنع احتياطاً
      const codes = lineCodes.get(key);
      if (codes && codes.size > 1) out.push(err('BR-KSA-23', f('exemptionCode'), `بنود الفئة ${s.category} تحمل رموز إعفاء مختلفة — افصلها في فواتير مستقلة`));
      else if (codes && codes.size === 1 && !blank(s.exemptionCode) && !codes.has(s.exemptionCode!)) {
        out.push(err('BR-KSA-23', f('exemptionCode'), `رمز الإعفاء في تفصيل الفئة ${s.category} لا يطابق رمز بنودها`));
      }
    }
    if (pct && taxable !== null && tax !== null && taxOf(taxable, pct) !== tax) {
      out.push(err('BR-CO-17', f('tax'), `ضريبة الفئة ${s.category} لا تساوي الوعاء × ${s.percent}% مقرّبة`));
    }
    if (taxable !== null && sumLines !== null && sumAllowances !== null && lineNet.has(key)) {
      const expected = lineNet.get(key)! - (docAllow.get(key) ?? 0n);
      if (expected !== taxable) out.push(err(`BR-${s.category}-08`, f('taxable'), `وعاء الفئة ${s.category} لا يساوي صافي بنودها ناقص خصوماتها`));
    }
    sumTax = tax !== null && sumTax !== null ? sumTax + tax : null;
  });
  for (const key of lineNet.keys()) {
    if (!subtotalKeys.has(key)) out.push(err('BR-CO-18', 'subtotals', `لا يوجد تفصيل ضريبي للفئة/النسبة ${key.replace('|', ' ')}%`));
  }
  // BR-KSA-49 / BR-KSA-25: إعفاء التعليم/الصحة الخاصة للمواطن يتطلب هويته الوطنية، واسمه في المبسطة
  const isEduHea = (c: unknown) => c === 'VATEX-SA-EDU' || c === 'VATEX-SA-HEA';
  if (subtotals.some(s => isEduHea(s.exemptionCode)) || lines.some(l => isEduHea(l.vat?.exemptionCode))) {
    if (doc.customer?.otherId?.scheme !== 'NAT' || blank(doc.customer.otherId.value)) {
      out.push(err('BR-KSA-49', 'customer.otherId.scheme', 'إعفاء التعليم/الصحة الخاصة يتطلب رقم الهوية الوطنية للعميل (NAT) — أدخله في بطاقة العميل'));
    }
    if (kind === 'simplified' && blank(doc.customer?.registrationName)) {
      out.push(err('BR-KSA-25', 'customer.registrationName', 'إعفاء التعليم/الصحة الخاصة يتطلب اسم العميل في الفاتورة المبسطة'));
    }
  }

  // BR-O-13: فاتورة فيها تفصيل «خارج النطاق» (O) لا تحمل خصم مستند إلا في الفئة O — وخصم الفاتورة
  // يُوزَّع على كل الفئات (BR-32) فلا يستوفيها مع بنود من فئة أخرى. BR-O-11/12 في EN16931 (منع O مع
  // غيرها أصلاً) لا تُطبَّق: عيّنة الـSDK «Out of Scope Standard Tax Invoice» تجمع O وS بلا خصم مستند.
  // BR-O-14 تخصّ رسوم المستند ولا رسوم في v1.
  if (subtotals.some(s => s.category === 'O') || lines.some(l => l.vat?.category === 'O')) {
    (doc.docAllowances ?? []).forEach((a, i) => {
      if (a.category !== 'O') {
        out.push(err('BR-O-13', `docAllowances[${i}].category`, 'الفاتورة تضمّ بنوداً خارج نطاق الضريبة (O) مع خصم على مستوى الفاتورة — ألغِ خصم الفاتورة أو أصدر البنود خارج النطاق في فاتورة مستقلة'));
      }
    });
  }

  // ═══ الإجماليات ═══
  const t = doc.totals ?? ({} as UblDocument['totals']);
  const ext = amountOrNull(out, t.lineExtension, 'totals.lineExtension', 'مجموع صافي البنود');
  const allow = amountOrNull(out, t.allowanceTotal, 'totals.allowanceTotal', 'مجموع خصومات الفاتورة');
  const excl = amountOrNull(out, t.taxExclusive, 'totals.taxExclusive', 'الإجمالي قبل الضريبة');
  const taxT = amountOrNull(out, t.taxTotal, 'totals.taxTotal', 'إجمالي الضريبة');
  const incl = amountOrNull(out, t.taxInclusive, 'totals.taxInclusive', 'الإجمالي شامل الضريبة');
  const prepaid = amountOrNull(out, t.prepaid, 'totals.prepaid', 'المبلغ المدفوع مسبقاً');
  const rounding = t.payableRounding === undefined ? 0n : amountOrNull(out, t.payableRounding, 'totals.payableRounding', 'مبلغ التقريب');
  const payable = amountOrNull(out, t.payable, 'totals.payable', 'المبلغ المستحق');
  const check = (ok: boolean, rule: string, field: string, msg: string) => { if (!ok) out.push(err(rule, field, msg)); };
  if (ext !== null && sumLines !== null) check(ext === sumLines, 'BR-CO-10', 'totals.lineExtension', 'مجموع صافي البنود لا يساوي صافي البنود فرادى');
  if (allow !== null && sumAllowances !== null) check(allow === sumAllowances, 'BR-CO-11', 'totals.allowanceTotal', 'مجموع خصومات الفاتورة لا يساوي الخصومات فرادى');
  if (excl !== null && ext !== null && allow !== null) check(excl === ext - allow, 'BR-CO-13', 'totals.taxExclusive', 'الإجمالي قبل الضريبة لا يساوي صافي البنود ناقص الخصومات');
  if (taxT !== null && sumTax !== null) check(taxT === sumTax, 'BR-CO-14', 'totals.taxTotal', 'إجمالي الضريبة لا يساوي مجموع تفصيلها');
  if (incl !== null && excl !== null && taxT !== null) check(incl === excl + taxT, 'BR-CO-15', 'totals.taxInclusive', 'الإجمالي شامل الضريبة لا يساوي ما قبلها مضافاً إليه الضريبة');
  if (payable !== null && incl !== null && prepaid !== null && rounding !== null) {
    check(payable === incl - prepaid + rounding, 'BR-CO-16', 'totals.payable', 'المبلغ المستحق لا يساوي الإجمالي ناقص المدفوع مسبقاً مع التقريب');
  }
  return out;
}

/** هل في القائمة ما يمنع الإصدار؟ */
export function hasBlockingIssues(issues: ZatcaIssue[]): boolean {
  return issues.some(i => i.severity === 'error');
}
