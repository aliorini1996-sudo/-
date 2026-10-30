// «تتبّع اللوط» — حرّاس نصّية للحزمة B6 (المواصفة §٨.٣، §٤.٩). تملكه B6.
// على المصدر: موضع الفحص المسبق والتوزيع في فرعي المرحلة الثانية، وأن اللوط خلف شرطه (R1)، وبلا طابور (D29) ولا قاعدة مباشرة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

function ordered(text: string, needles: readonly string[], msg: string): void {
  let pos = -1;
  for (const n of needles) {
    const idx = text.indexOf(n, pos + 1);
    assert.ok(idx > pos, `${msg}: «${n}» مفقود أو خارج الترتيب`);
    pos = idx;
  }
}

const ZATCA = stripComments(read('routes/invoicesZatca.ts'));
const NOTES = stripComments(read('routes/invoicesNotes.ts'));
const DEPS = stripComments(read('routes/invoicesZatcaDeps.ts'));

test('الفرع: الفحص المسبق قبل openIssuanceSigning، والتوزيع بعد قفل الأساس وقبل إدراج الصفّ وقبل afterDocument', () => {
  const issue = ZATCA.slice(ZATCA.indexOf('async function issueNow'), ZATCA.indexOf('function pendingResult('));
  ordered(issue, [
    'prepareIssuance(',
    'const pre = ctx.lots && deps.lots ? await lotPrecheck(deps.lots, deps.db, ctx.lots) : null;',
    'if (pre) throw pre;',
    'openIssuanceSigning(',
    'createInvoice: async (t, record) =>',
    'lockProductBases(t, ctx.tenantId, expectedBases)',
    'const alloc = ctx.lots && deps.lots ? await allocateLotsInTx(deps.lots, t, ctx.lots) : null;',
    'const lotInvoiceId = alloc ? randomUUID() : null;',
    't.invoice.create(',
    '...(lotInvoiceId && { id: lotInvoiceId }),',
    '...legacyItemColumns(i), ...phase2ItemColumns(record.items[idx]),',
    '...invoiceItemLotColumns(alloc?.lines ?? null, idx,',
    'afterDocument:',
  ], 'ترتيب فرع الإصدار');
  // كل نداء للخطّاف خلف شرط الخطة والخطّاف معاً (R1): لا أثر لشركةٍ مطفأة ولا لاعتمادياتٍ بلا lots
  assert.equal(ZATCA.split('ctx.lots && deps.lots ?').length - 1, 2, 'نداءٌ للخطّاف بلا شرطه');
  assert.doesNotMatch(ZATCA, /deps\.lots\.(precheck|allocateInTx)\(/, 'نداءٌ مباشر للخطّاف يتخطّى حارس التوأم أو تحويل الانشغال');
  // الفحص والتوزيع عبر المغلّفين وحدهما: رفضٌ لطلبٍ صدر توأمه لا يُرمى، وانتظار القفل LOT_BUSY (D14)
  const pre = ZATCA.slice(ZATCA.indexOf('export async function lotPrecheck('), ZATCA.indexOf('export async function allocateLotsInTx('));
  ordered(pre, [
    'const pre = await hooks.precheck(plan);',
    'if (!pre || !plan.clientRef) return pre;',
    'db.invoice.findUnique(',
    'tenantId_clientRef: { tenantId: plan.tenantId, clientRef: plan.clientRef }',
    'return twin ? null : pre;',
  ], 'حارس التوأم بعد الرفض وحده');
  const alloc = ZATCA.slice(ZATCA.indexOf('export async function allocateLotsInTx('), ZATCA.indexOf('export interface Phase2IssuanceDeps'));
  ordered(alloc, ['return await hooks.allocateInTx(tx, plan);', 'throw asLockBusy(e) ?? e;'], 'تحويل الانشغال');
  assert.equal(ZATCA.split('hooks.precheck(').length - 1, 1);
  assert.equal(ZATCA.split('hooks.allocateInTx(').length - 1, 1);
});

test('الإشعار الدائن: الفحص المسبق قبل stampNote/التوقيع، والتوزيع داخل createInvoice بعد قفل الأصل وإشعاراته', () => {
  const issue = NOTES.slice(NOTES.indexOf('async function issueNote('), NOTES.indexOf('async function stampNote('));
  ordered(issue, [
    'const preview = buildNote(',
    'const lots = await noteLotContext(kind, ctx, deps, preview, now);',
    'replay: lots.replay, stamps: lots.stamps,',
    'const pre = lots && prePlan ? await lotPrecheck(lots.hooks, deps.db, prePlan) : null;',
    'if (pre) throw pre;',
    'stampNote(kind, ctx, deps, seller, regime.unit, loaded, now, lots)',
  ], 'ترتيب الإشعار قبل التوقيع');
  const stamp = NOTES.slice(NOTES.indexOf('async function stampNote('), NOTES.indexOf('export function issueCreditNote'));
  ordered(stamp, [
    'openIssuanceSigning(',
    'deps.chain.lockChainHead(tx, unit.id)',
    'lockNoteOriginal(tx, ctx.tenantId, ctx.originalInvoiceId)',
    'loadPriorNotes(tx as unknown as NoteDb',
    'createInvoice: async (t, record) =>',
    'const lotVan = creditVanOf(ctx, locked.original);',
    "const lotPlan = lots && kind === 'CREDIT_NOTE' ? creditNoteLotPlan(prepared,",
    'replay: lots.replay, stamps: lots.stamps,',
    'const alloc = lots && lotPlan ? await allocateLotsInTx(lots.hooks, t, lotPlan) : null;',
    't.invoice.create(',
    '...invoiceItemLotColumns(alloc?.lines ?? null, idx,',
    'afterDocument:',
  ], 'ترتيب الإشعار داخل المعاملة');
  assert.doesNotMatch(NOTES, /hooks\.(precheck|allocateInTx)\(/, 'نداءٌ مباشر للخطّاف يتخطّى حارس التوأم أو تحويل الانشغال');
  // السيارة = مندوب الإشعار، وهو salesRepId صفّه نفسه
  assert.match(NOTES, /const creditVanOf = \(ctx: NoteContextBase, original: NoteOriginalInvoice\): string \| null => ctx\.salesRepId \?\? original\.salesRepId \?\? null;/);
  assert.match(NOTES, /: \(ctx\.salesRepId \?\? locked\.original\.salesRepId\)/);
  // الخطة: الوراثة (CREDITED) بيوم الخادم ولو أُعيدت (الإعادة تعفي من رفض الكسور وحده)، واللقطة القائمة بفهرس البند الحاكم
  assert.match(NOTES, /docType: 'RETURN', link: 'CREDITED', actor: at\.actor, replay: at\.replay \?\? null, day: at\.day, returnDay: at\.day,/);
  assert.match(NOTES, /const s = at\.stamps\?\.get\(l\.invoiceItemId\);\n\s*if \(s\) fallbackStamps\.set\(idx, s\);/);
  // والعلم يُقرأ للدائن وحده وحين يمسّ بندٌ صنفاً معلَّماً (§١٠.١)، ثم اليوم والإعادة (للمندوب وحده، D23) واللقطة
  const ctxFn = NOTES.slice(NOTES.indexOf('async function noteLotContext('), NOTES.indexOf('const creditVanOf'));
  ordered(ctxFn, [
    "if (kind !== 'CREDIT_NOTE' || !deps.lots) return null;",
    'tracked.has(l.productId)',
    'await deps.lots.enabled(ctx.tenantId)',
    'deps.lots.day(ctx.tenantId, now)',
    "actor === 'REP' && isReplayRequest(ctx.caps) && ctx.clientRef ? replayMoment(ctx.clientCreatedAt, now, 'UTC') : null;",
    'deps.lots.linkedStamps && saleItemIds.length',
    'await deps.lots.linkedStamps(ctx.tenantId, saleItemIds, now)',
  ], 'شروط قراءة العلم');
  assert.match(NOTES, /damagedReturnToStock: true, lotTracked: true,/, 'lotTracked لا يُقرأ من صفّ الأصل المحمَّل');
});

test('D29 وعزل الفرعين: لا طابور لوط، ولا قاعدة مباشرة، ولا خدمة لوط تجرّ Prisma — الخدمة محقونة من الاعتماديات', () => {
  for (const [name, s] of [['invoicesZatca.ts', ZATCA], ['invoicesNotes.ts', NOTES], ['invoicesZatcaDeps.ts', DEPS]] as const) {
    assert.doesNotMatch(s, /acquireLotQueue/, `${name}: طابور لوط في إصدار المرحلة الثانية (مسلسل لكل وحدة أصلاً)`);
  }
  for (const [name, s] of [['invoicesZatca.ts', ZATCA], ['invoicesNotes.ts', NOTES]] as const) {
    assert.doesNotMatch(s, /from '\.\.\/config\/database'/, `${name}: قاعدة مباشرة`);
    assert.doesNotMatch(s, /from '\.\.\/services\/lots(Invoice|Db)'/, `${name}: خدمة لوط بقاعدة تُستورد بدل الحقن`);
  }
  // الإنتاج: الخطّاف هو خدمة المرحلة الأولى نفسها (لا نسخة ثانية من المنطق)
  assert.match(DEPS, /enabled: tenantId => lotTrackingEnabledFor\(prisma, tenantId\)/);
  assert.match(DEPS, /day: async \(tenantId, at\) => \(await companyDay\(prisma, tenantId, at\)\)\.day/);
  assert.match(DEPS, /precheck: plan => precheckInvoiceLots\(prisma, plan\)/);
  assert.match(DEPS, /allocateInTx: \(tx, plan\) => allocateInvoiceLotsInTx\(tx as unknown as LotTx, plan\)/);
  // اللقطة القائمة (D12) هي linkedReturnExpiry التي يختم بها المرتجع المرتبط في المرحلة الأولى
  assert.match(DEPS, /linkedStamps: \(tenantId, saleItemIds, at\) => linkedReturnExpiry\(tenantId, \[\.\.\.saleItemIds\], at\)/);
  // المهلة الموسّعة (D13) قائمة أصلاً في معاملة الإصدار
  assert.match(DEPS, /maxWait: ISSUANCE_TX_MAX_WAIT_MS, timeout: ISSUANCE_TX_TIMEOUT_MS/);
});

test('المدين بلا توزيع: الخطة للدائن وحده، وبنود المدين بلا صنف كما هي', () => {
  assert.match(NOTES, /productId: kind === 'CREDIT_NOTE' \? \(line\?\.productId \?\? null\) : null,/);
  const stamp = NOTES.slice(NOTES.indexOf('async function stampNote('), NOTES.indexOf('export function issueCreditNote'));
  assert.equal(stamp.split('allocateLotsInTx(lots.hooks,').length - 1, 1);
});
