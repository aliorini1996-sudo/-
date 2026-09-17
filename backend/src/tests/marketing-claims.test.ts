/**
 * حارس صدق الادعاء في البريد التسويقي — اختبار ثابت (يقرأ المصدر، لا يشغله).
 *
 * زوايا الدول في `marketingTemplate.ts` تصل بريدا باردا إلى موزعين يقررون الشراء
 * على أساسها. كانت تعد ب«ZATCA المرحلة الثانية جاهزة» و«ETA» و«JoFotara» —
 * وثلاثتها **غير مبنية**: `provider.ts` يسجل `eta` و`peppol` و`ttn` ك`notImplemented`،
 * والمبني من منظومات الفوترة هو ZATCA وحدها: المرحلة الأولى (رمز QR بترميز TLV) وربط المرحلة
 * الثانية مع منصة فاتورة (يعلن بقرار المالك بعد اكتمال التفعيل الفعلي، بلا ادعاء اعتماد ولا موعد).
 *
 * الحارس يقلب السؤال: لا يسأل «هل النص جميل؟» بل **«هل ذكرت منظومة غير مبنية؟»** —
 * فإن بني محول يوما سقط اسمه من قائمة الممنوع تلقائيا وجاز الوعد به.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { getComplianceProvider, type ProviderId, type ComplianceInvoice } from '../compliance/provider';
import { ZATCA_CLAIM_PHRASES } from '../services/wa-agent/pricing';

const SRC = path.join(process.cwd(), 'src');
const readSrc = (rel: string) => {
  const p = path.join(SRC, rel);
  assert.ok(fs.existsSync(p), `الملف المرصود غير موجود: ${rel} — الحارس يقرأ مسارا خاطئا وينجح كاذبا`);
  return fs.readFileSync(p, 'utf8');
};

// يحذف تعليقات /* */ و// — حتى لا يحسب شرح الادعاء المحذوف ادعاء قائما
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// الأسماء التجارية لكل منظومة فوترة وطنية، مربوطة بمعرف محولها
const SYSTEM_NAMES: Record<string, string[]> = {
  eta: ['ETA', 'منظومة الفاتورة الإلكترونية المصرية'],
  peppol: ['Peppol', 'بيبول'],
  ttn: ['TTN', 'el-Fatoura', 'elFatoura'],
  // JoFotara بلا محول أصلا — ممنوعة دائما حتى يضاف مزود لها
  jordan: ['JoFotara', 'JoFatoora', 'الفوترة الوطنية الأردنية'],
};

// فاتورة صورية لسؤال المحول نفسه: هل يبني حمولة أم يعلن أنه غير منفذ؟
// نسأل الكود الحي لا نص السجل — فمتى بني محول فعلا، جاز الوعد به تلقائيا.
const PROBE: ComplianceInvoice = {
  seller: { name: 'فحص', taxNumber: '300000000000003' },
  issuedAt: new Date('2026-01-01T00:00:00Z'),
  total: 115, vatTotal: 15, currency: 'SAR',
};

async function isImplemented(id: ProviderId): Promise<boolean> {
  // ⚠️ **بلا `catch` يبتلع**: كانت النسخة الأولى ترجع `true` عند أي استثناء بحجة
  // «رمى ⇒ فيه منطق». وقد استوردت اسما غير موجود (`getProvider`)، فصار الاستدعاء
  // يرمي TypeError، فاعتبرت المنظومات كلها مبنية، ومر الحارس على ادعاء «ETA»
  // كاذبا وهو **مزروع عمدا** في التحقق السلبي. الحارس الذي ينجح حين ينكسر
  // أسوأ من غياب الحارس: يمنح ثقة بلا تغطية. فليرم إذا وليفشل الاختبار.
  const r = await getComplianceProvider(id).build(PROBE);
  return r.status !== 'not_implemented';
}

test('لا تذكر منظومة فوترة غير مبنية في زوايا البريد التسويقي', async () => {
  const src = readSrc('services/marketingTemplate.ts');
  // نفحص جسم COUNTRY_ANGLES وحده — التعليقات التوضيحية أعلاه تذكر الأسماء عمدا
  const start = src.indexOf('const COUNTRY_ANGLES');
  assert.ok(start > 0, 'COUNTRY_ANGLES غير موجودة — الحارس فقد هدفه');
  const body = src.slice(start, src.indexOf('\n};', start));

  const offenders: string[] = [];
  for (const [id, names] of Object.entries(SYSTEM_NAMES)) {
    // «jordan» ليست معرف مزود — لا محول لها أصلا، فهي ممنوعة دائما
    if (id !== 'jordan' && (await isImplemented(id as ProviderId))) continue;
    for (const n of names) {
      if (body.includes(n)) offenders.push(`«${n}» (محول ${id} غير مبني)`);
    }
  }
  assert.deepEqual(offenders, [], `ادعاء امتثال لمنظومة غير مبنية: ${offenders.join(' · ')}`);
});

// ربط المرحلة الثانية مع منصة فاتورة صار قدرة معلنة بقرار المالك بعد التفعيل الفعلي (مبني في
// مجلد compliance/zatca/). الكشف القديم كان يقرأ compliance/zatca.ts — وهو محول المرحلة الأولى
// الخالي من «المرحلة الثانية» — فكان سيفشل فور ذكر الربط الصادق. الممنوع ولو بعد التفعيل:
// الاعتماد/المصادقة/الترخيص من الهيئة (الهيئة لا تعتمد مزودي البرمجيات)، والشراكة الرسمية، وأي موعد أو رقم.
//
// ⚠️ الأنماط **مستوردة** من حارس وكيل واتساب (ZATCA_CLAIM_PHRASES في wa-agent/pricing.ts) لا منسوخة:
// كانت نسخة هذا الملف لا تطبّع التشكيل («مُعتمد من الهيئة» تمرّ) ولا تعرف «من قبل» ولا الأرقام الهندية
// («الموجة ٢٥» · «٢٠٢٦») ولا الأشهر العربية («في مارس» · «من يناير») — فتباعد الحارسان في الخادم نفسه.
// والنصّ يُفحص بتشكيله وبلا تشكيل كما يفعل guard.ts.
const stripMarks = (s: string) => s.replace(/[ً-ْٰـ]/g, '');
const zatcaViolation = (text: string): string | null => {
  for (const { pattern, reason } of ZATCA_CLAIM_PHRASES) {
    const m = text.match(pattern) || stripMarks(text).match(pattern);
    if (m) return `${reason}: «${m[0]}»`;
  }
  return null;
};

test('الحارس نفسه يلتقط صيغ الاعتماد والمواعيد (فحص سلبي مزروع)', () => {
  // حارس لا يلتقط شيئا ينجح كاذبا — نثبت أولا أن الأنماط تعض
  for (const t of [
    'نظامنا معتمد من هيئة الزكاة', 'مصادق من الهيئة', 'شريك رسمي لهيئة الزكاة', 'Certified by ZATCA', 'ZATCA-approved invoicing',
    'نظامنا مُعتمد من الهيئة', 'مُعتمَد من هيئة الزكاة', 'معتمد من قبل هيئة الزكاة',
  ]) {
    assert.match(zatcaViolation(t) ?? '', /اعتماد رسمي|شراكة رسمية/, `نمط الاعتماد لم يلتقط: ${t}`);
  }
  for (const t of [
    'ندعم ربط المرحلة الثانية منذ سبتمبر 2026', 'المرحلة الثانية مفعلة قبل الموجة 25', 'Phase 2 integration live since January',
    'ندعم ربط المرحلة الثانية في مارس', 'ربط المرحلة الثانية مفعّل من يناير', 'المرحلة الثانية مفعلة قبل الموجة ٢٥', 'ندعم المرحلة الثانية عام ٢٠٢٦',
  ]) {
    assert.match(zatcaViolation(t) ?? '', /موعد أو رقم/, `نمط الموعد لم يلتقط: ${t}`);
  }
  // والصيغة المعتمدة تمر
  const ok = 'فاتورة ضريبية برمز QR وندعم ربط المرحلة الثانية مع منصة فاتورة التابعة لهيئة الزكاة والضريبة والجمارك ZATCA';
  assert.equal(zatcaViolation(ok), null, 'الصيغة المعتمدة محجوبة');
});

test('ادعاء المرحلة الثانية مسموح بصيغة الدعم وحدها: بلا اعتماد ولا شراكة ولا موعد', () => {
  for (const rel of ['services/marketingTemplate.ts', 'services/leadEmailer.ts']) {
    const p = path.join(SRC, rel);
    if (!fs.existsSync(p)) continue;
    // التعليقات تشرح **لماذا** تمنع الصيغ، فتذكرها حتما — نفحص الكود المرسل وحده
    const t = stripComments(fs.readFileSync(p, 'utf8'));
    const v = zatcaViolation(t);
    assert.equal(v, null, `${rel}: ${v} — الهيئة لا تعتمد مزودي البرمجيات ولا موعد أو رقم مثبت ينشر`);
  }
});
