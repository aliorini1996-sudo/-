/**
 * حارس صدق الادّعاء في البريد التسويقي — اختبار ثابت (يقرأ المصدر، لا يشغّله).
 *
 * زوايا الدول في `marketingTemplate.ts` تصل بريداً بارداً إلى موزّعين يقرّرون الشراء
 * على أساسها. كانت تَعِد بـ«ZATCA المرحلة الثانية جاهزة» و«ETA» و«JoFotara» —
 * وثلاثتها **غير مبنية**: `provider.ts` يسجّل `eta` و`peppol` و`ttn` كـ`notImplemented`،
 * والمبنيّ وحده هو ZATCA المرحلة الأولى (رمز QR بترميز TLV).
 *
 * الحارس يقلب السؤال: لا يسأل «هل النصّ جميل؟» بل **«هل ذُكرت منظومة غير مبنية؟»** —
 * فإن بُني محوّلٌ يوماً سقط اسمه من قائمة الممنوع تلقائياً وجاز الوعد به.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { getComplianceProvider, type ProviderId, type ComplianceInvoice } from '../compliance/provider';

const SRC = path.join(process.cwd(), 'src');
const readSrc = (rel: string) => {
  const p = path.join(SRC, rel);
  assert.ok(fs.existsSync(p), `الملف المرصود غير موجود: ${rel} — الحارس يقرأ مساراً خاطئاً وينجح كاذباً`);
  return fs.readFileSync(p, 'utf8');
};

// يحذف تعليقات /* */ و// — حتى لا يُحسب شرحُ الادّعاء المحذوف ادّعاءً قائماً
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// الأسماء التجارية لكل منظومة فوترة وطنية، مربوطةً بمعرّف محوّلها
const SYSTEM_NAMES: Record<string, string[]> = {
  eta: ['ETA', 'منظومة الفاتورة الإلكترونية المصرية'],
  peppol: ['Peppol', 'بيبول'],
  ttn: ['TTN', 'el-Fatoura', 'elFatoura'],
  // JoFotara بلا محوّل أصلاً — ممنوعة دائماً حتى يُضاف مزوّد لها
  jordan: ['JoFotara', 'JoFatoora', 'الفوترة الوطنية الأردنية'],
};

// فاتورة صوريّة لسؤال المحوّل نفسه: هل يبني حمولةً أم يعلن أنّه غير مُنفَّذ؟
// نسأل الكودَ الحيّ لا نصَّ السجلّ — فمتى بُني محوّلٌ فعلاً، جاز الوعد به تلقائياً.
const PROBE: ComplianceInvoice = {
  seller: { name: 'فحص', taxNumber: '300000000000003' },
  issuedAt: new Date('2026-01-01T00:00:00Z'),
  total: 115, vatTotal: 15, currency: 'SAR',
};

async function isImplemented(id: ProviderId): Promise<boolean> {
  // ⚠️ **بلا `catch` يبتلع**: كانت النسخة الأولى تُرجع `true` عند أي استثناء بحجّة
  // «رمى ⇒ فيه منطق». وقد استوردتُ اسماً غير موجود (`getProvider`)، فصار الاستدعاء
  // يرمي TypeError، فاعتُبرت المنظومات كلّها مبنية، ومرّ الحارس على ادّعاء «ETA»
  // كاذباً وهو **مزروع عمداً** في التحقّق السلبي. الحارس الذي ينجح حين ينكسر
  // أسوأ من غياب الحارس: يمنح ثقةً بلا تغطية. فليَرمِ إذاً وليُفشل الاختبار.
  const r = await getComplianceProvider(id).build(PROBE);
  return r.status !== 'not_implemented';
}

test('لا تُذكر منظومة فوترة غير مبنية في زوايا البريد التسويقي', async () => {
  const src = readSrc('services/marketingTemplate.ts');
  // نفحص جسم COUNTRY_ANGLES وحده — التعليقات التوضيحية أعلاه تذكر الأسماء عمداً
  const start = src.indexOf('const COUNTRY_ANGLES');
  assert.ok(start > 0, 'COUNTRY_ANGLES غير موجودة — الحارس فقد هدفه');
  const body = src.slice(start, src.indexOf('\n};', start));

  const offenders: string[] = [];
  for (const [id, names] of Object.entries(SYSTEM_NAMES)) {
    // «jordan» ليست معرّف مزوّد — لا محوّل لها أصلاً، فهي ممنوعة دائماً
    if (id !== 'jordan' && (await isImplemented(id as ProviderId))) continue;
    for (const n of names) {
      if (body.includes(n)) offenders.push(`«${n}» (محوّل ${id} غير مبنيّ)`);
    }
  }
  assert.deepEqual(offenders, [], `ادّعاء امتثال لمنظومة غير مبنية: ${offenders.join(' · ')}`);
});

test('لا يُوعَد بمرحلة ZATCA الثانية والمبنيّ هو الأولى', () => {
  const zatca = readSrc('compliance/zatca.ts');
  const isPhase2 = /المرحلة الثانية|Phase.?2/.test(zatca);
  if (isPhase2) return; // بُنيت فعلاً ⇒ الوعد صار صادقاً

  for (const rel of ['services/marketingTemplate.ts', 'services/leadEmailer.ts']) {
    const p = path.join(SRC, rel);
    if (!fs.existsSync(p)) continue;
    // التعليقات تشرح **لماذا** حُذف الادّعاء، فتذكره حتماً — نفحص الكود المُرسَل وحده
    const t = stripComments(fs.readFileSync(p, 'utf8'));
    const bad = /المرحلة الثانية|Phase[- ]?2|Phase.?Two/i.test(t);
    assert.equal(bad, false, `${rel}: يَعِد بالمرحلة الثانية من ZATCA وهي غير مبنية (المبنيّ: المرحلة الأولى — رمز QR)`);
  }
});
