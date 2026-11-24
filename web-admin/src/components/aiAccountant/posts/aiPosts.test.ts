// «قيود المحاسب الذكي» (حزمة C3): المنطق الصرف لبطاقة القيد وقائمته (aiPosts.ts) وحرّاسٌ نصّية على توصيلهما — العكس عبر
// مسار الدفاتر القائم وحده والسبب إلزامي، إبطال مفتاح القائمة المشترك، الزرّ معطّل للمعكوس، التواريخ الميلادية،
// والترجمات الأربع لكل عبارة في القاموس (عبارات الحزمة مدموجةٌ فيه — C3_PHRASES أدناه).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  POSTS_LIMIT, POSTS_QUERY_KEY, REVERSE_REASON_MAX, amortText, cleanReason, isMobilePath, ledgerMoveHref, lockedMonthsText, moveDocId,
  moveNotes, normalizePostedMove, normalizePostsResponse, postedKindLabel, postedKindTone, prepaidProgressText, prepaidStopText, reasonValid,
  reverseBody, reverseErrorInfo, reverseOutcome, reverseSuccessText,
} from './aiPosts';
import { PHRASES } from '../../../i18n/strings';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const CARD = read('components', 'aiAccountant', 'posts', 'PostedMoveCard.tsx');
const LIST = read('components', 'aiAccountant', 'posts', 'AiPostsList.tsx');
const LOGIC = read('components', 'aiAccountant', 'posts', 'aiPosts.ts');
const MOVES_API = read('api', 'ledgerMoves.ts');
const CLIENT = read('api', 'client.ts');

const arTr = (s: string) => s;
const axiosErr = (status: number, data?: unknown) => ({ isAxiosError: true, response: { status, data } });

// ─── العكس: المسار القائم والسبب الإلزامي ───

test('العكس عبر مسار الدفاتر القائم POST /ledger/moves/:id/reverse — لا مسار جديد ولا window.prompt', () => {
  assert.match(MOVES_API, /reverse: \(id: string, data: ReverseInput\) => api\.post<[^>]+>>\(`\$\{L\}\/moves\/\$\{id\}\/reverse`, data\)/);
  assert.match(MOVES_API, /const L = '\/ledger';/);
  assert.match(CARD, /import \{ ledgerMovesApi \} from '\.\.\/\.\.\/\.\.\/api\/ledgerMoves';/);
  assert.match(CARD, /ledgerMovesApi\.moves\.reverse\(move\.moveId, body\)/, 'يُعكس القيد بمعرّف قيد الدفاتر (moveId) لا معرّف السجلّ');
  assert.doesNotMatch(CARD, /window\.prompt|\bprompt\(|window\.confirm/);
  assert.doesNotMatch(CARD + LIST + LOGIC, /['"`]\/ai-accountant\/[^'"`\s]*revers/, 'لا مسار عكسٍ خاصّ بالمحاسب');
});

test('السبب إلزامي: الجسم لا يُبنى بلا سبب، والإرسال معطّل، والخانة required وبحدّ ٥٠٠', () => {
  assert.match(CARD, /const body = reverseBody\(reason, date\);\n\s+if \(!body\) throw/);
  assert.match(CARD, /const canSubmit = !busy && !reversed && reasonValid\(reason\);/);
  assert.match(CARD, /<button type="submit" disabled=\{!canSubmit\}/);
  assert.match(CARD, /required\n\s+aria-required/);
  assert.match(CARD, /maxLength=\{REVERSE_REASON_MAX\}/);
  assert.equal(REVERSE_REASON_MAX, 500);
  assert.match(CARD, /if \(canSubmit\) run\.mutate\(null\);/);
});

test('reasonValid/reverseBody: الفارغ والمسافات مرفوضان، والسبب مشذّب، والتاريخ لا يُرسَل إلا يوماً صالح الصيغة', () => {
  assert.equal(reasonValid(''), false);
  assert.equal(reasonValid('   \n\t '), false);
  assert.equal(reasonValid(null), false);
  assert.equal(reasonValid(undefined), false);
  assert.equal(reasonValid('x'.repeat(REVERSE_REASON_MAX)), true);
  assert.equal(reasonValid('x'.repeat(REVERSE_REASON_MAX + 1)), false);
  assert.equal(cleanReason('  المبلغ خاطئ  '), 'المبلغ خاطئ');

  assert.equal(reverseBody('   '), null);
  assert.equal(reverseBody('', '2026-11-20'), null);
  assert.deepEqual(reverseBody('  المبلغ خاطئ '), { reason: 'المبلغ خاطئ' });
  assert.deepEqual(reverseBody('سبب', null), { reason: 'سبب' });
  assert.deepEqual(reverseBody('سبب', '2026-12-01'), { reason: 'سبب', date: '2026-12-01' });
  assert.deepEqual(reverseBody('سبب', '01/12/2026'), { reason: 'سبب' }, 'صيغةٌ غير YYYY-MM-DD لا تُرسَل');
  assert.ok(!('date' in reverseBody('سبب')!), 'بلا تاريخ: الخادم يختار max(اليوم، تاريخ القيد)');
});

test('النجاح: إشعار، والبطاقة «معكوس» فوراً، وإبطال [\'ai-accountant-posts\']، وonReversed', () => {
  assert.deepEqual([...POSTS_QUERY_KEY], ['ai-accountant-posts']);
  const ok = CARD.slice(CARD.indexOf('onSuccess:'), CARD.indexOf('onError:'));
  assert.match(ok, /toast\.success\(reverseSuccessText\(o, tr\)\)/);
  assert.match(ok, /setDone\(o\)/);
  assert.match(ok, /qc\.invalidateQueries\(\{ queryKey: POSTS_QUERY_KEY \}\)/);
  assert.match(ok, /onReversed\?\.\(\)/);
  assert.match(CARD, /onError: \(e\) => setErr\(reverseErrorInfo\(e, tr\)\)/);
  // غلاف المحادثة (C1) يبطل المفتاح نفسه حرفياً
  const chat = read('components', 'aiAccountant', 'AiAccountantChat.tsx');
  assert.match(chat, /\['ai-accountant-posts'\]/);
});

test('المعكوس: الزرّ معطّل، والحالة «معكوس»، والإرسال محجوب', () => {
  assert.match(CARD, /const reversed = move\.reversed === true \|\| done !== null;/);
  assert.match(CARD, /disabled=\{reversed\}/);
  assert.match(CARD, /\{reversed \? \(/);
  assert.match(CARD, /tr\('معكوس'\)/);
});

test('reverseOutcome/reverseSuccessText: رقم القيد العكسي، والمعكوس مسبقاً، وردٌّ ناقص لا يُسقط', () => {
  const o = reverseOutcome({ alreadyReversed: false, original: { id: 'm1', number: 'MISC/2026/0007' }, reversal: { id: 'r1', number: 'MISC/2026/0009', date: '2026-11-18' } });
  assert.deepEqual(o, { alreadyReversed: false, reversalNumber: 'MISC/2026/0009' });
  assert.equal(reverseSuccessText(o, arTr), 'تم عكس القيد MISC/2026/0009');
  const again = reverseOutcome({ alreadyReversed: true, reversal: { id: 'r1', number: 'MISC/2026/0009' } });
  assert.equal(reverseSuccessText(again, arTr), 'القيد معكوس مسبقا');
  assert.deepEqual(reverseOutcome(undefined), { alreadyReversed: false, reversalNumber: null });
  assert.deepEqual(reverseOutcome({ reversal: { number: '  ' } }), { alreadyReversed: false, reversalNumber: null });
  assert.equal(reverseSuccessText(reverseOutcome(null), arTr), 'تم عكس القيد');
});

// ─── رفض العكس ───

test('الفترة المقفلة: رسالة واضحة وأوّل تاريخٍ مفتوح (أعلى الجسم أو في details) وزرّ العكس به', () => {
  const top = reverseErrorInfo(axiosErr(422, {
    success: false, code: 'LEDGER_PERIOD_LOCKED', date: '2026-10-15', lockDate: '2026-10-31', firstOpenDate: '2026-11-01',
    details: { date: '2026-10-15', lockDate: '2026-10-31', firstOpenDate: '2026-11-01' },
  }), arTr);
  assert.deepEqual(top, { message: 'تاريخ العكس ضمن فترة مقفلة', locked: true, firstOpenDate: '2026-11-01' });

  const nested = reverseErrorInfo(axiosErr(422, { code: 'LEDGER_PERIOD_LOCKED', details: { firstOpenDate: '2026-12-01' } }), arTr);
  assert.equal(nested.firstOpenDate, '2026-12-01');

  const bad = reverseErrorInfo(axiosErr(422, { code: 'LEDGER_PERIOD_LOCKED', details: { firstOpenDate: 'غدا' } }), arTr);
  assert.deepEqual(bad, { message: 'تاريخ العكس ضمن فترة مقفلة', locked: true, firstOpenDate: null });

  // سببٌ أدقّ معروف يُترجم بتسميته ولا يُعرض زرّ التاريخ
  const before = reverseErrorInfo(axiosErr(422, { code: 'LEDGER_PERIOD_LOCKED', reason: 'BEFORE_ORIGINAL_DATE' }), arTr);
  assert.equal(before.message, 'تاريخ العكس لا يسبق تاريخ القيد الأصلي');
  assert.equal(before.firstOpenDate, null);

  assert.match(CARD, /err\.locked && err\.firstOpenDate && \(/);
  assert.match(CARD, /run\.mutate\(err\.firstOpenDate\)/);
  assert.match(CARD, /tr\('أول تاريخ مفتوح: \{date\}'\)\.replace\('\{date\}', formatDayOnly\(err\.firstOpenDate\)\)/);
});

test('رفوضٌ أخرى: الصلاحية، والسبب، والمملوك لمستند، والشبكة، والخادم بلا جسم', () => {
  assert.equal(reverseErrorInfo(axiosErr(403, { code: 'LEDGER_PERMISSION_DENIED' }), arTr).message, 'عكس القيود يحتاج صلاحية «إنشاء القيود وترحيلها»');
  assert.equal(reverseErrorInfo(axiosErr(422, { code: 'LEDGER_REVERSAL_REASON_REQUIRED' }), arTr).message, 'سبب العكس مطلوب');
  assert.equal(reverseErrorInfo(axiosErr(409, { code: 'LEDGER_SOURCE_OWNED_MOVE' }), arTr).message, 'القيد مملوك لمستند مصدر ويُلغى من مستنده');
  assert.equal(reverseErrorInfo(axiosErr(403, { code: 'LEDGER_SCOPED_ADMIN' }), arTr).message, 'تعذر تنفيذ الإجراء');
  assert.equal(reverseErrorInfo(axiosErr(404, { success: false, message: 'السجل غير موجود' }), arTr).message, 'السجل غير موجود');
  assert.equal(reverseErrorInfo(axiosErr(502, '<html>bad gateway</html>'), arTr).message, 'تعذر تنفيذ الإجراء');
  assert.equal(reverseErrorInfo(axiosErr(429, {}), arTr).message, 'طلبات كثيرة، حاول بعد قليل');
  const net = reverseErrorInfo(new Error('Network Error'), arTr);
  assert.deepEqual(net, { message: 'تعذر الاتصال بالخادم — تحقق من الإنترنت ثم أعد المحاولة', locked: false, firstOpenDate: null });
  // رسالة الخادم الخام لا تُعرض أبداً (عربية وحدها)
  assert.notEqual(reverseErrorInfo(axiosErr(422, { code: 'X_UNKNOWN', message: 'raw server text' }), arTr).message, 'raw server text');
});

// ─── التسميات والعرض ───

test('تسميات النوع: مصروف/رواتب/سداد مستحق، والمجهول «قيد»، وبألوان مختلفة', () => {
  assert.equal(postedKindLabel('EXPENSE'), 'مصروف');
  assert.equal(postedKindLabel('SALARIES'), 'رواتب');
  assert.equal(postedKindLabel('SALARIES_SETTLE'), 'سداد مستحق');
  assert.equal(postedKindLabel('PAYROLL_V2'), 'قيد');
  assert.equal(postedKindLabel(undefined), 'قيد');
  assert.equal(postedKindLabel('SALARIES', (s) => `<${s}>`), '<رواتب>', 'التسمية تمرّ بـtr');
  const tones = new Set(['EXPENSE', 'SALARIES', 'SALARIES_SETTLE', 'X'].map(postedKindTone));
  assert.equal(tones.size, 4);
});

test('العرض: التاريخ ميلادي عبر utils/format (ca-gregory)، والرقم والمرجع والسطور والمبلغ من الخادم كما هي', () => {
  assert.match(CARD, /formatDayOnly\(move\.date\)/);
  assert.match(CARD, /formatDateTime\(move\.createdAt\)/);
  assert.doesNotMatch(CARD, /toLocaleDateString|toLocaleString|new Intl\.DateTimeFormat/);
  assert.match(read('utils', 'format.ts'), /ca-gregory/);
  assert.match(CARD, /move\.moveNumber/);
  assert.match(CARD, /\{move\.ref\}/);
  assert.match(CARD, /formatCurrency\(move\.amount\)/);
  assert.match(CARD, /move\.lines\.map\(/);
  assert.match(CARD, /tr\('مدين'\)/);
  assert.match(CARD, /tr\('دائن'\)/);
  assert.match(CARD, /tr\('الحساب'\)/);
  // البطاقة لا تجمع ولا تحسب مبلغاً
  assert.doesNotMatch(CARD, /\.reduce\(/);
});

test('isMobilePath/ledgerMoveHref: لا رابط دفاتر في /m، والرابط إلى صفحة القيد في لسانٍ جديد', () => {
  assert.equal(isMobilePath('/m'), true);
  assert.equal(isMobilePath('/m/ai-accountant'), true);
  assert.equal(isMobilePath('/app/ai-accountant'), false);
  assert.equal(isMobilePath('/menu'), false);
  assert.equal(ledgerMoveHref('a b/c'), '/app/ledger/entries/a%20b%2Fc');
  assert.match(CARD, /target="_blank"\n\s+rel="noopener noreferrer"/);
  assert.match(CARD, /canLedger\(user, 'canViewLedger'\)/);
});

// ─── القائمة ───

test('القائمة: react-query [\'ai-accountant-posts\'] عبر aiAccountantApi.posts، وحالة فارغة وخطأ بإعادة', () => {
  assert.match(CLIENT, /posts: \(limit = 50\) => api\.get\('\/ai-accountant\/posts', \{ params: \{ limit \} \}\)/);
  assert.match(LIST, /queryKey: POSTS_QUERY_KEY/);
  assert.match(LIST, /aiAccountantApi\.posts\(POSTS_LIMIT\)/);
  assert.equal(POSTS_LIMIT, 50);
  assert.match(LIST, /normalizePostsResponse\(/);
  assert.match(LIST, /<PostedMoveCard key=\{m\.moveId\} move=\{m\} \/>/);
  assert.match(LIST, /tr\('لا توجد قيود سجّلها المحاسب الذكي بعد'\)/);
  assert.match(LIST, /q\.refetch\(\)/);
  assert.match(LIST, /^export default function AiPostsList\(\)/m);
  assert.match(CARD, /^export default function PostedMoveCard\(\{ move, onReversed \}: \{ move: PostedMove; onReversed\?: \(\) => void \}\)/m);
});

test('normalizePostsResponse/normalizePostedMove: شكلٌ غير متوقّع ⇒ قائمة فارغة، وحقولٌ ناقصة بقيم آمنة', () => {
  assert.deepEqual(normalizePostsResponse(undefined), []);
  assert.deepEqual(normalizePostsResponse({}), []);
  assert.deepEqual(normalizePostsResponse({ rows: 'x' }), []);
  const full = {
    id: 'p1', moveId: 'm1', moveNumber: 'MISC/2026/0001', ref: 'AI-1b4e28ba-2fa1-41d2-883f-0016d3cca427-1', kind: 'EXPENSE',
    amount: 1500, date: '2026-11-18', summaryAr: 'إيجار نقداً', reversed: false, createdAt: '2026-11-18T09:00:00.000Z', adminName: 'أحمد',
    lines: [
      { accountCode: '621004', accountName: 'الإيجار', debit: 1500, credit: 0 },
      { accountCode: '111001', accountName: 'الصندوق الرئيسي', debit: 0, credit: 1500 },
    ],
  };
  const rows = normalizePostsResponse({ rows: [full, null, { id: 'no-move' }, { moveId: '' }, 7] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], full);

  const sparse = normalizePostedMove({ moveId: 'm2', lines: [null, { accountCode: '611001', debit: '200.5' }], reversed: 'yes', moveNumber: ' ', adminName: '' })!;
  assert.equal(sparse.id, 'm2');
  assert.equal(sparse.moveNumber, null);
  assert.equal(sparse.reversed, false, 'reversed الحقيقية وحدها');
  assert.equal(sparse.adminName, null);
  assert.equal(sparse.kind as string, '', 'النوع الغائب لا يُنسب لنوعٍ لم يقله الخادم');
  assert.equal(postedKindLabel(sparse.kind), 'قيد');
  assert.deepEqual(sparse.lines, [{ accountCode: '611001', accountName: '', debit: 200.5, credit: 0 }]);
  assert.equal(normalizePostedMove('x'), null);
});

// ─── قيود المستندات (طلب المالك ١٨ نوفمبر): المقدّم وإطفاؤه والأصل، و«المستند» ───

test('أنواع المستندات: «إيجار/مصروف مقدّم» و«إطفاء شهري» و«أصل» بألوانٍ تخصّها', () => {
  assert.equal(postedKindLabel('PREPAID'), 'إيجار/مصروف مقدّم');
  assert.equal(postedKindLabel('PREPAID_AMORT'), 'إطفاء شهري');
  assert.equal(postedKindLabel('ASSET'), 'أصل');
  const tones = ['EXPENSE', 'SALARIES', 'SALARIES_SETTLE', 'PREPAID', 'PREPAID_AMORT', 'ASSET', 'X'].map(postedKindTone);
  assert.equal(new Set(tones).size, tones.length, 'لكل نوعٍ لونه، والمجهول رمادي');
  // البطاقة: أيقونةٌ لكل نوع، والأصل بلا إهلاك يقولها صراحةً
  assert.match(CARD, /move\.kind === 'PREPAID' \? CalendarClock : move\.kind === 'PREPAID_AMORT' \? Repeat : move\.kind === 'ASSET' \? Package : Receipt/);
  assert.match(CARD, /\{notes\.asset && \(\s*<p[\s\S]*?<Package size=\{12\} \/> \{notes\.asset\}/);
  assert.match(LOGIC, /asset: m\.kind === 'ASSET' && !reversed \? tr\('يحتاج إهلاكاً يسجّله المحاسب'\) : null/);
});

test('normalizePostedMove: حقول المستند والإطفاء بصالحها وحده — والقيد بلا مستند بمفاتيحه القديمة', () => {
  const docId = '11111111-1111-4111-8111-111111111111';
  const base = { id: 'p', moveId: 'm', moveNumber: 'MISC/1', ref: 'AI-x-1', kind: 'PREPAID', amount: 12000, date: '2026-11-01', summaryAr: 'إيجار سنوي', lines: [], reversed: false, createdAt: '', adminName: null };
  const m = normalizePostedMove({
    ...base, docId, hasAttachment: true, warnings: ['شهرٌ مؤجّل', ''],
    prepaid: { months: 12, postedMonths: 3, monthlyAmount: 1000, lastAmount: 1000, expenseCode: '621004', prepaidCode: '115002', nextDate: '2026-02-28', stopped: false, lockedMonths: ['2026-01', 'bad'] },
  })!;
  assert.equal(m.docId, docId);
  assert.equal(m.hasAttachment, true);
  assert.equal(m.prepaid?.postedMonths, 3);
  assert.deepEqual(m.prepaid?.lockedMonths, ['2026-01']);
  assert.deepEqual(m.warnings, ['شهرٌ مؤجّل']);
  const amort = normalizePostedMove({ ...base, kind: 'PREPAID_AMORT', amort: { parentPostId: 'pp', index: 4, months: 12 } })!;
  assert.deepEqual(amort.amort, { parentPostId: 'pp', index: 4, months: 12 });
  const bad = normalizePostedMove({ ...base, docId: 'not-a-uuid', hasAttachment: 'yes', prepaid: { months: 0 }, amort: { index: 1 } })!;
  for (const k of ['docId', 'hasAttachment', 'prepaid', 'amort', 'warnings']) assert.ok(!(k in bad), `${k} الفاسد يُسقط`);
  const plain = normalizePostedMove(base)!;
  assert.deepEqual(Object.keys(plain).sort(), Object.keys(base).sort(), 'قيدٌ بلا مستند بمفاتيحه القديمة حرفاً بحرف');
});

test('تقدّم الإطفاء ونهاياته: «تم إطفاء n من m»، وعكس قيد الدفع ينبّه إلى المرحّل، والمقفل مؤجّل، و«المستند» لما أُرفق', () => {
  assert.equal(prepaidProgressText({ postedMonths: 3, months: 12 }), 'تم إطفاء 3 من 12');
  assert.equal(prepaidStopText({ postedMonths: 3, stopped: false }, false), null, 'قيدٌ حيّ لا تنبيه');
  assert.equal(prepaidStopText({ postedMonths: 3, stopped: true }, false), 'عُكس قيد الدفع — راجع قيود الإطفاء المرحّلة (3)');
  assert.equal(prepaidStopText({ postedMonths: 2, stopped: false }, true), 'عُكس قيد الدفع — راجع قيود الإطفاء المرحّلة (2)', 'العكس من هذه البطاقة');
  assert.equal(prepaidStopText({ postedMonths: 0, stopped: true }, true), 'عُكس قيد الدفع — توقف الإطفاء');
  assert.equal(lockedMonthsText({ lockedMonths: [] }), null);
  assert.equal(lockedMonthsText({ lockedMonths: ['2026-01', '2026-02'] }), 'تأجل إطفاء 2026-01، 2026-02 لأن الفترة مقفلة');
  assert.equal(amortText({ index: 4, months: 12 }), 'الشهر 4 من 12');
  const docId = '11111111-1111-4111-8111-111111111111';
  assert.equal(moveDocId({ docId, hasAttachment: true }), docId);
  assert.equal(moveDocId({ docId }), docId, 'غياب hasAttachment لا يُخفي الرابط');
  assert.equal(moveDocId({ docId, hasAttachment: false }), null, 'ملفٌ لم يعد مرفقاً (تصفير الدفاتر)');
  assert.equal(moveDocId({}), null);
  // البطاقة: «المستند» يفتح العارض بمعرّف المستند (المحتوى من الخادم بصلاحية رؤية الدفاتر)، والتقدّم والتنبيهات من الدوال أعلاه
  assert.match(CARD, /const docId = moveDocId\(move\);/);
  assert.match(CARD, /\{docId && \(\s*<button[\s\S]*?onClick=\{\(\) => setViewing\(true\)\}[\s\S]*?\{tr\('المستند'\)\}/);
  assert.match(CARD, /<DocViewer doc=\{\{ id: docId, fileName: summaryName\(move, tr\), mimeType: '' \}\} onClose=\{\(\) => setViewing\(false\)\} \/>/);
  assert.match(CARD, /prepaidProgressText\(prepaid, tr\)/);
  assert.match(CARD, /const notes = moveNotes\(move, reversed, tr\);/, 'ملاحظات البطاقة من مصدرٍ واحد');
  assert.match(CARD, /\.\.\.notes\.other\.map\(w => tr\(w\)\)/, 'تنبيهٌ لا تعرفه البطاقة يمرّ بالمترجم');
  assert.doesNotMatch(CARD, /move\.warnings/, 'لا تُعرض تنبيهات الخادم خاماً بجانب ملاحظات البطاقة');
  assert.match(LOGIC, /\.\.\.postedDocFields\(x\),/);
});

test('moveNotes: كل ملاحظةٍ مرّة واحدة مترجمة — تنبيهات الخادم بالمعاني نفسها تُطوى، وعدد الأقساط الحيّة من الخادم', () => {
  const tr = (x: string) => `[${x}]`;
  const base = { kind: 'PREPAID' as const, prepaid: { posted: 3, months: 12, postedMonths: 3, stopped: false, nextDate: '2026-12-31', lockedMonths: [] as string[] } };
  // الأصل: الخادم يرسل «يحتاج إهلاكاً…» تنبيهاً والبطاقة تقولها ⇒ مرّة واحدة ومترجمة
  const asset = moveNotes({ kind: 'ASSET', warnings: ['يحتاج إهلاكاً يسجّله المحاسب'] }, false, tr);
  assert.deepEqual(asset, { asset: '[يحتاج إهلاكاً يسجّله المحاسب]', stop: null, locked: null, other: [] });
  assert.equal(moveNotes({ kind: 'ASSET' }, true).asset, null, 'الأصل المعكوس لا يحتاج إهلاكاً');
  // عكس قيد الدفع: عدد الأقساط من الخادم (الحيّة وحدها) يغلب المرحّل، والنصّ مترجمٌ مرّة واحدة
  const rev = moveNotes({ ...base, prepaid: { ...base.prepaid, stopped: true }, warnings: ['عُكس قيد الدفع — راجع قيود الإطفاء المرحّلة (2)'] }, true, tr);
  assert.deepEqual(rev, { asset: null, stop: '[عُكس قيد الدفع — راجع قيود الإطفاء المرحّلة ({n})]'.replace('{n}', '2'), locked: null, other: [] });
  // أوقفه الخادم بلا تنبيه ⇒ لا قسط حيّاً (عُكست الأقساط أيضاً) — لا «راجع (3)»
  assert.equal(moveNotes({ ...base, prepaid: { ...base.prepaid, stopped: true } }, true).stop, 'عُكس قيد الدفع — توقف الإطفاء');
  // عُكس من هذه البطاقة الآن (قبل تحديث القائمة): المرحّل أفضل ما نعرف
  assert.equal(moveNotes(base, true).stop, 'عُكس قيد الدفع — راجع قيود الإطفاء المرحّلة (3)');
  assert.equal(moveNotes(base, false).stop, null, 'قيدٌ حيّ لا تنبيه عكس');
  // تنبيه العكس وحده يكفي ولو غاب جدول التقدّم
  assert.equal(moveNotes({ kind: 'PREPAID', warnings: ['عُكس قيد الدفع — راجع قيود الإطفاء المرحّلة (4)'] }, true).stop, 'عُكس قيد الدفع — راجع قيود الإطفاء المرحّلة (4)');
  // الشهر المقفل: من lockedMonths ومن تنبيه الخادم معاً بلا تكرار، ولا يُذكر للمعكوس
  const lockedWarn = 'الفترة مقفلة فلم يُرحَّل قسط الإطفاء بتاريخ 2026-12-31؛ يُرحَّل تلقائياً بعد فتحها';
  const locked = moveNotes({ ...base, prepaid: { ...base.prepaid, lockedMonths: ['2026-12'] }, warnings: [lockedWarn] }, false, tr);
  assert.deepEqual(locked, { asset: null, stop: null, locked: '[تأجل إطفاء {months} لأن الفترة مقفلة]'.replace('{months}', '2026-12'), other: [] });
  assert.equal(moveNotes({ ...base, warnings: [lockedWarn] }, false).locked, 'تأجل إطفاء 2026-12 لأن الفترة مقفلة', 'من التنبيه وحده');
  assert.equal(moveNotes({ ...base, prepaid: { ...base.prepaid, stopped: true, lockedMonths: ['2026-12'] }, warnings: [lockedWarn] }, true).locked, null);
  // تنبيهٌ لا تعرفه البطاقة يبقى كما هو (والبطاقة تمرّره بالمترجم)
  assert.deepEqual(moveNotes({ kind: 'EXPENSE', warnings: ['تنبيهٌ جديد'] }, false).other, ['تنبيهٌ جديد']);
});

// ─── الترجمات ───

/**
 * العبارات التي أضافتها حزمة C3 — مدموجةٌ في القاموس (strings.ts، قسم «المحاسب الذكي AI — حزمة C3»). القائمة تُبقي حارس
 * «لا عبارة ميتة»: كلٌّ منها مستعملٌ في ملفات الحزمة، وترجماتها الأربع من القاموس نفسه لا نسخةٌ تنحرف عنه.
 */
export const C3_PHRASES: readonly string[] = [
  'رواتب', 'سداد مستحق', 'بلا رقم', 'بطلب {name}', 'قيد العكس', 'فتح في الدفاتر', 'مثال: المبلغ مسجل خطأ',
  'أول تاريخ مفتوح: {date}', 'العكس بتاريخ {date}', 'جارٍ العكس…', 'تأكيد العكس', 'تاريخ العكس ضمن فترة مقفلة',
  'عكس القيود يحتاج صلاحية «إنشاء القيود وترحيلها»', 'لا توجد قيود سجّلها المحاسب الذكي بعد',
  'اطلب من المحاسب تسجيل مصروف أو رواتب وستظهر قيوده هنا، ويمكنك عكس أي قيد منها',
  'القيود التي سجّلها المحاسب الذكي — الأحدث أولاً',
  'تُعرض أحدث {n} قيداً — الأقدم تجده في قيود اليومية بالبحث عن مرجعه',
];

/** عبارات قيود المستندات (المقدّم وإطفاؤه والأصل) في ملفات هذه الحزمة */
export const DOC_POSTS_PHRASES: readonly string[] = [
  'إيجار/مصروف مقدّم', 'إطفاء شهري', 'تم إطفاء {n} من {m}', 'عُكس قيد الدفع — راجع قيود الإطفاء المرحّلة ({n})',
  'عُكس قيد الدفع — توقف الإطفاء', 'تأجل إطفاء {months} لأن الفترة مقفلة', 'الشهر {n} من {m}', 'الإطفاء التالي {date}',
];

const ARABIC = /[؀-ۿ]/;

test('الترجمات: كل tr(\'…\') في ملفات الحزمة في القاموس، ولا عبارة زائدة', () => {
  const used = new Set<string>();
  for (const s of [CARD, LIST, LOGIC]) {
    for (const m of s.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) if (ARABIC.test(m[1])) used.add(m[1]);
  }
  assert.ok(used.size >= 30, `عبارات أقلّ من المتوقّع (${used.size})`);
  const missing = [...used].filter((k) => !PHRASES[k]);
  assert.deepEqual(missing, [], `بلا ترجمة: ${missing.join(' | ')}`);
  const unused = [...C3_PHRASES, ...DOC_POSTS_PHRASES].filter((k) => !used.has(k));
  assert.deepEqual(unused, [], `عبارات غير مستعملة: ${unused.join(' | ')}`);
});

test('الترجمات: أربع لغات غير فارغة، بلا عربية متسرّبة، والفرنسية بـ’ لا \'، والعناصر النائبة محفوظة', () => {
  for (const k of [...C3_PHRASES, ...DOC_POSTS_PHRASES]) {
    const v = PHRASES[k];
    assert.ok(v, `${k} غائب عن القاموس`);
    assert.deepEqual(Object.keys(v).sort(), ['en', 'fr', 'tr', 'zh'], k);
    const holes = (k.match(/\{\w+\}/g) ?? []).sort();
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) {
      assert.ok(v[l].trim().length > 0, `${k}.${l} فارغ`);
      assert.doesNotMatch(v[l], ARABIC, `${k}.${l} فيه عربية`);
      assert.deepEqual((v[l].match(/\{\w+\}/g) ?? []).sort(), holes, `${k}.${l} العناصر النائبة`);
    }
    assert.ok(!v.fr.includes("'"), `${k}.fr فيه فاصلة عليا لاتينية`);
  }
});
