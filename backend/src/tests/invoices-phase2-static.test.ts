// ZATCA المرحلة الثانية (Z5.2) — حرّاس ثابتة على وصل الفرع بمسار الفواتير (z5_plan §3 Z5.2 «Tests»).
// نصّية على المصدر: لا قاعدة بيانات ولا شبكة. تحرس ما لا يمسكه اختبار السلوك: **موضع** الفرع في المسار القديم، وبقاء
// حروف المرحلة الأولى، وألا يمسّ الفرعُ الهيئةَ ولا الدفاترَ ولا قاعدةَ البيانات مباشرةً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** جسم معالج من سطر تعريفه حتى `\n});` التالي. */
function handler(src: string, head: string): string {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `المعالج مفقود: ${head}`);
  const end = src.indexOf('\n});', i);
  assert.ok(end > i, `نهاية المعالج مفقودة: ${head}`);
  return src.slice(i, end);
}

function ordered(text: string, needles: readonly (string | RegExp)[], msg: string): void {
  let pos = -1;
  for (const n of needles) {
    const idx = typeof n === 'string' ? text.indexOf(n, pos + 1) : (() => {
      const r = new RegExp(n.source, 'g'); r.lastIndex = pos + 1; const m = r.exec(text); return m ? m.index : -1;
    })();
    assert.ok(idx > pos, `${msg}: «${String(n)}» مفقود أو خارج الترتيب`);
    pos = idx;
  }
}

// ═══ موضع الفرع في POST /invoices ═══

test('الفرع واحدٌ، بعد تحميل الإعدادات وبناء الأقساط، وقبل الترقيم والمعاملة', () => {
  const post = handler(read('routes/invoices.ts'), "router.post('/',");
  ordered(post, [
    'const company = await prisma.companySettings.findUnique',
    'const calc = computeInvoiceTotals(',
    'installmentRows = buildInstallments(',
    'regimeCandidate({',
    'await issuePhase2Invoice(phase2Ctx, productionPhase2Deps())',
    'const invoice = await withNumberRetry(',
    'prisma.$transaction(async tx =>',
    'publishInvoicesChanged(tid);',
    'res.status(201).json({ success: true, data: invoice });',
  ], 'ترتيب POST /invoices');
  // فرعٌ واحد لا أكثر
  assert.equal(post.split('issuePhase2Invoice(').length - 1, 1, 'أكثر من نداء للفرع في POST');
  assert.equal(post.split('regimeCandidate(').length - 1, 1, 'أكثر من قرار نظام ضريبي في POST');
  // الردّ الجاهز يُعاد فوراً ولا يسقط للمسار القديم
  assert.match(post, /if \(phase2\) \{ res\.status\(phase2\.status\)\.json\(phase2\.body\); return; \}/);
});

test('المرحلة الأولى: الحروف التي تعتمد عليها اختبارات قائمة (live-events، التوقيع، السند) كما هي', () => {
  const s = read('routes/invoices.ts');
  assert.match(s, /res\.status\(201\)\.json\(\{ success: true, data: invoice \}\);/);
  assert.match(s, /res\.status\(200\)\.json\(\{ success: true, data: existing, idempotent: true \}\); return;/);
  assert.match(s, /publishInvoicesChanged\(tid\);/);
  // البثّ يبقى بعد المعاملة وقبل الردّ (live-events.test.ts)
  const post = handler(s, "router.post('/',");
  const pub = post.indexOf('publishInvoicesChanged(tid);');
  assert.ok(pub > post.indexOf('const invoice = await withNumberRetry('), 'البثّ قبل الالتزام');
  assert.ok(pub < post.indexOf('res.status(201).json({ success: true, data: invoice });'));
});

test('قرار النظام الضريبي يُبنى من صفّ الإعدادات المحمَّل أصلاً (صفر استعلامات للمرحلة الأولى)', () => {
  const post = stripComments(handler(read('routes/invoices.ts'), "router.post('/',"));
  const i = post.indexOf('regimeCandidate({');
  const call = post.slice(i, post.indexOf("}) !== 'phase1'", i));
  assert.match(call, /zatcaPhase2StartedAt: company\?\.zatcaPhase2StartedAt/, 'العمود لا يُقرأ من الصفّ المحمَّل');
  assert.doesNotMatch(call, /await /, 'قرار النظام الضريبي يستعلم — المرحلة الأولى تدفع الثمن');
  // العمود مضاف إلى select الموجود لا باستعلام ثانٍ
  assert.match(read('routes/invoices.ts'), /select: \{ defaultVatPct: true, countryCode: true, currency: true, einvoiceProvider: true, zatcaPhase2StartedAt: true \}/);
  assert.equal(read('routes/invoices.ts').split('prisma.companySettings.findUnique').length - 1, 1, 'استعلام إعدادات ثانٍ في المسار');
});

test('القراءات: حارس القدرات لا يُستدعى إلا لصفّ zatcaPhase = 2 (لا اعتماديات ولا استعلام للمرحلة الأولى)', () => {
  const s = stripComments(read('routes/invoices.ts'));
  // خمسة مواضع منذ Z5.5: GET /:id، وإعادة الرفع، وسباق P2002، والقراءة بالمرجع، وإعادة رفع الإشعارات (clientRef)
  const hits = [...s.matchAll(/phase2Re(ad|play)Body\(/g)];
  assert.equal(hits.length, 5, 'مواضع القراءة الخمسة (GET /:id، إعادة الرفع، سباق P2002، القراءة بالمرجع، إعادة رفع الإشعار) غير مكتملة');
  for (const m of hits) {
    const line = s.slice(s.lastIndexOf('\n', m.index ?? 0), m.index);
    assert.match(line, /isPhase2Invoice\((invoice|existing)\) \? await $/, `نداء غير محروس: ${line.trim()}`);
  }
  // كل موضع يردّ 426 قبل أن يعيد الصفّ: ثلاثة بالشكل المختصر، وإعادة الرفع تردّ حالة المستند نفسها (422/202/200)
  // مع إرفاق الصفّ بعد إعادة قراءته — فردّ إعادة الرفع = ردّ الرفع الأوّل حرفاً بحرف (مراجعة عدائية)
  assert.equal(s.split('if (p2?.error) { res.status(p2.status).json(p2.error.body()); return; }').length - 1, 3);
  assert.match(s, /if \(p2\.error\) \{\s*const body = p2\.error\.body\(\);/, 'إعادة الرفع لا تردّ حالة الخطأ نفسها');
});

// ═══ الفرع نفسه ═══

test('routes/invoicesZatca.ts: لا قاعدة بيانات مباشرة ولا شبكة ولا عميل هيئة — والاعتماد الحيّ محقون (Z5.4)', () => {
  const s = stripComments(read('routes/invoicesZatca.ts'));
  assert.doesNotMatch(s, /from '\.\.\/config\/database'/, 'الفرع يستورد عميل Prisma مباشرة (يمنع حقنه في الاختبار)');
  assert.doesNotMatch(s, /\bfetch\(|require\('https?'\)|from 'node:https?'|from 'https?'/, 'نداء شبكة في فرع الإصدار');
  assert.doesNotMatch(s, /compliance\/zatca\/api'|createFatooraClient|reportInvoice|clearInvoice/, 'الفرع يبني عميل الهيئة بنفسه');
  assert.doesNotMatch(s, /from '\.\.\/services\/zatcaSubmit'/, 'الفرع يستورد محرّك الإرسال — فلا يُحقن في الاختبار');
  assert.doesNotMatch(s, /from '\.\.\/services\/accounting'/, 'قيود الدفتر تُحقن لا تُستورد هنا');
  // Z5.4: الاعتماد الحيّ دالّةٌ **محقونة اختيارية** — غيابها يعيد سلوك Z5.2 حرفياً (202 بانتظار الاعتماد)
  assert.match(s, /submitInline\?: InlineSubmitFn \| null/, 'الاعتماد الحيّ ليس حقناً اختيارياً');
});

test('ترتيب المعاملة (نقد 38): القفل ثمّ الرقم ثمّ الختم ثمّ الفاتورة ثمّ المستند ثمّ دفتر العميل', () => {
  const s = stripComments(read('compliance/zatca/issueTx.ts'));
  const body = s.slice(s.indexOf('export async function stampInTx'));
  ordered(body, [
    'chain.lockChainHead(', 'nextChainSlot(', 'issuedAtAfter(', 'hooks.allocateNumber(', 'mapAndCheck(', 'stampDocument(',
    'hooks.createInvoice(', 'documents.insertSigned(', 'documents.advanceUnitChain(', 'hooks.afterDocument(',
  ], 'ترتيب stampInTx');
  // وفرع المسار يُسنِد الخطّافات بالترتيب نفسه
  const route = stripComments(read('routes/invoicesZatca.ts'));
  ordered(route, ['allocateNumber:', 'createInvoice:', 'afterDocument:'], 'ترتيب خطّافات الفرع');
});

test('نقد 2: حارس القدرات قبل المرتجع وقبل الحجب وقبل أيّ إصدار', () => {
  const s = stripComments(read('routes/invoicesZatca.ts'));
  const fn = s.slice(s.indexOf('export async function issuePhase2Invoice'), s.indexOf('async function issueNow'));
  ordered(fn, [
    "if (regime.phase === 1) return null",
    'capsGate(ctx.caps)',
    "ctx.body.type === 'RETURN'",
    "'blocked' in regime",
    'issueNow(',
  ], 'ترتيب فرع الإصدار');
});

test('نقد 8: الترقيم بمقبض المعاملة نفسه — لا generateInvoiceNumber ولا prisma عام داخل الفرع', () => {
  const s = read('routes/invoicesZatca.ts');
  assert.doesNotMatch(s, /generateInvoiceNumber|generateReturnNumber|withNumberRetry/, 'الفرع يستعمل ترقيم المسار القديم (اتصال ثانٍ)');
  assert.match(s, /deps\.chain\.nextNumberInTx\(t, ctx\.tenantId, phase2NumberPrefix\('INV', issuedAt\)\)/);
  const store = read('compliance/zatca/issueStore.prisma.ts');
  assert.match(store, /async nextNumberInTx\(tx, tenantId, prefix\)/);
  assert.match(store, /tx\.invoice\.findFirst\(/, 'الترقيم لا يجري على مقبض المعاملة');
  assert.doesNotMatch(store, /from '\.\.\/\.\.\/config\/database'/);
});

test('نقد 9: keyVersion يُحفظ على المستند، والإسقاط لا يحمل بايتات XML', () => {
  assert.match(read('compliance/zatca/issueTx.ts'), /keyVersion: signing\.keyVersion/);
  const prismaStore = read('compliance/zatca/documentStore.prisma.ts');
  const sel = prismaStore.slice(prismaStore.indexOf('const PROJECTION_SELECT'), prismaStore.indexOf('} satisfies Prisma.ZatcaDocumentSelect'));
  assert.doesNotMatch(sel, /xmlGz|clearedXmlGz/, 'الإسقاط يحمل بايتات الفاتورة');
  assert.match(sel, /keyVersion: true/);
});

test('الاعتماديات: المهل صريحة، والقفل داخل العملية مركَّب، وقيود الدفتر هي دوالّ services/accounting نفسها', () => {
  const d = stripComments(read('routes/invoicesZatcaDeps.ts'));
  assert.match(d, /maxWait: ISSUANCE_TX_MAX_WAIT_MS, timeout: ISSUANCE_TX_TIMEOUT_MS/);
  assert.match(d, /mutex: issuanceUnitMutex/);
  assert.match(d, /postCashInvoiceEntries|postInvoiceEntries/);
  assert.match(d, /publish: publishInvoicesChanged/);
  assert.doesNotMatch(d, /services\/gl/);
});

test('فخّ NULL: لا مرشّح not على zatcaPhase، والمرآة تُقيَّد بـzatcaPhase = 2', () => {
  for (const f of ['routes/invoicesZatca.ts', 'routes/invoices.ts', 'routes/invoicesZatcaDeps.ts']) {
    assert.doesNotMatch(stripComments(read(f)), /zatcaPhase\s*:\s*\{\s*not\s*:(?!\s*null\b)/, `${f}: مرشّح not على عمود قابل للإفراغ`);
  }
  assert.match(read('compliance/zatca/documentStore.prisma.ts'), /where: \{ id: invoiceId, zatcaPhase: 2 \}/);
});
