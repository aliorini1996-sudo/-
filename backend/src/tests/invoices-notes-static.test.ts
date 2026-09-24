// ZATCA المرحلة الثانية (Z5.5) — حرّاس ثابتة على وصل الإشعارات بمسار الفواتير (z5_plan §3 Z5.5 «Tests» + §0.4 ونقد 13/20/38).
// نصّية على المصدر: لا قاعدة بيانات ولا شبكة. تحرس ما لا يمسكه اختبار السلوك: **ترتيب الأقفال** داخل المعاملة،
// و«الفرق النسبيّ» في متبقّي الأصل، وبقاء المرحلة الأولى بلا أثر، وألّا يمسّ الوصلُ الدفاترَ ولا قاعدة البيانات مباشرةً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const NOTES = stripComments(read('routes/invoicesNotes.ts'));
const ROUTES = stripComments(read('routes/invoices.ts'));
const VOID = stripComments(read('services/invoiceVoid.ts'));

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

/** جسم معالج من سطر تعريفه حتى `\n});` التالي. */
function handler(src: string, head: string): string {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `المعالج مفقود: ${head}`);
  const end = src.indexOf('\n});', i);
  assert.ok(end > i, `نهاية المعالج مفقودة: ${head}`);
  return src.slice(i, end);
}

// ═══ الوصل نفسه ═══

test('routes/invoicesNotes.ts: لا قاعدة بيانات مباشرة ولا شبكة ولا عميل هيئة (الاعتماديات محقونة)', () => {
  assert.doesNotMatch(NOTES, /from '\.\.\/config\/database'/, 'الوصل يستورد Prisma مباشرة فيمتنع حقنه في الاختبار');
  assert.doesNotMatch(NOTES, /\bfetch\(|require\('https?'\)|from 'node:https?'|from 'https?'/, 'نداء شبكة في وصل الإشعارات');
  assert.doesNotMatch(NOTES, /FatooraClient|submitDocument\(/, 'الوصل ينادي الهيئة مباشرةً بدل المحرّك المحقون');
  assert.doesNotMatch(NOTES, /services\/paylink/, 'إماتة الروابط داخل الوصل (نداء شبكيّ قد يقع تحت قفل)');
});

// ═══ ترتيب الأقفال داخل المعاملة (§0.4 ونقد 38) ═══

test('الوحدة أوّلاً، ثمّ الفاتورة الأصلية، ثمّ إشعاراتها، ثمّ الختم، ثمّ صفّ الأصل، ثمّ دفتر العميل', () => {
  const fn = NOTES.slice(NOTES.indexOf('async function stampNote('), NOTES.indexOf('export function issueCreditNote'));
  ordered(fn, [
    'deps.chain.lockChainHead(tx, unit.id)',
    'lockNoteOriginal(tx,',
    'loadPriorNotes(tx',
    'legacyReturnsFor(tx',
    'buildNote(kind, ctx, locked, priorNotes, seller, now, legacyReturns)',
    'stampNoteInTx<Phase2Tx>(',
    'allocateNumber:',
    'createInvoice:',
    'afterDocument:',
    'remainingAfterCreditNote(locked.original, total)',
    't.invoice.update({ where: { id: locked.original.id }',
    'deps.ledger.postReturn(',
  ], 'ترتيب معاملة الإشعار');
});

test('الأصل يُقرأ مقفلاً (FOR UPDATE) داخل المعاملة، والتحضير الحاكم من الصفوف المقفلة', () => {
  assert.match(NOTES, /FROM invoices WHERE id = \$\{invoiceId\} AND "tenantId" = \$\{tenantId\} FOR UPDATE/, 'الأصل لا يُقفل');
  // تحضيران: واحد قبل القفل (رفضٌ رخيص) وواحد تحت القفل (حاكم)
  assert.equal(NOTES.split('buildNote(kind, ctx,').length - 1, 2, 'عدد مرّات التحضير ليس اثنين (قبل القفل وتحته)');
});

test('نقد 13: متبقّي الأصل يُكتب فرقاً نسبياً لا قيمةً مطلقة — في الإشعار وفي إبطاله', () => {
  assert.match(NOTES, /data: \{ remainingAmt: \{ decrement: remaining\.decrement \} \}/, 'الإشعار يكتب متبقّياً مطلقاً');
  // كتابةٌ واحدة على صفّ الأصل في الوصل كلّه، وهي النسبية أعلاه (remainingAfter يُعرض في الردّ ولا يُكتب)
  assert.equal(NOTES.split('.invoice.update(').length - 1, 1, 'كتابة ثانية على صفّ فاتورة داخل الوصل');
  // الإبطال يردّ ما أُسقط بزيادةٍ مسقوفة بالدَّين نفسه (SQL واحد بلا قراءة سابقة)
  assert.match(VOID, /LEAST\("total" - "paidAmt", "remainingAmt" \+ \$\{amount\}\)/, 'ردّ المتبقّي ليس نسبياً ولا مسقوفاً');
  assert.match(VOID, /inv\.documentKind === 'CREDIT_NOTE'/, 'الإبطال لا يميّز الإشعار الدائن فلا يردّ متبقّي أصله');
});

// ═══ إبطال الإشعار: ترتيب الأقفال نفسه (مراجعة «تراجع/امتثال») ═══

test('إبطال إشعار دائن: ردّ متبقّي الأصل قبل عكس القيود — الترتيب invoices ⇒ customers كبقيّة الكتّاب', () => {
  const fn = VOID.slice(VOID.indexOf('export async function voidInvoiceInTx('), VOID.indexOf('export function afterVoidCommit'));
  ordered(fn, [
    'lockInvoice(tx, input.invoiceId)',
    "data: { status: 'CANCELLED'",
    'restoreOriginalRemaining(tx, input.tenantId, inv.originalInvoiceId, inv.total)',
    'reverseInvoiceInTx(tx as unknown as LedgerTx, inv, mode)',
    'voidNotificationText(',
  ], 'ترتيب معاملة الإبطال');
  // عكسُ القيود يقفل صفّ العميل؛ لو تأخّر ردُّ المتبقّي عنه لانقلب الترتيب على الصفّين وتشابكت الأقفال (40P01)
  assert.ok(
    fn.indexOf('restoreOriginalRemaining(tx,') < fn.indexOf('reverseInvoiceInTx(tx'),
    'ردّ متبقّي الأصل بعد عكس القيود: انقلاب ترتيب الأقفال (العميل قبل الفاتورة)',
  );
});

test('نصّ إشعار الإدارة يميّز الإشعار الدائن عن الفاتورة (الاتجاه معكوس)', () => {
  const voidCore = stripComments(read('compliance/zatca/void.ts'));
  assert.match(voidCore, /ctx\.documentKind === 'CREDIT_NOTE'/, 'نصّ الإبطال واحدٌ للفاتورة وللإشعار');
  assert.match(voidCore, /خرجت من رصيد مخزون السيارة/, 'نصّ الإشعار الدائن لا يقول اتجاه المخزون الصحيح');
  assert.match(VOID, /documentKind: inv\.documentKind \?\? null/, 'الإبطال لا يمرّر نوع المستند للنصّ');
});

test('قيود الإشعار من البُناة القائمة وحدها (لا محاسبة جديدة)', () => {
  const deps = read('routes/invoicesZatcaDeps.ts');
  assert.match(deps, /postReturn: \(tx, tenantId, invoiceId, customerId, total, at\) => postReturnEntries\(/, 'الدائن لا يستعمل بانيَ المرتجع');
  assert.match(deps, /postDebitNote: \(tx, tenantId, invoiceId, customerId, total, at\) => postInvoiceEntries\(/, 'المدين لا يستعمل بانيَ الفاتورة');
  assert.doesNotMatch(NOTES, /accountEntry|customer\.update/, 'الوصل يكتب قيوداً بنفسه');
});

// ═══ صفّ الإشعار ═══

test('صفّ الإشعار الدائن مرتجعٌ كما يكتبه المسار القديم، والمدين فاتورة آجلة بلا أصناف', () => {
  const notes = stripComments(read('compliance/zatca/notes.ts'));
  assert.match(notes, /type: 'RETURN' as const/, 'الإشعار الدائن ليس صفّ مرتجع — مخزون السيارة لا يقرؤه');
  assert.match(notes, /type: 'CREDIT' as const/, 'الإشعار المدين ليس صفّاً آجلاً');
  // بند المدين بلا صنف: لا يخصم من مخزون السيارة ولا يدخل مبيعات الصنف
  assert.match(NOTES, /productId: kind === 'CREDIT_NOTE' \? \(line\?\.productId \?\? null\) : null/, 'بند الإشعار المدين قد يحمل صنفاً');
  assert.match(NOTES, /creditedItemId/, 'بند الإشعار الدائن غير مربوط ببند الأصل');
});

// ═══ المسارات ═══

test('مسارات الإشعارات محروسة: نطاقٌ بالعميل، ثمّ صلاحية Q5، ثمّ الإصدار', () => {
  const credit = handler(ROUTES, "router.post('/:id/credit-note'");
  ordered(credit, [
    'creditNoteSchema.parse(req.body)',
    'replyIfClientRefExists(req, res, tid, body.clientRef)',
    'noteTarget(req, tid)',
    'creditNotePermission(target.actor, creditScopeOf(body.lines))',
    'issueCreditNote(',
  ], 'ترتيب مسار الإشعار الدائن');
  const debit = handler(ROUTES, "router.post('/:id/debit-note'");
  assert.match(debit, /debitNotePermission\(target\.actor\)/, 'المدين بلا حارس صلاحية');
  // نقد 20: نطاق المندوب بالعميل لا بمُصدر الفاتورة
  const target = ROUTES.slice(ROUTES.indexOf('async function noteTarget('), ROUTES.indexOf('const NOTES_NOT_ENABLED'));
  assert.match(target, /canAccessCustomer\(req, tid, row\.customerId\)/, 'النطاق لا يمرّ بحارس العميل');
  assert.match(target, /scopedRecordWhere\(req, SHAPE_INVOICE_RECEIPT\)/, 'نطاق مستخدم الشركة ساقط');
  assert.doesNotMatch(target, /salesRepId !== req\.user/, 'المندوب محبوس على فواتيره هو (نقد 20)');
});

test('D3: مرتجع المرحلة الثانية يمرّ بالإشعار، والمرحلة الأولى تكمل مسارها القديم', () => {
  const post = handler(ROUTES, "router.post('/',");
  ordered(post, [
    'regimeCandidate({',
    "if (body.type === 'RETURN') {",
    'await issueReturnAsCreditNote(',
    'if (note) { res.status(note.status).json(note.body); return; }',
    'await issuePhase2Invoice(phase2Ctx, productionPhase2Deps())',
    'const invoice = await withNumberRetry(',
  ], 'موضع فرع المرتجع في POST /invoices');
  // المسار القديم لا يقرأ أعمدة الإشعار إطلاقاً
  const legacy = post.slice(post.indexOf('const invoice = await withNumberRetry('));
  assert.doesNotMatch(legacy, /originalInvoiceId|noteReason|creditedItemId|invoiceItemId/, 'المسار القديم يكتب أعمدة إشعار');
});

test('الإلغاء بعد الربط يحمل بديله (409 + ما يمكن إرجاعه) ولا يكتب شيئاً', () => {
  const h = handler(ROUTES, "router.patch('/:id/cancel'");
  const guard = h.indexOf('zatcaPhase === 2');
  assert.ok(guard > 0);
  assert.match(h.slice(guard, guard + 260), /ZATCA_CANCEL_NOT_ALLOWED/, 'الرفض بلا رمز الكتالوج');
  assert.match(h, /creditable: await cancelCreditablePayload\(req, tid\)/, 'الردّ بلا بديل الإلغاء');
  assert.ok(h.indexOf('prisma.$transaction') > guard, 'الحارس بعد الكتابة');
});

test('فاتورة صدر عليها إشعار لا تُلغى — الحارس قبل أيّ كتابة، وبحمولة البديل', () => {
  const h = handler(ROUTES, "router.patch('/:id/cancel'");
  const guard = h.indexOf('originalInvoiceId: invoice.id');
  assert.ok(guard > 0, 'لا حارس على الفواتير التي صدر عليها إشعار');
  assert.match(h.slice(guard - 400, guard + 600), /status: 'CONFIRMED'[\s\S]*ZATCA_CANCEL_NOT_ALLOWED/, 'الحارس لا يعدّ الإشعارات الملتزَمة');
  assert.ok(h.indexOf('prisma.$transaction') > guard, 'الحارس بعد الكتابة');
  // الحارس قبل عكس القيود بالإجمالي الكامل (وإلّا خُفّض رصيد العميل مرّتين)
  assert.ok(h.indexOf('reverseInvoiceInTx(') > guard, 'الحارس بعد عكس القيود');
});

test('رفعٌ مؤجَّل للإشعار بلا مفتاح منع تكرار ⇒ 426 قبل أيّ عمل (كالفاتورة تماماً)', () => {
  const fn = NOTES.slice(NOTES.indexOf('async function issueNote('), NOTES.indexOf('async function stampNote('));
  ordered(fn, [
    'capsGate(ctx.caps)',
    'isReplayRequest(ctx.caps) || typeof ctx.clientCreatedAt',
    'ZATCA_CLIENT_UPDATE_REQUIRED',
    'loadNoteOriginal(deps.db',
  ], 'حارس المفتاح في مسار الإشعارات');
});

test('Q5 يُقاس على أثر الإشعار لا على صيغته، وقبل أيّ قفل أو ICV', () => {
  assert.match(NOTES, /creditNotePermission\(ctx\.actor, effectiveCreditScope\(prepared\.creditable, prepared\.lines\)\)/, 'النطاق الحاكم ليس من الأثر');
  assert.match(NOTES, /ZATCA_NOTE_NOT_ALLOWED/, 'رفض الصلاحية بلا رمز الكتالوج');
  // الفحص داخل buildNote ⇒ يجري في التحضيرين معاً: قبل القفل (رفض رخيص) وتحته (لا يتسلّل بسباق)
  const build = NOTES.slice(NOTES.indexOf('function buildNote('), NOTES.indexOf('function legacyNoteItem('));
  assert.ok(build.indexOf('effectiveCreditScope(') > 0, 'فحص النطاق خارج التحضير');
  assert.match(ROUTES, /actor: target\.actor/, 'مسار الإشعار الدائن لا يمرّر صاحب الطلب');
});

test('مرتجعات ما قبل الربط تُخصم من المتاح لأصلٍ من المرحلة الأولى وحده', () => {
  const loader = NOTES.slice(NOTES.indexOf('export async function loadLegacyReturns('), NOTES.indexOf('// ─── الصلاحيات (Q5) ───'));
  assert.match(loader, /type: 'RETURN', status: 'CONFIRMED', documentKind: null, originalInvoiceId: null/, 'قراءة المرتجعات القديمة غير محصورة بالصفوف القديمة');
  assert.match(loader, /invoiceDate: \{ gte: since \}/, 'مرتجعٌ سابق لتاريخ الفاتورة يُخصم منها');
  assert.match(loader, /if \(original\.zatcaPhase === 2\) return \[\];/, 'الأصل المربوط يدفع ثمن استعلامٍ لا يعنيه');
  // والمعاينة والإصدار يقرآنها معاً (وإلّا عرضت الشاشة متاحاً يرفضه الإصدار)
  assert.equal(NOTES.split('legacyReturnsFor(').length - 1, 4, 'موضع قراءة المرتجعات القديمة ناقص أو زائد');
});

test('المرحلة الأولى: الإشعارات تُردّ 409 وتُغلق قبل أيّ إصدار', () => {
  assert.match(NOTES, /if \(regime\.phase === 1\) return null;/, 'الوصل لا يعيد null للمرحلة الأولى');
  assert.equal(ROUTES.split('NOTES_NOT_ENABLED').length - 1, 4, 'ردّ «غير مفعّلة» ناقص في أحد المسارات الثلاثة');
});
