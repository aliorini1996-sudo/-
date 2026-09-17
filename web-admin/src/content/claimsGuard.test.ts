import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, checkText, findViolation, norm } from '../../scripts/claims-rules.mjs';

/**
 * حرّاس حارس الادّعاءات (scripts/verify-claims.mjs) — بالقواعد نفسها التي تحرس dist.
 *
 * قرار المالك: «ربط المرحلة الثانية مع منصة فاتورة» يُعلَن بعد اكتمال التفعيل الفعلي.
 * فصيغة الدعم تمرّ، ويبقى محجوباً ولو بعد التفعيل: الاعتماد/المصادقة/الترخيص من الهيئة،
 * والشراكة الرسمية معها، وأي موعد أو رقم مقرون بالمرحلة الثانية. والنفي القديم
 * («غير مبنية» · «الأولى فقط») يُكشف تحذيراً حتى يُحرَّر من CMS.
 *
 * حارسٌ لا يعضّ ينجح كاذباً، وحارسٌ يعضّ المحتوى الصحيح يُعطَّل — فيُختبر الطرفان.
 */

const APPROVED = 'zatca-approved';
const DATED = 'zatca-phase2-dated';
const STALE = 'zatca-phase2-stale-denial';

const expectHits = (text: string, expected: string[]) => {
  assert.deepEqual(checkText(text), expected, `«${text}»`);
};

test('صيغة دعم ربط المرحلة الثانية تمرّ بلغات الموقع الخمس', () => {
  for (const t of [
    'ندعم ربط المرحلة الثانية مع منصة فاتورة (هيئة الزكاة والضريبة والجمارك).',
    'ربط المرحلة الثانية مع منصة فاتورة مفعّل.',
    'ربط المرحلة الثانية مع منصة فاتورة مُفعَّل.',
    'We support Phase 2 integration with ZATCA’s Fatoora platform.',
    'Phase 2 integration with the Fatoora platform is enabled.',
    'Nous prenons en charge l’intégration phase 2 avec la plateforme Fatoora (ZATCA).',
    'Fatoora platformu ile 2. Aşama entegrasyonunu destekliyoruz.',
    '支持与 Fatoora 平台（ZATCA）的第二阶段对接。',
    'Phase 2 integration enabled. Nothing else.',
    'We support Phase 2 integration with Fatoora; requirements may vary by business size.',
  ]) expectHits(t, []);
});

test('النفي الصادق للاعتماد والنص التعليمي لا يُحجبان', () => {
  for (const t of [
    'وهيئة الزكاة والضريبة والجمارك لا تعتمد ولا تصادق مزوّدي البرمجيات، فلا ندّعي اعتماداً منها.',
    'ZATCA does not certify software vendors, so we claim no certification from it.',
    'لسنا معتمدين من الهيئة، فالهيئة لا تعتمد المزودين.',
    'المرحلة الثانية (الربط والتكامل): ربط أنظمة الفوترة مباشرةً بمنصّة «فاتورة» التابعة للهيئة، مع توقيع تشفيري، وتُطبَّق على دفعات حسب حجم المنشأة.',
    'من بين 123 مورّداً في المسح، لا يعلن اكتمال الربط بـ«المرحلة الثانية (الربط والتكامل)» سوى 7 مورّدين.',
    'ZATCA e-invoicing (Fatoora) is mandatory in two phases.',
    'رمز QR متطلب أساسي في المرحلة الأولى من فوترة ZATCA.',
    'المرحلة 2 (أسبوع): سيارة الإثبات.',
  ]) expectHits(t, []);
});

test('لا إنذار كاذب على الأرقام العادية قرب الادّعاء: 15% و58مم و299 ر.س و«View-only»', () => {
  for (const t of [
    'كل فاتورة تحمل ضريبة 15% ونطبعها على 58مم، وندعم ربط المرحلة الثانية مع منصة فاتورة. من 299 ر.س شهرياً.',
    'فاتورة ضريبية مبسطة برمز QR وندعم ربط المرحلة الثانية مع منصة فاتورة وطباعة حرارية 58مم',
    'Tax invoice from the field Not included Simplified invoice with QR, Phase 1 (Generation) Offline day of work View-only at best',
  ]) expectHits(t, []);
});

test('يحجب ادّعاء الاعتماد أو المصادقة أو الترخيص أو الشراكة الرسمية مع الهيئة — ولو بعد التفعيل', () => {
  for (const t of [
    'نظام معتمد من هيئة الزكاة والضريبة والجمارك.',
    'نظام مُعتمَد من الهيئة لربط المرحلة الثانية.',
    'نظامنا مصادق من الهيئة.',
    'منصة مُصادَقة من ZATCA',
    'مرخّص من ZATCA',
    'شريك رسمي لهيئة الزكاة.',
    'شريك رسمي للهيئة.',
    'معتمدة · ZATCA',
    'ZATCA-approved e-invoicing',
    'Certified by ZATCA for Phase 2',
    'Solution certifiée par la ZATCA',
    'ZATCA onaylı e-fatura',
    // نفيٌ بعيد لا يُعفي ادّعاءً صريحاً (ثغرة نافذة ±220 القديمة)
    'الهيئة لا تعتمد المزودين، لكن نظامنا معتمد من الهيئة.',
  ]) assert.ok(checkText(t).includes(APPROVED), `مرّ ادّعاء اعتماد: «${t}»`);
});

test('يحجب أي موعد أو رقم مقرون بالمرحلة الثانية', () => {
  for (const t of [
    'ندعم ربط المرحلة الثانية منذ سبتمبر 2026.',
    'ربط المرحلة الثانية مفعّل قبل موعد الموجة 25.',
    'Phase 2 integration enabled for 16 companies.',
    'ندعم المرحلة الثانية لأكثر من ١٠٠ شركة',
    'We support Phase 2 integration since January.',
    '2. Aşama entegrasyonu 2027 itibaren destekleniyor',
  ]) assert.deepEqual(checkText(t), [DATED], `«${t}»`);
});

test('يكشف النفي القديم للمرحلة الثانية و«الأولى فقط» بلغاته الخمس', () => {
  for (const t of [
    'المرحلة الثانية (الربط والتكامل) غير مبنية لدينا حتى الآن.',
    'We support phase one of e-invoicing (TLV QR) only; phase two is not built.',
    'Phase 2 (Integration) of ZATCA e-invoicing is not built yet — we say that plainly.',
    'La Phase 2 (intégration) n’est pas encore disponible.',
    'Nous prenons en charge la phase un de la facturation électronique (QR TLV) uniquement.',
    '2. Aşama (entegrasyon) henüz hazır değildir.',
    '第二阶段（对接阶段）尚未上线。',
    'ندعم الفاتورة الإلكترونية المرحلة الأولى رمز QR بترميز TLV فقط',
  ]) assert.deepEqual(checkText(t), [STALE], `«${t}»`);
});

test('قاعدة النفي القديم تحذير غير حاجب حتى يُحرَّر CMS، وقاعدتا الاعتماد والموعد حاجبتان', () => {
  const byId = (id: string) => RULES.find((r) => r.id === id);
  assert.equal(byId(STALE)?.severity, 'warn');
  assert.equal(byId(APPROVED)?.severity, undefined, 'قاعدة الاعتماد يجب أن تبقى حاجبة');
  assert.equal(byId(DATED)?.severity, undefined, 'قاعدة الموعد يجب أن تبقى حاجبة');
  assert.equal(byId('zatca-phase2-claim'), undefined, 'القاعدة القديمة تحجب صيغة الدعم المعتمدة');
});

test('تُفحص كل المطابقات: نفيٌ يُعفي الذكر الأول لا يُعفي ادّعاءً لاحقاً في الصفحة نفسها', () => {
  const rule = RULES.find((r) => r.id === APPROVED)!;
  const page = 'لسنا معتمدين من الهيئة. ' + 'نص محايد '.repeat(30) + 'لكن نظامنا معتمد من الهيئة.';
  const v = findViolation(rule, page);
  assert.ok(v, 'مرّ ادّعاء لاحق بعد ذكر أول مُعفى');
  assert.ok(v.index > 30, 'أُدين الذكر المنفي الأول بدل الادّعاء اللاحق');
});

test('التطبيع يحذف التشكيل والتطويل', () => {
  assert.equal(norm('مُفعَّل ومُعتمَد وجاهز لـ'), 'مفعل ومعتمد وجاهز ل');
});

test('النصوص المعدّلة في الموقع تمرّ من الحارس ولا تحمل نفياً قديماً', () => {
  for (const t of [
    'يُصدر النظام فاتورة ضريبية برمز QR، وندعم ربط المرحلة الثانية مع منصة فاتورة التابعة لهيئة الزكاة والضريبة والجمارك. والهيئة لا تعتمد مزوّدي البرمجيات، فلا ندّعي اعتماداً منها.',
    'يصدر النظام فاتورة ضريبية برمز QR وندعم ربط المرحلة الثانية مع منصة فاتورة التابعة لهيئة الزكاة والضريبة والجمارك والهيئة لا تعتمد مزودي البرمجيات فلا ندعي اعتمادا منها',
    'The system issues tax invoices with a QR code and supports Phase 2 integration with ZATCA’s Fatoora platform. ZATCA does not certify software vendors, so we claim no certification from it.',
    'Le système émet des factures fiscales avec code QR et prend en charge l’intégration de la phase 2 avec la plateforme Fatoora de la ZATCA. La ZATCA ne certifie pas les éditeurs de logiciels. Les paramètres de taxe s’adaptent au pays de l’entreprise.',
    'Sistem QR kodlu vergi faturaları düzenler ve ZATCA’nın Fatoora platformuyla 2. Aşama entegrasyonunu destekler. ZATCA yazılım sağlayıcılarına sertifika vermez. Vergi ayarları şirketin ülkesine göre uyarlanır.',
    '系统开具带二维码的增值税发票，并支持与 ZATCA Fatoora 平台的第二阶段对接。ZATCA 不向软件厂商发放认证。税务设置会按企业所在国家进行适配。',
    'ندعم الفاتورة الإلكترونية برمز QR وندعم **ربط المرحلة الثانية** مع منصة فاتورة التابعة لهيئة الزكاة والضريبة والجمارك والهيئة لا تعتمد ولا تصادق مزودي البرمجيات فلا ندعي اعتمادا منها وليست لدينا شهادات SOC2 أو ISO',
    'We support **Phase 2 integration** with the Fatoora platform of ZATCA ZATCA does not certify or approve software vendors so we claim no approval from it We hold no SOC2 or ISO certification',
    'Nous prenons en charge **l intégration phase 2** avec la plateforme Fatoora de la ZATCA La ZATCA ne certifie aucun éditeur nous ne revendiquons donc aucune homologation',
    'ما نملكه وما لا نملكه — بصراحة ندعم الفاتورة الإلكترونية برمز QR، وندعم ربط المرحلة الثانية مع منصة فاتورة التابعة لهيئة الزكاة والضريبة والجمارك. والهيئة لا تعتمد ولا تصادق مزوّدي البرمجيات فلا ندّعي اعتماداً منها، وليست لدينا شهادات SOC2 أو ISO. فوق ٢٠ مندوبًا نحدّد السعر بالمحادثة 299 ر.س 599 ر.س حتى 5 مناديب',
    'What we have and do not have — plainly We support Phase 2 integration with ZATCA’s Fatoora platform. ZATCA does not certify software vendors, so we claim no approval. We hold no SOC2 or ISO certification.',
    'هل النظام يصدر فواتير ضريبية متوافقة؟ نعم، يُصدر فاتورة ضريبية منظّمة برمز QR وطباعة حرارية، وندعم ربط المرحلة الثانية مع منصة فاتورة في السعودية، والنظام قابل للتكيّف مع متطلبات الدول العربية الأخرى.',
    'رمز QR يخدم الفاتورة الضريبية المبسّطة. وندعم ربط المرحلة الثانية مع منصة فاتورة التابعة لهيئة الزكاة والضريبة والجمارك. والهيئة لا تعتمد ولا تصادق مزوّدي البرمجيات، فلا ندّعي اعتماداً منها.',
    'Core features: field tax invoicing (ZATCA-compliant QR in Saudi Arabia, with Phase 2 integration with ZATCA’s Fatoora platform supported), returns/credit notes, payment collection & receivables',
    'Is it tax-compliant? It issues structured tax invoices with a QR code and supports Phase 2 integration with ZATCA’s Fatoora platform in Saudi Arabia, and adapts to other Arab markets’ requirements. ZATCA does not certify software vendors.',
    'متوافقة · ZATCA',
  ]) expectHits(t, []);
});
