// «قيود المحاسب الذكي» (حزمة C3): المنطق الصرف لبطاقة القيد وقائمته (aiPosts.ts) وحرّاسٌ نصّية على توصيلهما — العكس عبر
// مسار الدفاتر القائم وحده والسبب إلزامي، إبطال مفتاح القائمة المشترك، الزرّ معطّل للمعكوس، التواريخ الميلادية،
// والترجمات الأربع لكل عبارة في القاموس (عبارات الحزمة مدموجةٌ فيه — C3_PHRASES أدناه).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  POSTS_LIMIT, POSTS_QUERY_KEY, REVERSE_REASON_MAX, cleanReason, isMobilePath, ledgerMoveHref, normalizePostedMove,
  normalizePostsResponse, postedKindLabel, postedKindTone, reasonValid, reverseBody, reverseErrorInfo, reverseOutcome,
  reverseSuccessText,
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

const ARABIC = /[؀-ۿ]/;

test('الترجمات: كل tr(\'…\') في ملفات الحزمة في القاموس، ولا عبارة زائدة', () => {
  const used = new Set<string>();
  for (const s of [CARD, LIST, LOGIC]) {
    for (const m of s.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) if (ARABIC.test(m[1])) used.add(m[1]);
  }
  assert.ok(used.size >= 30, `عبارات أقلّ من المتوقّع (${used.size})`);
  const missing = [...used].filter((k) => !PHRASES[k]);
  assert.deepEqual(missing, [], `بلا ترجمة: ${missing.join(' | ')}`);
  const unused = C3_PHRASES.filter((k) => !used.has(k));
  assert.deepEqual(unused, [], `عبارات غير مستعملة: ${unused.join(' | ')}`);
});

test('الترجمات: أربع لغات غير فارغة، بلا عربية متسرّبة، والفرنسية بـ’ لا \'، والعناصر النائبة محفوظة', () => {
  for (const k of C3_PHRASES) {
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
