/**
 * حرّاس نصّية على المصدر — فوترة ZATCA المرحلة الثانية (Z5.6b، نقد الخطة 6).
 *
 * لماذا نصّية: العطب الذي تحرسه **ينجح** في زمن التنفيذ بلا استثناء يُرمى. حزمةٌ تبني رمز المرحلة الأولى بخمس وسوم
 * من إعدادات الشركة وتطبعه فوق عنوان «فاتورة ضريبية» تُنتج ورقةً سليمة المظهر تخرج بيد العميل — وأسوأ منها ورقةُ فاتورة
 * قياسية لم تعتمدها الهيئة. والقوالب تعتمد `qrcode` و`html2canvas` و`jspdf` فلا تُرسَم هنا؛ فالحارس يثبت أنّ **موضع
 * الشرط** في المصدر لم يختفِ ولم يُلتفّ عليه.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZATCA_ACTION_LABELS, ZATCA_CHIP_HINTS, ZATCA_CHIP_LABELS } from './docStatus';
import { ZATCA_PRINT_PHRASES } from './docPrint';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

/** كل ملفات المصدر (بلا الاختبارات) — لمسح المستدعين. */
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts') ? [full] : [];
  });
}

test('بناء رمز المرحلة الأولى محصورٌ في ملفات معروفة — أيّ مستدعٍ جديد يلزمه حارس', () => {
  const callers = walk(SRC)
    .filter(f => /\bbuildZatcaQr\s*\(/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(SRC, f).replace(/\\/g, '/'))
    .sort();
  assert.deepEqual(callers, [
    // مولّد الفاتورة المجاني: أداة تسويقية في المتصفح بلا خادم ولا صفوف فواتير — خارج المرحلة الثانية كلّها
    'pages/InvoiceGeneratorPage.tsx',
    'rep/RepDocuments.tsx',
    'rep/thermal.ts',
    'rep/zatca.ts', // التعريف نفسه
  ], 'مستدعٍ جديد لـbuildZatcaQr بلا حارس مرحلةٍ ثانية');
});

test('قالب A4: الرمز المحليّ لا يُبنى إلا بقرارٍ مصدرُه phase1، وفرع المرحلة الثانية يسبقه', () => {
  const s = read('rep/RepDocuments.tsx');
  // القرار يُتّخذ قبل العنوان والرمز
  assert.match(s, /const zDecision = zatcaPrintDecision\(/, 'القالب لا يستدعي قرار الطباعة');
  assert.match(s, /const docTitle = tr\(zDecision\.title\)/, 'العنوان لا يأتي من القرار');
  // الشرط حرفياً على سطر البناء
  assert.match(
    s,
    /const qrValue = zDecision\.qr\.source === 'phase1' && doc\.company\?\.taxNumber\s*\n\s*\? buildZatcaQr\(/,
    'buildZatcaQr غير محروس بمصدر الرمز',
  );
  // فرع المرحلة الثانية يسبق فرعي المزوّد الحكومي والرمز المحليّ في كتلة الرمز
  const block = s.indexOf('const gov = !!einv?.provider');
  const p2 = s.indexOf('if (doc.zatca) {', block);
  const govBranch = s.indexOf('if (gov && einv?.uuid)', block);
  const local = s.indexOf('if (qrValue) {', block);
  assert.ok(p2 > block && p2 < govBranch && p2 < local, 'فرع المرحلة الثانية لا يسبق فرعي الرمز الآخرين');
  // ولا تفصيل ضريبة على ورقةٍ غير ضريبية — ولا عنوانَ عمودٍ يقول إنّ السعر شامل ضريبة القيمة المضافة
  assert.match(s, /\{zDecision\.showTaxBreakdown && doc\.tax > 0 && <Row label=\{tr\('الوعاء الخاضع للضريبة'\)/);
  assert.match(s, /\{zDecision\.showTaxBreakdown && <th style=\{th\}>\{tr\('الضريبة'\)\}<\/th>\}/);
  assert.match(s, /\{zDecision\.showTaxBreakdown && inclusiveDoc \? tr\('السعر شامل الضريبة'\) : tr\('السعر'\)\}/);
  // وتصنيف الورقة (سعر الوحدة قبل الضريبة) من القرار لا من رقم المشتري الضريبي
  assert.match(s, /inclusiveDoc && zDecision\.standardLayout && it\.taxPct > 0/);
  assert.doesNotMatch(s, /&& !isSimplified &&/, 'القالب يعود إلى تخمين المبسّطة/القياسية بدل تصنيف الخادم');
});

test('الرمز المختوم على ورقة A4: مقاسٌ وتصحيحٌ يحتملان حمولة المرحلة الثانية، وبلا ضغطٍ فاقد في الـPDF', () => {
  const s = read('rep/RepDocuments.tsx');
  // الافتراضيّ (١٢٤px من مصدر ٣٧٢px بتصحيح M) هو ما حُكم في thermal.ts بأنّ الماسح لا يقرؤه لهذه الحمولة
  assert.match(s, /<QrImage value=\{zDecision\.qr\.value\} size=\{176\} ec="L" scale=\{4\} \/>/, 'الرمز المختوم بمقاس المرحلة الأولى');
  assert.match(s, /QRCode\.toDataURL\(value, \{ width: size \* scale, margin: 1, errorCorrectionLevel: ec \}\)/);
  // ورمز المرحلة الأولى بلا وسيطين ⇒ الافتراضيّ كما اليوم حرفاً بحرف
  assert.match(s, /<QrImage value=\{qrValue\} size=\{108\} \/>/);
  // والورقة الحاملة للرمز المختوم لا تمرّ على JPEG
  assert.match(s, /elementToPdfBlob\(printRef\.current, \{ lossless: zDecision\?\.qr\.source === 'stamped' \}\)/);
  // في `elementToPdfBlob` وحدها (لا في بانية التقارير متعدّدة العناصر — ورقةٌ بلا رمزٍ مختوم)
  const single = between(read('rep/pdf.ts'), 'export async function elementToPdfBlob', 'export function safeScale', 'rep/pdf.ts');
  assert.match(single, /opts\?\.lossless \? canvas\.toDataURL\('image\/png'\) : canvas\.toDataURL\('image\/jpeg', 0\.95\)/);
  assert.doesNotMatch(single, /addImage\(imgData, 'JPEG'/, 'صيغةٌ ثابتة في addImage تُخالف الصيغة المُلتقَطة');
});

test('الطباعة الحرارية: القرار نفسه، ورمز المرحلة الأولى خلف مصدره', () => {
  const s = read('rep/thermal.ts');
  assert.match(s, /const d = zatcaPrintDecision\(/, 'الشريط الحراريّ لا يستدعي قرار الطباعة');
  assert.match(
    s,
    /const qr = d\.qr\.source === 'stamped' && d\.qr\.value \? await stampedQrBlock\(d\.qr\.value\)\s*\n\s*: d\.qr\.source === 'phase1' \? await qrBlock\(/,
    'qrBlock (رمز المرحلة الأولى) يُستدعى بلا حارس مصدر',
  );
  assert.match(s, /const title = d\.title;/, 'عنوان الشريط لا يأتي من القرار');
  assert.match(s, /\$\{d\.showTaxBreakdown \? `<div class="row"><span>ض\.ق\.م/, 'سطر الضريبة يُطبع على سند التسليم');
  // الرمز المختوم أكبر: حمولته نحو ٧٠٠ محرف
  assert.match(s, /QRCode\.toDataURL\(value, \{ width: 420, margin: 0, errorCorrectionLevel: 'L' \}\)/);
});

/* المقطع بين مرساتين **دلاليّتين** لا بعدد محارف: نافذةٌ برقمٍ سحريّ امتلأت مرّةً إلى 2918/3000، فصار أيُّ سطرٍ
 * يُضاف قبلها يُفشل حارساً يدّعي عطباً أمنياً غير موجود — وهو ما يُدرّب القارئ على توسيع النافذة بلا قراءة. */
function between(s: string, from: string, to: string, file: string): string {
  const at = s.indexOf(from);
  assert.ok(at > 0, `المرساة «${from}» اختفت من ${file}`);
  const end = s.indexOf(to, at);
  assert.ok(end > at, `مرساة النهاية «${to}» اختفت من ${file}`);
  return s.slice(at, end);
}

test('كل بانية مستندِ فاتورةٍ من ردّ الخادم تمرّر عرض المرحلة الثانية', () => {
  for (const [file, from, to] of [
    // البانية المشتركة: المندوب واللوحة و/m — من ترويسة الدالّة إلى قوسها الختاميّ في العمود صفر
    ['rep/RepDocuments.tsx', 'export function invoiceDocFromDetail', '\n}'],
    // الطباعة فور الإصدار في تطبيق المندوب — من نداء الإصدار إلى مصيدة الخطأ
    ['rep/RepApp.tsx', "const res = await repApi.post('/invoices', payload);", '} catch (err'],
    // الطباعة فور الحفظ في لوحة الإدارة — من الطفرة إلى معالج خطئها
    ['components/forms/InvoiceModal.tsx', 'mutationFn: (data: unknown) => invoiceApi.create(data),', 'onError:'],
  ] as const) {
    const tail = between(read(file), from, to, file);
    assert.match(tail, /zatca: zatcaDocView\(inv\)/, `${file}: المستند يُبنى بلا عرض المرحلة الثانية فيُطبع رمز المرحلة الأولى`);
  }
});

test('شاشة النتيجة: مستندٌ لا ورقة له لا زرّ مشاركة له ولا طباعة حرارية', () => {
  const s = read('rep/RepDocuments.tsx');
  assert.match(s, /const zBlocked = zDecision !== null && !zDecision\.canPrint;/);
  assert.match(s, /const canThermal = \(doc\.kind === 'invoice' \|\| doc\.kind === 'receipt'\) && !zBlocked;/);
  assert.match(s, /\{zBlocked \? \(/, 'زرّ المشاركة غير محروس بحالة المستند');
  assert.match(s, /\{tr\(zDecision \? zDecision\.shareLabel : 'مشاركة \/ حفظ PDF'\)\}/, 'نصّ زرّ المشاركة لا يتبع القرار');
  assert.match(s, /\{zChip && \(/, 'شارة حالة المستند لا تُرسم في شاشة النتيجة');
  // ولا علامةَ نجاحٍ خضراء فوق «المستند مبطل لدى الهيئة»: اللون والأيقونة من حال المستند
  assert.match(s, /const zTone: 'void' \| 'wait' \| null =/);
  assert.match(s, /\{zTone \? <AlertTriangle size=\{20\} \/> : <Check size=\{20\} \/>\}/, 'أيقونة الصحّ ثابتة مهما كان حال المستند');
});

test('ورقةٌ بلا تفصيل ضريبة وأسعارها غير شاملة: عنوان الإجمالي يفسّر الفرق (A4 والحراريّ)', () => {
  assert.match(
    read('rep/RepDocuments.tsx'),
    /: !zDecision\.showTaxBreakdown && !inclusiveDoc && doc\.tax > 0 \? tr\('المبلغ المستحق شامل الضرائب'\)/,
    'سند التسليم يعرض مجموعاً لا يساوي الفرق بين سطريه بلا سطرٍ يفسّره',
  );
  const t = read('rep/thermal.ts');
  assert.match(t, /: !d\.showTaxBreakdown && !inclusiveDoc && doc\.tax > 0 \? 'المبلغ المستحق شامل الضرائب'/);
  assert.match(t, /const inclusiveDoc = doc\.pricesIncludeTax \?\? /, 'الشريط يستنتج الشمول بغير قاعدة قالب A4');
});

test('القوائم الثلاث تعرض الشارة، ولوحة الإدارة تحرس عمودها بنظام الشركة', () => {
  assert.match(read('rep/RepApp.tsx'), /const chip = zatcaStatusChip\(it\);/, 'قائمة المندوب بلا شارة');
  assert.match(read('m/MDocList.tsx'), /const zChip = kind === 'invoice' \? zatcaStatusChip\(d\) : null;/, 'قائمة /m بلا شارة');
  const page = read('pages/InvoicesPage.tsx');
  assert.match(page, /const phase2 = zatcaRegimeOf\(company\)\.phase === 2;/, 'عمود اللوحة بلا حارس نظام');
  assert.match(page, /\{phase2 && <th>\{tr\('الفوترة الإلكترونية'\)\}<\/th>\}/, 'ترويسة العمود مفقودة');
  // عدد الأعمدة يتبع الحارس وإلّا انزاح صفّ «لا توجد فواتير»
  assert.match(page, /colSpan=\{phase2 \? 13 : 12\}/);
  assert.ok(!/colSpan=\{12\}/.test(page), 'colSpan ثابت بقي مع عمودٍ مشروط');
  // الإجراءات لمستخدمي الشركة وحدهم وبشرط حالة الصفّ
  assert.match(page, /zatcaRowActions\(inv as unknown as Record<string, unknown>, \{ allowed: canZatcaAct \}\)/);
  assert.match(page, /const canZatcaAct = useAuthStore\(s => s\.isAdmin\)\(\);/);
});

test('تطبيق المندوب لا يُصدر مستنداً ضريبياً دون اتصال (D1‑i) — لا قبل الإرسال ولا بعد انقطاعه', () => {
  const s = read('rep/RepApp.tsx');
  const at = s.indexOf('const zatcaPhase2 = zatcaRegimeOf(company).phase === 2;');
  assert.ok(at > 0, 'فحص النظام غائب عن مسار الإصدار');
  const post = s.indexOf("const res = await repApi.post('/invoices', payload);");
  assert.ok(at < post, 'الفحص بعد الرفع — الفاتورة تكون قد أُرسلت');
  // ١) قبل الرفع: لا نداء أصلاً
  assert.match(s.slice(at, post), /if \(zatcaPhase2 && !navigator\.onLine\)/, 'لا حارس قبل الرفع');
  // ٢) بعد انقطاع الشبكة: لا صفّ صادر ولا ورقة برقم محليّ
  const netErr = s.indexOf('if (isNetworkError(err)) {', post);
  const outbox = s.indexOf("kind: 'invoice', payload", netErr);
  assert.ok(netErr > 0 && outbox > netErr);
  const branch = s.slice(netErr, outbox);
  assert.match(branch, /if \(zatcaPhase2\) \{/, 'الفاتورة تُلتقط في الصفّ الصادر رغم المرحلة الثانية');
  assert.ok(branch.indexOf('if (zatcaPhase2) {') < branch.indexOf('outboxAdd'), 'الحارس بعد الالتقاط لا قبله');
});

test('كل نصّ يُنتجه القراران مترجمٌ في القاموس باللغات الأربع', () => {
  const dict = read('i18n/strings.ts');
  const phrases = [...ZATCA_CHIP_LABELS, ...ZATCA_CHIP_HINTS, ...ZATCA_PRINT_PHRASES, ...Object.values(ZATCA_ACTION_LABELS)];
  for (const p of new Set(phrases)) {
    const at = dict.indexOf(`\n  '${p}': {`);
    assert.ok(at > 0, `نصّ غير مترجم في القاموس: ${p}`);
    const entry = dict.slice(at + 1, dict.indexOf('\n', at + 1));
    for (const lang of ['en', 'fr', 'tr', 'zh']) {
      assert.match(entry, new RegExp(`\\b${lang}: '`), `${p} بلا ${lang}`);
    }
  }
});
