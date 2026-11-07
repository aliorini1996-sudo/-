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
import { QR_DOTS_PER_CELL, defaultPrintOptions, printSettingsV1Schema } from '../print/printSettings';

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
  // «نصوص المطبوعات»: صياغة الشركة للعنوان وحذفه يسريان على المرحلتين (قرار المالك ٣ نوفمبر ٢٠٢٦ «طبّقها تلقائياً») — والرمز المختوم يُطبع كما هو
  assert.match(s, /const docTitle = pt\.title\(zDecision\.title, \{ isReturn: !!doc\.isReturn, phase2: !!doc\.zatca \}\)/, 'العنوان لا يأتي من القرار');
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
  // ولا تفصيل ضريبة على ورقةٍ غير ضريبية — ولا عنوانَ عمودٍ يقول إنّ السعر شامل ضريبة القيمة المضافة.
  // تحديثٌ مقصود (طلب المالك الثالث ٣ نوفمبر ٢٠٢٦ «حذف السطر»): صفّ الوعاء يحذفه حذفُ الشركة له وحده — وشرط القرار يبقى أوّلاً
  assert.match(s, /\{zDecision\.showTaxBreakdown && doc\.tax > 0 && !pt\.hidden\('tot\.taxable'\) && <Row label=\{L\('tot\.taxable', 'الوعاء الخاضع للضريبة'\)/);
  // «التحرير الحرّ»: نمط رأس العمود صار thf(f) (حجم خطّ القسم — IDENT بلا تخطيطٍ حرّ = نمط اليوم، وخطوط الأساس تثبته) — والشرط هو هو
  assert.match(s, /\{zDecision\.showTaxBreakdown && !pt\.hidden\('col\.tax'\) && <th style=\{thf\(f\)\}>\{L\('col\.tax', 'الضريبة', \{ stack: true \}\)\}<\/th>\}/);
  assert.match(s, /const thf = \(f: Fx\): React\.CSSProperties => \(\{ \.\.\.th, fontSize: f\(13\) \}\);/);
  assert.match(s, /\{zDecision\.showTaxBreakdown && inclusiveDoc \? L\('col\.priceIncl', 'السعر شامل الضريبة', \{ stack: true \}\) : L\('col\.price', 'السعر', \{ stack: true \}\)\}/);
  // وتصنيف الورقة (سعر الوحدة قبل الضريبة) من القرار لا من رقم المشتري الضريبي
  assert.match(s, /inclusiveDoc && zDecision\.standardLayout && it\.taxPct > 0/);
  assert.doesNotMatch(s, /&& !isSimplified &&/, 'القالب يعود إلى تخمين المبسّطة/القياسية بدل تصنيف الخادم');
});

test('الرمز المختوم على ورقة A4: مقاسٌ وتصحيحٌ يحتملان حمولة المرحلة الثانية، وبلا ضغطٍ فاقد في الـPDF', () => {
  const s = read('rep/RepDocuments.tsx');
  // الافتراضيّ (١٢٤px من مصدر ٣٧٢px بتصحيح M) هو ما حُكم في thermal.ts بأنّ الماسح لا يقرؤه لهذه الحمولة
  /* «التحرير الحرّ»: مربع QR في لوحة المصمّم يكبّر الصورة ولا يصغّرها أبداً — imgPx(today) = today بلا مربع (أو على النقطية
   * التي تعيد رسمه في خانتها)، وإلا max(today, ضلع المربع − الإطار) */
  assert.match(s, /const imgPx = \(today: number\): number => \(fit && !look\.qrSlotPx \? Math\.max\(today, side - 14\) : today\);/, 'مقاس الرمز في اللوحة قد يصغر عن اليوم');
  assert.match(s, /<QrImage value=\{zDecision\.qr\.value\} size=\{imgPx\(176\)\} ec="L" scale=\{4\} \/>/, 'الرمز المختوم بمقاس المرحلة الأولى');
  assert.match(s, /QRCode\.toDataURL\(value, \{ width: size \* scale, margin: 1, errorCorrectionLevel: ec \}\)/);
  // ورمز المرحلة الأولى بلا وسيطين ⇒ الافتراضيّ كما اليوم حرفاً بحرف
  assert.match(s, /<QrImage value=\{qrValue\} size=\{imgPx\(108\)\} \/>/);
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
    // الطباعة فور الحفظ في لوحة الإدارة — من الطفرة إلى معالج خطئها (المرتجع يحمل مرجع محاولته D8، فالمرساة رأس الطفرة)
    ['components/forms/InvoiceModal.tsx', 'const mutation = useMutation({', 'onError:'],
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
    /: !zDecision\.showTaxBreakdown && !inclusiveDoc && doc\.tax > 0 \? V\('المبلغ المستحق شامل الضرائب'\)/,
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
  // عدد الأعمدة يتبع الحارس وإلّا انزاح صفّ «لا توجد فواتير» — ومعه عمود «الموقع» المشروط («لوكيشن»)
  // ومعه عمود «حذف المحدد» لمالك المنصة وحده (OwnerBulkPurge) — أول عمود حين يظهر
  assert.match(page, /const tableCols = \(phase2 \? 13 : 12\) \+ \(locOn \? 1 : 0\)( \+ \(purge\.enabled \? 1 : 0\))?;/);
  assert.equal((page.match(/colSpan=\{tableCols\}/g) || []).length, 2, 'صفّا التحميل والفراغ يتبعان عدد الأعمدة');
  assert.ok(!/colSpan=\{1[23]\}/.test(page), 'colSpan ثابت بقي مع عمودٍ مشروط');
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

/* ═══ «إعدادات الطباعة» (التصميم §4، امتدادٌ مقصود — قائمة مستدعي buildZatcaQr أعلاه لم تتغيّر) ═══
 * الشركة تختار الطابعة والورق والتصميم، ولا تختار ما تطبعه الهيئة: العنوان والرمز والضريبة والتنبيه من القرار وحده، وكل
 * زرّ طباعةٍ جديد محروسٌ بحال المستند كزرّ المشاركة. */

test('(a) كل زرّ طباعةٍ جديد محروسٌ بحال المستند — مُبطلٌ أو معلَّق لا ورقة له من أيّ قالب', () => {
  const s = read('rep/RepDocuments.tsx');
  assert.match(s, /const canDirect = directProfile !== null && !zBlocked && \(directProfile\.printer !== 'thermal' \|\| canThermal\);/);
  // زرٌّ واحد للطباعة المباشرة، داخل كتلة canDirect وقبل كتلة المشاركة
  const block = s.indexOf('{canDirect && directProfile && (');
  assert.ok(block > 0, 'زرّ الطباعة خارج كتلة canDirect');
  const clicks = [...s.matchAll(/onClick=\{printDirect\}/g)].map((m) => m.index as number);
  assert.equal(clicks.length, 1, 'زرّ طباعةٍ ثانٍ');
  assert.ok(clicks[0] > block && clicks[0] < s.indexOf('{zBlocked ? (', block));
  // والمعالج يعيد الفحص (دفاعٌ ثانٍ) — ودوالّ الطباعة لا تُنادى من غيره في الشاشة
  assert.match(s, /const printDirect = async \(\) => \{\n\s*if \(!canDirect \|\| !directProfile\) return;/);
  const handler = between(s, 'const printDirect = async', 'const isReturnDoc', 'rep/RepDocuments.tsx');
  for (const fn of ['printThermalInvoice(', 'printThermalReceipt(', 'printPageNode(']) {
    assert.equal(s.split(fn).length - 1, handler.split(fn).length - 1, `${fn} يُنادى خارج printDirect`);
  }
  // بلا إعدادات مخصّصة: اختيار الجهاز لا يُقرأ، والزرّ بنصّ اليوم
  assert.match(s, /const directProfile = profileFor\(settings, printKind, customized \? deviceChoice : null\);/);
  assert.match(s, /\{legacyDirect \? tr\('طباعة حرارية 58 مم'\) : /);
  // والقالبان الحراريان الجديدان يرفضان مستنداً لا ورقة له حتى لو استُدعيا مباشرةً
  assert.match(read('rep/thermal.ts'), /if \(!d\.canPrint\) throw new PrintRefusedError\(/);
});

test('القالبان الحراريان الجديدان من القرار نفسه — لا عنوان ولا رمز ولا ضريبة من صنعهما', () => {
  const t = read('rep/thermal.ts');
  assert.equal((t.match(/zatcaPrintDecision\(/g) || []).length, 1, 'قرارٌ ثانٍ في الشريط');
  const body = between(t, 'function rollInvoiceBody', 'function rollReceiptBody', 'rep/thermal.ts');
  // «نصوص المطبوعات»: العنوان من القرار عبر المحلِّل (يتجاهل صياغة الشركة للمختوم)، وسطرا الضريبة بعبارتهما الثابتة (fixed)
  assert.match(body, /const tt = r\.pt\.title\(title, \{ isReturn: !!doc\.isReturn, phase2: !!doc\.zatca \}\);/, 'العنوان لا يأتي من القرار');
  assert.match(body, /<div class="c b">\$\{titleHtml\}<\/div>/);
  assert.match(body, /: !d\.showTaxBreakdown && !inclusiveDoc && doc\.tax > 0 \? val\(r, 'المبلغ المستحق شامل الضرائب'\)/);
  assert.match(body, /\$\{d\.showTaxBreakdown \? `<div class="row"><span>\$\{inclusiveDoc\s*\? lbl\(r, 'tot\.vatIncl', 'منها ضريبة القيمة المضافة'/, 'سطر الضريبة غير محروس');
  assert.match(body, /\$\{d\.showTaxBreakdown \? `<div class="row"><span>\$\{lbl\(r, 'tot\.taxable', 'المجموع قبل الضريبة'\)\}/);
  assert.match(body, /inclusiveDoc && d\.standardLayout && it\.taxPct > 0/, 'سعر الوحدة قبل الضريبة بتخمينٍ لا بالقرار');
  /* أختام الحالة (قرار المالك ٤ نوفمبر ٢٠٢٦): من القرار وحده، وتسقط بقرار الشركة الصريح وحده (areStampsRemoved) — لا شرط آخر */
  assert.match(body, /const marks = !areStampsRemoved\(r\.layout\);\n\s*const watermark = marks \? d\.watermark : null;\n\s*const notice = marks \? d\.notice : null;/);
  assert.equal((body.match(/\$\{watermark \? /g) || []).length, 2, 'وسم البروفة: في الرأس وفي keep');
  assert.equal((body.match(/\$\{notice \? /g) || []).length, 2, 'الإشعار: في الرأس وفي keep');
  assert.doesNotMatch(body, /\$\{d\.(watermark|notice) \? /, 'ختمٌ يتجاوز خيار الشركة');
  assert.doesNotMatch(body, /buildZatcaQr|QRCode\.|qrBlock\(|isSimplified/);
  // الرمز الوحيد: ما بنته printThermalInvoice من القرار، ومقاسه من خلاياه الفعلية — بلا صورةٍ ثانية
  const rq = between(t, 'function rollQr', 'function rollHead', 'rep/thermal.ts');
  assert.match(rq, /QRCode\.create\(d\.qr\.value, \{ errorCorrectionLevel: 'L' \}\)/);
  assert.match(rq, /if \(!plan \|\| !plan\.fits\) throw new PrintRefusedError\(PRINT_WARNINGS\.qrNoFit\)/);
  // لا رمز (حذفته الشركة صراحةً فلم يُبنَ — qrOff) ⇒ لا قياس ولا رفض: أول سطر في rollQr
  assert.match(rq, /\{\n\s*if \(!qr \|\| d\.qr\.source !== 'stamped' \|\| !d\.qr\.value\) return qr;/);
  assert.doesNotMatch(rq, /toDataURL|buildZatcaQr/);
});

test('مظهر الطباعة لا يُخفي محتوىً إلزامياً: الاسم والرقم الضريبي والسجل والعنوان في كل ترويسة', () => {
  const s = read('rep/RepDocuments.tsx');
  const header = between(s, 'export function Header', 'function InfoBox', 'rep/RepDocuments.tsx');
  /* تحديثٌ مقصود (طلب المالك الثالث ٣ نوفمبر ٢٠٢٦): كل نصٍّ يُحذف — فالرقم الضريبي والسجل (والعنوان) يحذفها **حذفُ الشركة لسطرها
   * وحده** (pt.hidden، والمحرّر يحذّر ويطلب التأكيد). ويبقى المحروس: لا خيار مظهرٍ أو تخطيطٍ (look/layout) يخفيها، والاسم والعنوان
   * في الأشكال الثلاثة، ولا شكلٌ رابع. */
  assert.match(header, /\n\s*\{!pt\.hidden\('h\.taxNumber'\) && line\(L\('h\.taxNumber', 'الرقم الضريبي'\), company\?\.taxNumber, light\)\}/, 'الرقم الضريبي صار خياراً');
  assert.match(header, /\n\s*\{!pt\.hidden\('h\.commercialReg'\) && line\(L\('h\.commercialReg', 'السجل التجاري'\), company\?\.commercialReg, light\)\}/);
  assert.doesNotMatch(header, /(look|layout|lb)\.\w+ && !pt\.hidden\('h\.(taxNumber|commercialReg)'\)/, 'خيار مظهر يخفي نصّاً إلزامياً');
  assert.doesNotMatch(header, /(look|layout|lb)\.\w+ && line\(L\('h\.(taxNumber|commercialReg)'/);
  /* «التحرير الحرّ»: الأشكال الثلاثة + كتلة الشركة وحدها (مربع «الشركة» في لوحة المصمّم، free.part) — وهي الاسم بأسطره الإلزامية
   * نفسها (infoLines) لا شكلٌ رابع. وقطع الاسم من الترويسة (omitCompany) لا يكون إلا لأنّ مربع الشركة موضوعٌ في لوحة */
  assert.equal((header.match(/\{company\?\.name \|\| tr\('اسم الشركة'\)\}/g) || []).length, 4, 'اسم الشركة في الأشكال الثلاثة وكتلة الشركة');
  const companyPart = between(header, "if (free?.part === 'company') {", '// شكل "بانر"', 'rep/RepDocuments.tsx');
  assert.match(companyPart, /\{company\?\.name \|\| tr\('اسم الشركة'\)\}\{nameAlt\}<\/div>\n\s*\{infoLines\(false\)\}/, 'كتلة الشركة بلا رقمها الضريبي');
  assert.match(header, /const noCompany = !!free\?\.omitCompany;/);
  const a4 = read('rep/RepDocuments.tsx');
  for (const call of a4.match(/omitCompany: [^,}]+/g) || []) assert.equal(call.trim(), "omitCompany: placed.has('company')", 'الشركة تُقطع من الترويسة بلا مربعٍ في لوحة');
  for (const call of a4.match(/omitTitle: [^,}]+/g) || []) assert.equal(call.trim(), "omitTitle: placed.has('title')", 'العنوان يُقطع من الترويسة بلا مربعٍ في لوحة');
  assert.equal((header.match(/>\{title\}</g) || []).length, 3, 'العنوان في الأشكال الثلاثة');
  assert.equal((header.match(/if \(style === /g) || []).length, 2, 'شكل ترويسة رابع');
  assert.doesNotMatch(header, /look\.\w+ && line\(tr\('الرقم الضريبي'\)/);
});

test('(c) لا خيار طباعة يخفي أو يصغّر محتوى ZATCA الإلزامي', () => {
  const FORBIDDEN = [
    'showQr', 'hideQr', 'qrHidden', 'qrSmall', 'hideTitle', 'showTitle', 'showTaxNumber', 'hideTaxNumber', 'showTaxBreakdown',
    'hideTaxBreakdown', 'showVat', 'hideNotice', 'showNotice', 'hideWatermark', 'showWatermark', 'showIcv', 'showUuid', 'hideTotal',
    'showSellerName', 'showBuyerTaxNumber',
  ];
  const keys = Object.keys(defaultPrintOptions('thermal'));
  // «تخطيط المطبوعات» (تحديثٌ مقصود): `layout` المفتاح الجديد الوحيد — اختياريّ لا يدخل الافتراضي (غيابه = ورقة اليوم)
  assert.ok(!keys.includes('layout'), 'الافتراضي يحمل تخطيطاً');
  assert.deepEqual([...keys, 'layout'].sort(), Object.keys(printSettingsV1Schema.shape.profiles.element.shape.options.shape).sort());
  for (const k of [...keys, 'layout']) {
    assert.ok(!FORBIDDEN.includes(k), `خيار محظور: ${k}`);
    assert.doesNotMatch(k, /qr(Hidden|Min|Off)|hide|title|tax|vat|notice|watermark|icv|uuid|seller|buyer/i, `خيار يمسّ محتوى إلزامياً: ${k}`);
  }
  assert.deepEqual(printSettingsV1Schema.shape.profiles.element.shape.options.shape.qrSize.options, ['auto', 'large'], 'لا «صغير»');
});

test('(d) الحد الأدنى لنقاط خلية الرمز لكل دقة لا ينزل — والتلقائي والكبير فوقه', () => {
  const FLOOR = { 203: 3, 300: 5, 180: 4 } as const;
  for (const dpi of [203, 300, 180] as const) {
    const t = QR_DOTS_PER_CELL[dpi];
    assert.ok(t.min >= FLOOR[dpi], `الحد الأدنى لـ${dpi} نزل`);
    assert.ok(t.min <= t.auto && t.auto <= t.large);
  }
  assert.ok(Object.isFrozen(QR_DOTS_PER_CELL) && Object.isFrozen(QR_DOTS_PER_CELL[180]));
});

/* ═══ M3: الطباعة المباشرة بالبلوتوث (التصميم §4 البندان 3 و8، والحارسان (b) و(e)) ═══
 * الرسم النقطيّ يعيد رسم الرمز بنقاطٍ صحيحة — فلا بدّ أن تكون القيمة التي يرسمها هي قيمة القرار نفسها، وأن يُرسم من مصفوفة
 * QRCode.create لا من صورةٍ تُعاد عيّنتها. وزرّ البديل (نظام الطباعة بعد تعذّر البلوتوث) محروسٌ كزرّ الطباعة. */

test('(a) البلوتوث وبديله محروسان بحال المستند كزرّ الطباعة — ودوالّ الرسم لا تُنادى خارج المعالج', () => {
  const s = read('rep/RepDocuments.tsx');
  assert.match(s, /const printWith = async \(via: PrintTransport\) => \{\n\s*if \(!canDirect \|\| !directProfile\) return;/);
  const handler = between(s, 'const printDirect = async', 'const isReturnDoc', 'rep/RepDocuments.tsx');
  for (const fn of ['printHtmlDirect(', 'printNodeDirect(', 'printerForJob(']) {
    assert.ok(handler.includes(fn), `${fn} غائبٌ عن المعالج`);
    assert.equal(s.split(fn).length - 1, handler.split(fn).length - 1, `${fn} يُنادى خارج printDirect/printWith`);
  }
  // زرّ البديل داخل كتلة canDirect وقبل كتلة المشاركة
  const block = s.indexOf('{canDirect && directProfile && (');
  const fallback = s.indexOf("onClick={() => printWith('system')}");
  assert.ok(fallback > block && fallback < s.indexOf('{zBlocked ? (', block), 'زرّ البديل خارج كتلة canDirect');
  assert.equal(s.split('printWith(').length - 1, 2, 'printWith: نداء الزرّ الأساسيّ وزرّ البديل وحدهما');
  // الشريط الكلاسيكي (أو لا إعدادات) بلوتوثه بقالب الجهاز (طلب المالك ٣١ أكتوبر ٢٠٢٦)، وغيره بلا إعدادات مخصّصة: نظام الطباعة دائماً
  // وطريقة قالب الجهاز rollVia مستقلةٌ عن transport قوالب الشركة (سندٌ كلاسيكي لا يرث بلوتوث فاتورةٍ نقطية)
  assert.match(s, /const directTransport: PrintTransport = deviceRoll \? transportFor\(deviceRoll, \{ transport: deviceChoice\?\.rollVia \}\) : customized \? transportFor\(directProfile, deviceChoice\) : 'system';/);
  // والبلوتوث وحده يأخذ قالب الجهاز — البديل (نظام الطباعة) يطبع الشريط الكلاسيكي كما كان
  assert.match(s, /const jobProfile = via === 'bt-serial' && deviceRoll \? deviceRoll : directProfile;/);
});

/** المصدر بلا تعليقات — الشرح يذكر الدوالّ المحظورة بأسمائها */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** كل ملفات المصدر التي تذكر data-qr-value (بلا الاختبارات) */
function qrValueFiles(): string[] {
  return walk(SRC)
    .filter((f) => fs.readFileSync(f, 'utf8').includes('data-qr-value'))
    .map((f) => path.relative(SRC, f).replace(/\\/g, '/'))
    .sort();
}

test('(b) كل خانة data-qr-value تأخذ قيمتها من القرار أو من رمز المرحلة الأولى المحروس — أو الرمز التجريبيّ في المعايرة', () => {
  assert.deepEqual(qrValueFiles(), [
    'lib/print/calibration.ts', // الرمز التجريبيّ وحده
    'lib/print/raster.ts', // يقرأ الخانة ولا يكتبها
    'rep/RepDocuments.tsx', // قالب A4 والنقطية
    'rep/printCanvas.tsx', // لوحة المصمّم: تذكرها في تعليقٍ فقط — تمرّر كتلة InvoiceQrBlock كما هي ولا تكتب خانة
    'rep/printLook.ts', // محدِّد CSS لصورة الخانة
    'rep/thermal.ts', // خانة الشريط في البلوتوث
  ], 'ملفٌّ جديد يكتب خانة رمز بلا حارس');
  const canvasSrc = stripComments(read('rep/printCanvas.tsx'));
  assert.doesNotMatch(canvasSrc, /data-qr-value|data-qr-ec|QRCode\.|buildZatcaQr\s*\(|zatcaPrintDecision\(/, 'لوحة المصمّم تكتب خانة رمز أو تبنيه');
  // قالب A4: خانتان، قيمتاهما zDecision.qr.value وqrValue لا غير
  const a4 = read('rep/RepDocuments.tsx');
  const exprs = [...a4.matchAll(/data-qr-value=\{([^}]*)\}/g)].map((m) => m[1]);
  assert.deepEqual(exprs, ['look.qrSlotPx ? zDecision.qr.value : undefined', 'look.qrSlotPx ? qrValue : undefined']);
  assert.equal((a4.match(/data-qr-value=/g) || []).length, 2);
  // الشريط: سطرٌ واحد في qrSlot، ونداءاها في qrBuilders بالقيمة المختومة كما وصلت وبحمولة المرحلة الأولى
  const t = read('rep/thermal.ts');
  assert.equal((t.match(/data-qr-value=/g) || []).length, 1);
  const slot = between(t, 'function qrSlot', 'type QrBuilders', 'rep/thermal.ts');
  assert.match(slot, /data-qr-value="\$\{esc\(value\)\}"/);
  const builders = between(t, 'function qrBuilders', 'async function stampedQrBlock', 'rep/thermal.ts');
  assert.equal(t.split('qrSlot(').length - 1, 3, 'qrSlot: التعريف ونداءان');
  assert.match(builders, /stampedQrBlock: async \(value\) => qrSlot\(value, 'L', p\)/);
  assert.match(builders, /payload = phase1Payload\(company, date, total, vat\)/);
  assert.match(builders, /return qrSlot\(payload, 'M', p\)/);
  // البانيان يُختاران مرّة قبل السطر المحروس نفسه — فالمختوم من القرار، والمرحلة الأولى خلف مصدرها
  const inv = between(t, 'export async function printThermalInvoice', 'const items = doc.items.map', 'rep/thermal.ts');
  /* قرار المالك ٤ نوفمبر ٢٠٢٦: البوابة الوحيدة qrOff = حذف الشركة الصريح (isQrRemoved على تخطيط القالب الجديد) ⇒ بانيان فارغان
   * (NO_QR) فلا صورة ولا خانة ولا qrNoFit — وإلا كاليوم؛ والسطر المحروس بعدها حرفاً */
  assert.match(inv, /const qrOff = !!roll && isQrRemoved\(roll\.layout\);\n\s*const \{ stampedQrBlock, qrBlock \} = qrOff \? NO_QR : qrBuilders\(roll\);\n\s*const qr = d\.qr\.source === 'stamped' && d\.qr\.value \? await stampedQrBlock\(d\.qr\.value\)/);
  assert.equal((t.match(/\bqrOff\b/g) || []).length, 2, 'qrOff: التعريف والاختيار وحدهما');
  assert.equal((stripComments(t).match(/isQrRemoved\(/g) || []).length, 1, 'قراءةٌ ثانية لحذف الرمز في الشريط');
  assert.match(t, /const NO_QR: QrBuilders = Object\.freeze\(\{ stampedQrBlock: async \(\) => '', qrBlock: async \(\) => '' \}\);/);
  assert.equal((t.match(/\bNO_QR\b/g) || []).length, 2, 'NO_QR: التعريف والاختيار');
  assert.equal(t.split('phase1Payload(').length - 1, 3, 'phase1Payload: التعريف وqrBlock وبانية الخانة');
  // المعايرة: الرمز التجريبيّ وحده
  const cal = read('lib/print/calibration.ts');
  assert.match(cal, /const dummy = dummyQrValue\(\);/);
  assert.equal((cal.match(/data-qr-value=/g) || []).length, 1);
  assert.match(cal, /data-qr-value="\$\{esc\(dummy\)\}"/);
  // الرسم يقرأ الخانة ولا يكتبها
  const r = read('lib/print/raster.ts');
  assert.ok(!/data-qr-value=/.test(r), 'raster.ts يكتب خانة');
  assert.ok(!/setAttribute\(\s*'data-qr-value'/.test(r));
});

test('(e) raster.ts لا يستدعي QRCode.toDataURL أبداً ولا يرسم رمزاً إلا من QRCode.create — ولا عتبة متكيّفة', () => {
  const r = read('lib/print/raster.ts');
  assert.ok(!/toDataURL|toCanvas|toString\(/.test(stripComments(r)), 'رمزٌ من صورة لا من مصفوفته');
  const calls = [...stripComments(r).matchAll(/QRCode\.(\w+)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 1 && calls.every((c) => c === 'create'), `QRCode.${calls.join(', ')}`);
  assert.match(r, /export const MONO_THRESHOLD = 160;/);
  // ولا مسار طباعةٍ جديد يبني رمزاً: المُرمِّزان والنقل والمنسّق بلا QRCode ولا buildZatcaQr
  for (const f of ['lib/print/escpos.ts', 'lib/print/escp24.ts', 'lib/print/transport/btSerial.ts', 'rep/printDirect.ts', 'components/print/PrintDeviceTools.tsx',
    'lib/print/transport/bridgeContract.ts', 'lib/print/transport/bridgePayload.ts', 'lib/print/transport/platform.ts',
    'lib/print/transport/appBridge.ts', 'lib/print/transport/direct.ts', 'components/print/DirectPrintUi.tsx', 'components/print/AppUpdatePrompt.tsx']) {
    assert.doesNotMatch(stripComments(read(f)), /QRCode\.|buildZatcaQr|toDataURL/, f);
  }
  // والطباعة التجريبية لا تمرّ بالمرحلة الأولى: مستندها مختومٌ بالرمز التجريبيّ في بيئة محاكاة
  const cal = read('lib/print/calibration.ts');
  assert.match(cal, /qr: dummyQrValue\(\), printable: true/);
  assert.match(cal, /mode: 'rehearsal'/);
});

test('لا رأس سياسة يحجب Web Serial (التصميم §3.1) — الطباعة المباشرة تحتاجه على أصل التطبيق', () => {
  const root = path.join(SRC, '..');
  for (const f of ['vercel.json', 'index.html']) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    assert.doesNotMatch(fs.readFileSync(p, 'utf8'), /serial=\(\)|serial 'none'/, `${f} يحجب Web Serial`);
  }
});

test('قوالب الرسم النقطيّ بلا تباعد حروف (التصميم §3.3 الخطوة 2): html2canvas يفصل حروف العربية المتصلة به', () => {
  for (const f of ['rep/RepDocuments.tsx', 'rep/thermal.ts', 'rep/thermalHtml.ts', 'rep/printLook.ts', 'rep/printPage.ts', 'lib/print/calibration.ts',
    'rep/printGrid.tsx', 'lib/print/layout.ts']) {
    assert.doesNotMatch(read(f), /letterSpacing|letter-spacing/i, `${f}: تباعد حروف في قالب طباعة`);
  }
});

test('فكّ القيد (طلب المالك ٣١ أكتوبر ٢٠٢٦): إشعار «صدرت مبسطة» لا يقرؤه أيّ قالب طباعة — شاشة النتيجة وحدها', () => {
  const s = read('rep/RepDocuments.tsx');
  const a4 = s.slice(s.indexOf('export const PrintableInvoice = forwardRef'), s.indexOf("PrintableInvoice.displayName = 'PrintableInvoice';"));
  assert.ok(a4.length > 1000, 'قالب A4 لم يُقتطع');
  assert.ok(!a4.includes('buyerNotice'), 'قالب A4 يقرأ buyerNotice');
  // شاشة النتيجة تقرؤه مرّة واحدة خارج المعاينة
  const result = s.slice(s.indexOf('export function DocumentResult('));
  assert.equal(result.split('doc.buyerNotice').length - 1, 2, 'الشرط والنصّ في شاشة النتيجة');
  const callers = walk(SRC)
    .filter(f => fs.readFileSync(f, 'utf8').includes('buyerNotice'))
    .map(f => path.relative(SRC, f).replace(/\\/g, '/'))
    .sort();
  // الحراري (thermal/thermalHtml) والطباعة المباشرة (lib/print) لا تذكره أبداً
  assert.deepEqual(callers, ['components/forms/InvoiceModal.tsx', 'lib/zatca/issueOutcome.ts', 'm/MInvoiceCreate.tsx', 'rep/RepApp.tsx', 'rep/RepDocuments.tsx']);
});

test('القالب ثنائي اللغة (تخطيط المطبوعات): القرار والعنوان والرمز من قالب A4 نفسه — والقالب الجديد لا يبني رمزاً ولا يكتب خانة', () => {
  const s = read('rep/RepDocuments.tsx');
  const a4 = between(s, 'export const PrintableInvoice = forwardRef', "PrintableInvoice.displayName = 'PrintableInvoice';", 'rep/RepDocuments.tsx');
  // فرع القالب الجديد بعد القرار والعنوان والرمز المحروس — لا قبلها
  const grid = a4.indexOf("if (layout?.design === 'grid_bilingual') {");
  assert.ok(grid > 0, 'فرع القالب ثنائي اللغة غائب');
  for (const anchor of ['const zDecision = zatcaPrintDecision(', 'const docTitle = pt.title(', 'const qrValue = zDecision.qr.source']) {
    assert.ok(a4.indexOf(anchor) > 0 && a4.indexOf(anchor) < grid, `${anchor} بعد فرع القالب الجديد`);
  }
  // الرمز كتلةُ اليوم نفسها (InvoiceQrBlock بقيمة القرار وqrValue المحروسة) — للقالبين
  assert.match(a4, /const qrNode = <InvoiceQrBlock doc=\{doc\} zDecision=\{zDecision\} qrValue=\{qrValue\} look=\{look\} pt=\{pt\} \/>;/);
  /* قرار المالك ٤ نوفمبر ٢٠٢٦ («احذف كل شيء حتى QR»): الرمز يُطبع ما لم تحذفه الشركة صراحةً — بوابةٌ واحدة qrShown من isQrRemoved
   * على تخطيط القالب، وكل استعمالٍ للكتلة (الثنائي والإجماليات واليتيم) يمرّ بها فتسقط الكتلة كلّها معاً (المختوم والحكومي والمرحلة
   * الأولى والسبب والتلميح والتعليق وICV/UUID). ولا قراءة يدوية لـsections.qr. */
  /* تحديثٌ مقصود («إزالة الضريبة»، طلب المالك ٧ نوفمبر ٢٠٢٦): البوابة نفسها وشرطٌ ثانٍ من القرار وحده (hideTaxIds — المستند المختوم بلا
   * ضريبة لا كتلة رمز له: لا «أضف الرقم الضريبي…» ولا «قيد الاعتماد…») — وما زالت قراءة الحذف واحدة */
  assert.match(a4, /\n\s*const qrShown = isQrRemoved\(layout\) \|\| zDecision\.hideTaxIds \? null : qrNode;\n/);
  assert.equal((a4.match(/\bqrNode\b/g) || []).length, 2, 'qrNode: التعريف والبوابة وحدهما');
  assert.equal((stripComments(a4).match(/isQrRemoved\(/g) || []).length, 1, 'قراءةٌ ثانية لحذف الرمز في قالب A4');
  assert.doesNotMatch(stripComments(s), /sections\??\.qr\b/, 'قراءةٌ يدوية لخيار حذف الرمز');
  assert.match(a4, /<GridInvoice ref=\{ref\} doc=\{doc\} facts=\{\{ pt, zDecision, title: docTitle, inclusiveDoc, vatRate, noteRefs \}\} look=\{look\} layout=\{layout\} qr=\{qrShown\} \/>/);
  /* «التحرير الحرّ»: الرمز في الإجماليات مرّةً واحدة، ولا يُقطع منها (omitQr) إلا لأنّ مربع QR موضوعٌ في لوحة؛ وإن أُخفي القسم
   * الحامل ولم يوضع المربع ولم يُحذف الرمز طُبعت الكتلة نفسها يتيمةً بعد الأصناف (freeBody) */
  assert.equal((a4.match(/\{!o\?\.omitQr && qrShown\}/g) || []).length, 1, 'الرمز في القالب الحالي داخل الإجماليات مرّةً واحدة');
  assert.equal((a4.match(/\bqrShown\b/g) || []).length, 6, 'qrShown: التعريف والثنائي والإجماليات (المحاذاة والكتلة وسقوط القسم الفارغ) واليتيم');
  assert.equal((a4.match(/omitQr: [^,}]+/g) || []).join('|'), "omitQr: placed.has('qr')", 'الرمز يُقطع من الإجماليات بلا مربعٍ في لوحة');
  assert.match(a4, /\n\s*qr: qrShown,\n/);
  assert.match(s, /const orphan = isNode\(parts\.qr\) && !placed\.has\('qr'\) && \(!visible\.has\('totals'\) \|\| qrOrphan\(layout, printer, 'standard'\)\);/, 'الرمز اليتيم لا يُطبع إن أُخفيت الإجماليات');
  assert.match(s, /if \(id === 'items' && orphan\) \{/);
  const g = stripComments(read('rep/printGrid.tsx'));
  assert.doesNotMatch(g, /buildZatcaQr\s*\(|QRCode\.|data-qr-value|zatcaPrintDecision\(|buyerNotice/, 'القالب ثنائي اللغة يبني رمزاً أو قراراً');
});
