// «المحاسب الذكي AI» — غلاف المحادثة: المنطق الصرف (lib/aiAccountant.ts) وحرّاسٌ نصّية على توصيله: جسم الطلب (≤١٢ رسالة،
// الأخيرة للمستخدم، مرجع UUID)، القوالب وإخفاء قوالب الترحيل بلا canPost، مسارات الواجهة البرمجية، ترجمة أخطاء الخادم،
// والترجمات الأربع لكل عبارة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BLANK, MAX_MESSAGES, MAX_TEXT, TEMPLATES, browserToday, buildChatBody, chatErrorInfo, currencyWord, firstBlankRange, hasBlank,
  historyForRequest, isBlockingError, isUuid, isValidDay, markReversed, monthStartOf, newClientRef, normalizeChatResponse,
  normalizeStatus, plainText, prevMonthOf, rangeError, statusLine, templateText, visibleTemplates,
  type ChatEntry, type PostedMove,
} from '../../lib/aiAccountant';
import { PHRASES } from '../../i18n/strings';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const arTr = (s: string) => s;
const LANGS = ['en', 'fr', 'tr', 'zh'] as const;
const trOf = (l: typeof LANGS[number]) => (s: string) => PHRASES[s]?.[l] ?? s;

let seq = 0;
const u = (text: string, over: Partial<ChatEntry> = {}): ChatEntry => ({ id: `u${++seq}`, role: 'user', text, clientRef: newClientRef(), ...over });
const a = (text: string, over: Partial<ChatEntry> = {}): ChatEntry => ({ id: `a${++seq}`, role: 'assistant', text, ...over });
const axiosErr = (status: number, data: Record<string, unknown> = {}) => ({ isAxiosError: true, response: { status, data } });

// ─── جسم الطلب ───

test('السياق: آخر ١٢ رسالة والأخيرة للمستخدم، بلا إشعارات الخطأ ولا الفاشلة ولا الفارغة، وكلٌّ مقصوص إلى ٤٠٠٠', () => {
  const entries: ChatEntry[] = [];
  for (let i = 0; i < 10; i++) entries.push(u(`سؤال ${i}`), a(`جواب ${i}`));
  entries.push(u('x'.repeat(MAX_TEXT + 500)));
  const h = historyForRequest(entries)!;
  assert.equal(h.length, MAX_MESSAGES);
  assert.equal(MAX_MESSAGES, 12);
  assert.equal(h[h.length - 1].role, 'user');
  assert.equal(h[h.length - 1].text.length, MAX_TEXT, 'النصّ الطويل مقصوصٌ إلى حدّ الخادم');
  assert.equal(h[0].text, 'جواب 4', 'أقدم ما يُرسَل هو الثاني عشر من الآخر');

  const failed = u('فشلت', { failed: true });
  const errNote = a('', { error: 'المحاسب مشغول، حاول بعد دقيقة', retryable: true });
  const withNoise = [u('أول'), a('رد'), failed, errNote, a('   '), u('ثانٍ')];
  assert.deepEqual(historyForRequest(withNoise), [
    { role: 'user', text: 'أول' }, { role: 'assistant', text: 'رد' }, { role: 'user', text: 'ثانٍ' },
  ], 'الفاشلة وإشعار الخطأ والفارغة خارج السياق');

  // إعادة المحاولة: الرسالة الفاشلة نفسها تدخل حين تُعاد (وهي الأخيرة)
  const retrying = [u('أول'), a('رد'), failed];
  assert.deepEqual(historyForRequest(retrying, failed.id)?.map(m => m.text), ['أول', 'رد', 'فشلت']);
  assert.equal(historyForRequest(retrying), null, 'بلا إذنٍ صريح: الأخيرة ليست للمستخدم ⇒ لا إرسال');
  assert.equal(historyForRequest([u('س'), a('ج')]), null, 'آخر رسالة للمحاسب ⇒ لا إرسال (الخادم يرفضه)');
  assert.equal(historyForRequest([]), null);
});

test('جسم الطلب {messages, clientRef} — المرجع UUID إلزامي، وجديدٌ لكل إرسال، والإعادة بالمرجع نفسه', () => {
  const ref = newClientRef();
  assert.ok(isUuid(ref), ref);
  assert.notEqual(newClientRef(), ref, 'مرجعٌ جديد لكل إرسال');
  const body = buildChatBody([u('كم بعنا هذا الشهر؟')], ref)!;
  assert.deepEqual(Object.keys(body).sort(), ['clientRef', 'messages']);
  assert.equal(body.clientRef, ref);
  assert.deepEqual(body.messages, [{ role: 'user', text: 'كم بعنا هذا الشهر؟' }]);
  for (const m of body.messages) assert.deepEqual(Object.keys(m).sort(), ['role', 'text'], 'لا حقول محلية (id/clientRef/error) في الجسم');
  assert.equal(buildChatBody([u('س')], 'not-a-uuid'), null);
  assert.equal(buildChatBody([u('س')], ''), null);

  // الإعادة: رسالة المستخدم الفاشلة تحمل مرجعها — والجسم المُعاد بالمرجع نفسه (الخادم يمنع تكرار الترحيل بـref مشتقّ منه)
  const failed = u('دفعنا 500 ريال إيجار نقداً', { failed: true });
  const again = buildChatBody([failed], failed.clientRef!, failed.id)!;
  assert.equal(again.clientRef, failed.clientRef);
  // والمكوّن يمرّر مرجع الرسالة المُعادة لا مرجعاً جديداً
  const chat = read('components', 'aiAccountant', 'AiAccountantChat.tsx');
  assert.match(chat, /buildChatBody\(all, user\.clientRef, user\.id\)/);
  assert.match(chat, /clientRef: newClientRef\(\)/, 'رسالة جديدة ⇒ مرجع جديد');
  assert.match(chat, /const retry = [\s\S]*?void run\(entries\.filter\(e => e\.id !== errorId\), user\)/, 'الإعادة بالرسالة نفسها (مرجعها معها)');
});

test('المولّد UUID v4 حتى بلا crypto.randomUUID', () => {
  const g = globalThis as { crypto?: Crypto };
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: (b: Uint8Array) => { for (let i = 0; i < b.length; i++) b[i] = (i * 37) & 255; return b; } }, configurable: true });
    assert.ok(isUuid(newClientRef()));
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    assert.ok(isUuid(newClientRef()));
  } finally {
    if (desc) Object.defineProperty(globalThis, 'crypto', desc); else delete g.crypto;
  }
});

test('ردّ الخادم يُطبَّع دفاعياً — حقلٌ غائب لا يُسقط الصفحة', () => {
  assert.deepEqual(normalizeChatResponse(undefined), { text: '', guard: 'PASS', turnId: null, reports: [], posted: [], warnings: [] });
  const r = normalizeChatResponse({
    text: 'تم', guard: 'TRIM', turnId: 't1',
    reports: [{ kind: 'sales', title: 'ملخص', period: null, currency: 'SAR', sections: [], notes: [] }, { bogus: 1 }],
    posted: [{ moveId: 'm1', lines: [] }, null], warnings: ['تنبيه', '', 3],
  });
  assert.equal(r.reports.length, 1);
  assert.equal(r.posted.length, 1);
  assert.deepEqual(r.warnings, ['تنبيه']);
  assert.equal(r.turnId, 't1');
});

test('عكس القيد يَسِم البطاقة في كل فقاعة ولا يمسّ غيرها', () => {
  const mv = (moveId: string): PostedMove => ({
    id: moveId, moveId, moveNumber: 'JV/1', ref: 'AI-x-1', kind: 'EXPENSE', amount: 500, date: '2026-11-18', summaryAr: 'إيجار',
    lines: [], reversed: false, createdAt: '2026-11-18T10:00:00Z', adminName: 'علي',
  });
  const entries = [u('س'), a('ج', { posted: [mv('m1'), mv('m2')] }), a('ج2')];
  const out = markReversed(entries, 'm1');
  assert.equal(out[1].posted![0].reversed, true);
  assert.equal(out[1].posted![1].reversed, false);
  assert.equal(out[2], entries[2], 'فقاعةٌ بلا القيد تبقى هي نفسها');
  assert.equal(entries[1].posted![0].reversed, false, 'بلا تعديلٍ في المكان');
});

// ─── القوالب ───

test('القوالب بترتيب العقد، وقوالب الترحيل لمن يرحّل وحده', () => {
  assert.deepEqual(TEMPLATES.map(t => t.label), [
    'قائمة دخل هذا الشهر', 'قائمة دخل الشهر الماضي', 'كم الربح هذا الشهر', 'قوائم مالية من تاريخ إلى تاريخ', 'ميزان المراجعة',
    'ملخص المبيعات هذا الشهر', 'التحصيل هذا الشهر', 'المشتريات والمخزون', 'ذمم العملاء', 'مصروفات هذا الشهر',
    'سجّل مصروف', 'سجّل رواتب',
  ]);
  const posting = TEMPLATES.filter(t => t.posting).map(t => t.id);
  assert.deepEqual(posting, ['post-expense', 'post-salaries']);
  const ids = (s: Parameters<typeof visibleTemplates>[0]) => visibleTemplates(s).map(t => t.id);
  assert.ok(ids({ canPost: true, booksActivated: true }).includes('post-expense'));
  assert.ok(ids({ canPost: true, booksActivated: true }).includes('post-salaries'));
  assert.equal(ids({ canPost: false, booksActivated: true }).some(id => posting.includes(id)), false, 'بلا canPost لا ترحيل');
  assert.equal(ids(null).some(id => posting.includes(id)), false, 'قبل وصول الحالة لا ترحيل');
  // ما لا بديل تشغيلي له (ميزان المراجعة، المصروفات) يحتاج الدفاتر
  assert.deepEqual(ids({ canPost: false, booksActivated: false }), [
    'income-this-month', 'income-last-month', 'profit-this-month', 'statements-range', 'sales-this-month',
    'collections-this-month', 'purchases-inventory', 'receivables',
  ]);
  assert.equal(ids({ canPost: true, booksActivated: true }).length, TEMPLATES.length);
  // علمان غائبان (حالةٌ جزئية) لا يُخفيان شيئاً، وصريحان مسموحان كغيابهما
  assert.equal(ids({ canPost: true, booksActivated: true, canViewLedger: true, warehouseOn: true }).length, TEMPLATES.length);
  assert.ok(ids({ canPost: false, booksActivated: true }).includes('income-this-month'), 'رؤية الدفاتر المجهولة لا تُخفي');
});

test('القوالب بلا أداةٍ خلفها لا تظهر: تقارير الدفاتر لمن لا يراها والدفاتر مفعّلة، والمخزون لشركةٍ لم تفعّله', () => {
  const ids = (s: Parameters<typeof visibleTemplates>[0]) => visibleTemplates(s).map(t => t.id);
  const ledger = ['income-this-month', 'income-last-month', 'profit-this-month', 'statements-range', 'trial-balance', 'expenses-this-month'];
  assert.deepEqual(TEMPLATES.filter(t => t.needsLedgerView).map(t => t.id), ledger);
  // canViewReports بلا canViewLedger والدفاتر مفعّلة: buildLedgerReadTools فارغة ⇒ الستّة مخفيّة
  assert.deepEqual(ids({ canPost: false, booksActivated: true, canViewLedger: false, warehouseOn: true }), [
    'sales-this-month', 'collections-this-month', 'purchases-inventory', 'receivables',
  ]);
  // بلا دفاتر: التقدير التشغيلي (profit_estimate) يغطّي الربح والدخل ⇒ لا تُخفى بغياب رؤية الدفاتر
  assert.deepEqual(ids({ canPost: false, booksActivated: false, canViewLedger: false, warehouseOn: true }), [
    'income-this-month', 'income-last-month', 'profit-this-month', 'statements-range', 'sales-this-month',
    'collections-this-month', 'purchases-inventory', 'receivables',
  ]);
  // شركةٌ بلا مخزون: purchases_inventory لا تُبنى ⇒ الشريحة مخفيّة
  assert.equal(ids({ canPost: true, booksActivated: true, canViewLedger: true, warehouseOn: false }).includes('purchases-inventory'), false);
  assert.equal(ids({ canPost: true, booksActivated: true, canViewLedger: true, warehouseOn: false }).length, TEMPLATES.length - 1);
  assert.deepEqual(TEMPLATES.filter(t => t.needsWarehouse).map(t => t.id), ['purchases-inventory']);
});

test('قوالب: «من تاريخ إلى تاريخ» خانتا تاريخ، والترحيل يملأ الخانة', () => {
  // «من تاريخ إلى تاريخ» يفتح خانتي تاريخ، والترحيل يملأ الخانة ولا يُرسَل
  assert.equal(TEMPLATES.find(t => t.id === 'statements-range')?.mode, 'range');
  for (const t of TEMPLATES.filter(x => x.posting)) assert.equal(t.mode, 'prefill', t.id);
});

test('نصوص القوالب: الشهر الماضي بالأرقام (عبر رأس السنة)، والفترة صريحة، وقوالب الترحيل بفراغٍ يكمله المستخدم', () => {
  const ctx = { todayLocal: '2026-11-18', currency: 'SAR' };
  const byId = (id: string) => TEMPLATES.find(t => t.id === id)!;
  assert.equal(templateText(byId('income-last-month'), ctx, arTr), 'اعرض قائمة الدخل للشهر الماضي (2026-10)');
  assert.equal(templateText(byId('income-last-month'), { todayLocal: '2027-01-03' }, arTr), 'اعرض قائمة الدخل للشهر الماضي (2026-12)');
  assert.equal(templateText(byId('statements-range'), { ...ctx, range: { from: '2026-01-01', to: '2026-03-31' } }, arTr),
    'اعرض القوائم المالية (قائمة الدخل والمركز المالي) من 2026-01-01 إلى 2026-03-31');
  assert.equal(templateText(byId('statements-range'), ctx, arTr),
    'اعرض القوائم المالية (قائمة الدخل والمركز المالي) من 2026-11-01 إلى 2026-11-18', 'بلا فترة: أول الشهر حتى اليوم');
  const exp = templateText(byId('post-expense'), ctx, arTr);
  assert.equal(exp, 'دفعنا … ريال إيجار نقداً');
  const sal = templateText(byId('post-salaries'), ctx, arTr);
  assert.equal(sal, 'رواتب شهر … مبلغ … تحويل بنكي');
  assert.ok(hasBlank(exp) && hasBlank(sal), 'لا يُرسَل قبل إكمال الفراغ');
  assert.deepEqual(firstBlankRange(exp), [exp.indexOf(BLANK), exp.indexOf(BLANK) + 1]);
  assert.deepEqual(firstBlankRange('بلا فراغ'), [8, 8]);
  assert.equal(templateText(byId('post-expense'), { todayLocal: '2026-11-18', currency: 'AED' }, arTr), 'دفعنا … درهم إيجار نقداً');
  assert.equal(currencyWord('KWD', arTr), 'دينار');
  assert.equal(currencyWord('EGP', arTr), 'جنيه');
  assert.equal(currencyWord('USD', arTr), 'USD', 'عملةٌ لا نعرف كلمتها برمزها');
  assert.equal(currencyWord(null, arTr), 'ريال');
  // كل قالبٍ له نصّ
  for (const t of TEMPLATES) assert.ok(templateText(t, ctx, arTr).trim(), t.id);
  // «كم الربح»: بالدفاتر «صافي الربح» (قائمة الدخل)، وبلاها «الربح الإجمالي التقديري» — أداة التقدير بلا مصروفات ولا رواتب
  assert.equal(templateText(byId('profit-this-month'), { ...ctx, booksActivated: true }, arTr), 'كم صافي الربح هذا الشهر؟');
  assert.equal(templateText(byId('profit-this-month'), { ...ctx, booksActivated: false }, arTr), 'كم الربح الإجمالي التقديري هذا الشهر؟');
  assert.doesNotMatch(templateText(byId('profit-this-month'), ctx, arTr), /صافي/, 'حالةٌ مجهولة لا تسأل عن الصافي');
  const chat = read('components', 'aiAccountant', 'AiAccountantChat.tsx');
  assert.equal((chat.match(/booksActivated: status\?\.booksActivated/g) ?? []).length, 2, 'القالب المرسَل وذو الفترة يمرّران حال الدفاتر');
  // يومٌ فاسد من الخادم لا يُنتج «NaN»
  assert.doesNotMatch(templateText(byId('income-last-month'), { todayLocal: 'bad' }, arTr), /NaN/);
});

test('التواريخ: يومٌ صالح، الشهر السابق، والفترة', () => {
  assert.ok(isValidDay('2026-02-28'));
  assert.ok(isValidDay('2028-02-29'));
  assert.ok(!isValidDay('2026-02-29'));
  assert.ok(!isValidDay('2026-13-01'));
  assert.ok(!isValidDay('2026-1-01'));
  assert.ok(!isValidDay(undefined));
  assert.equal(prevMonthOf('2026-01-15'), '2025-12');
  assert.equal(prevMonthOf('2026-10-01'), '2026-09');
  assert.equal(monthStartOf('2026-11-18'), '2026-11-01');
  assert.equal(rangeError('2026-11-01', '2026-11-18'), null);
  assert.equal(rangeError('2026-11-18', '2026-11-18'), null, 'يومٌ واحد فترةٌ صالحة');
  assert.equal(rangeError('2026-11-19', '2026-11-18'), 'reversed');
  assert.equal(rangeError('', '2026-11-18'), 'missing');
  assert.equal(rangeError('2026-02-30', '2026-03-01'), 'invalid');
  assert.equal(browserToday(new Date(2026, 9, 21, 0, 30)), '2026-10-21', 'تقويم المتصفّح المحلي لا UTC');
});

// ─── الحالة ───

test('شريط الحالة: يرحّل / قراءة فقط بلا دفاتر / قراءة فقط لحساب بلا ترحيل', () => {
  assert.deepEqual(statusLine({ canPost: true, booksActivated: true }), { tone: 'post', text: 'الدفاتر مفعّلة — يسجّل القيود' });
  assert.deepEqual(statusLine({ canPost: false, booksActivated: false }), { tone: 'read-only', text: 'قراءة فقط — فعّل الدفاتر لتسجيل المصروفات' });
  assert.equal(statusLine({ canPost: true, booksActivated: false }).tone, 'read-only', 'بلا دفاتر لا ترحيل ولو قال الخادم غير ذلك');
  assert.equal(statusLine({ canPost: false, booksActivated: true }).tone, 'read-books');
  const s = normalizeStatus({ enabled: true, canPost: 'yes', booksMode: 'WEIRD', booksActivated: true, currency: '', todayLocal: '2026-11-18', companyName: '  ' })!;
  assert.equal(s.canPost, false, 'canPost بـtrue صريحة وحدها');
  assert.equal(s.booksMode, 'NONE');
  assert.equal(s.currency, 'SAR');
  assert.equal(s.companyName, null);
  assert.equal(s.todayLocal, '2026-11-18');
  assert.equal(normalizeStatus(null), null);
  // رؤية الدفاتر والمخزون: قيمة الخادم أولاً، ثم احتياط الواجهة، ثم «مسموح»
  const base = { enabled: true, canPost: false, booksActivated: true, currency: 'SAR', todayLocal: '2026-11-18' };
  const fromServer = normalizeStatus({ ...base, canViewLedger: false, warehouseOn: false }, { canViewLedger: true, warehouseOn: true })!;
  assert.equal(fromServer.canViewLedger, false);
  assert.equal(fromServer.warehouseOn, false);
  const fromFallback = normalizeStatus(base, { canViewLedger: false, warehouseOn: false })!;
  assert.equal(fromFallback.canViewLedger, false, 'خادمٌ لا يرسل العلم ⇒ صلاحيات الجلسة');
  assert.equal(fromFallback.warehouseOn, false, 'خادمٌ لا يرسل العلم ⇒ علم الشركة');
  const unknown = normalizeStatus({ ...base, canViewLedger: 'yes' })!;
  assert.equal(unknown.canViewLedger, true, 'علمٌ مجهول بلا احتياط ⇒ لا يُخفى شيء');
  assert.equal(unknown.warehouseOn, true);
});

// ─── أخطاء الخادم ───

test('ترجمة الأخطاء: ٤٢٩ مشغول/حدّ يومي، ٥٠٣ متوقف، رموز ٤٠٣ بإشعاراتٍ واضحة، والشبكة', () => {
  assert.deepEqual(chatErrorInfo(axiosErr(429, { code: 'AI_LLM_RATE_LIMIT' })), { kind: 'busy', message: 'المحاسب مشغول، حاول بعد دقيقة', retryable: true });
  assert.equal(chatErrorInfo(axiosErr(429)).message, 'المحاسب مشغول، حاول بعد دقيقة');
  const daily = chatErrorInfo(axiosErr(429, { code: 'AI_ACCOUNTANT_DAILY_LIMIT' }));
  assert.equal(daily.kind, 'limit');
  assert.equal(daily.retryable, false, 'الحدّ اليومي لا تفيده الإعادة');
  for (const code of ['AI_ACCOUNTANT_OFF', 'AI_LLM_NOT_CONFIGURED', 'AI_LLM_TIMEOUT', undefined]) {
    assert.equal(chatErrorInfo(axiosErr(503, { code })).message, 'المحاسب متوقف مؤقتاً', String(code));
  }
  assert.equal(chatErrorInfo(axiosErr(503, { code: 'AI_ACCOUNTANT_OFF' })).retryable, false, 'مفتاح الإطفاء لا تفيده الإعادة');
  assert.equal(chatErrorInfo(axiosErr(503, { code: 'AI_LLM_TIMEOUT' })).retryable, true, 'تعذّر النموذج العابر تفيده الإعادة');
  const k = (code?: string) => chatErrorInfo(axiosErr(403, { code })).kind;
  assert.equal(k('AI_ACCOUNTANT_NOT_ALLOWED'), 'not-enabled');
  assert.equal(k('ACCOUNTING_NOT_ALLOWED'), 'accounting-off');
  assert.equal(k('AI_ACCOUNTANT_SCOPED'), 'scoped');
  assert.equal(k(), 'forbidden', '٤٠٣ بلا رمز = صلاحية التقارير');
  assert.equal(chatErrorInfo(axiosErr(403)).message, 'لا تملك صلاحية التقارير اللازمة للمحاسب الذكي');
  assert.equal(chatErrorInfo(axiosErr(403, { code: 'AI_ACCOUNTANT_ADMIN_ONLY' })).message, 'المحاسب الذكي لإدارة الشركة وحدها');
  for (const kind of ['not-enabled', 'accounting-off', 'scoped', 'forbidden'] as const) assert.ok(isBlockingError(kind), kind);
  for (const kind of ['busy', 'limit', 'off', 'network', 'generic', 'bad-request'] as const) assert.ok(!isBlockingError(kind), kind);
  assert.equal(chatErrorInfo(new Error('Network Error')).kind, 'network');
  assert.equal(chatErrorInfo(null).kind, 'network');
  // ٤٠٠ zod رسالته تقنية («بيانات غير صحيحة messages») — عبارتنا المترجمة بدلها
  assert.equal(chatErrorInfo(axiosErr(400, { message: 'بيانات غير صحيحة messages' })).message, 'تعذر فهم الطلب — أعد صياغة رسالتك');
  assert.equal(chatErrorInfo(axiosErr(400)).kind, 'bad-request');
  assert.equal(chatErrorInfo(axiosErr(500)).kind, 'generic');
});

test('نصّ الردّ: تُنزع علامات Markdown وتبقى الأسطر', () => {
  assert.equal(plainText('**الإجمالي**: 1,200\n\n\n\n# ملاحظة\n- بند\n* آخر'), 'الإجمالي: 1,200\n\nملاحظة\n• بند\n• آخر');
  assert.equal(plainText('-500 ريال'), '-500 ريال', 'رقمٌ سالب في أول السطر ليس بنداً');
  assert.equal(plainText('<b>x</b>'), '<b>x</b>', 'لا تفسير HTML — React يهرّبه');
});

// ─── التوصيل ───

test('الواجهة البرمجية: الحالة والمحادثة والقيود بمساراتها، وحدّ القيود ٥٠ افتراضياً', () => {
  const c = read('api', 'client.ts');
  const block = c.slice(c.indexOf('export const aiAccountantApi'), c.indexOf('};', c.indexOf('export const aiAccountantApi')));
  assert.match(block, /status: \(\) => api\.get\('\/ai-accountant\/status'\)/);
  assert.match(block, /chat: \(body: AiAccountantChatRequest\) => api\.post\('\/ai-accountant\/chat', body\)/);
  assert.match(block, /posts: \(limit = 50\) => api\.get\('\/ai-accountant\/posts', \{ params: \{ limit \} \}\)/);
});

test('المحادثة ترسم بطاقات التقرير والقيد وقائمة القيود من مكوّنات العقد، والتبويب لمن يرحّل', () => {
  const chat = read('components', 'aiAccountant', 'AiAccountantChat.tsx');
  const bubbles = read('components', 'aiAccountant', 'chat', 'ChatBubbles.tsx');
  assert.match(bubbles, /import ReportCard from '\.\.\/report\/ReportCard'/);
  assert.match(bubbles, /import PostedMoveCard from '\.\.\/posts\/PostedMoveCard'/);
  assert.match(bubbles, /<ReportCard report=\{r\} \/>/);
  assert.match(bubbles, /<PostedMoveCard move=\{m\} onReversed=\{\(\) => onReversed\(m\.moveId\)\} \/>/);
  assert.match(chat, /import AiPostsList from '\.\/posts\/AiPostsList'/);
  // التبويب لمن يرى الدفاتر المفعّلة (السجلّ) — لا canPost: مفتاح الإطفاء أو صلاحية العرض وحدها كانا يُخفيان القيود وزرّ العكس
  assert.match(chat, /const showPosts = status\?\.booksActivated === true && status\?\.canViewLedger === true/);
  assert.doesNotMatch(chat, /showPosts = status\?\.canPost/);
  // احتياط رؤية الدفاتر بمسند الخادم (canLedger وجلسة المالك) والمخزون من علم الشركة
  assert.match(chat, /canViewLedger: ownerSession \|\| canLedger\(user, 'canViewLedger'\)/);
  assert.match(chat, /warehouseOn: companyWarehouse/);
  assert.match(chat, /<AiPostsList \/>/);
  assert.match(chat, /queryKey: POSTS_KEY/);
  assert.match(chat, /const POSTS_KEY = \['ai-accountant-posts'\] as const/, 'مفتاح قائمة القيود كما في العقد');
  assert.match(chat, /export default function AiAccountantChat\(\{ compact = false \}: \{ compact\?: boolean \}\)/);
  assert.match(read('pages', 'AiAccountantPage.tsx'), /<AiAccountantChat \/>/);
  // فحص الفراغ «…» لنصّ قالب الترحيل وحده (لوحة الآيفون تحوّل «...» إلى «…»)، وشريحة القالب لا تمحو مسوّدة الخانة
  assert.match(chat, /if \(fromInput && fromTemplate && hasBlank\(text\)\)/);
  assert.match(chat, /send\(input, true\)/);
  assert.match(chat, /if \(t\.mode === 'prefill'\) \{\s*setInput\(text\);\s*setFromTemplate\(true\);/);
  assert.match(chat, /\n    send\(text\);\n  \};/, 'القالب المرسَل فوراً يمرّ بلا fromInput');
  // المحادثة في الذاكرة وحدها — لا تخزين
  for (const f of [chat, bubbles, read('lib', 'aiAccountant.ts')]) assert.doesNotMatch(f, /localStorage|sessionStorage|indexedDB/);
});

// ─── الترجمات ───

test('كل عبارة بالترجمات الأربع، والقوالب تُحقن قيمها بعد الترجمة، والفرنسية بلا فاصلةٍ عليا مستقيمة', () => {
  const files = [
    ['components', 'aiAccountant', 'AiAccountantChat.tsx'], ['components', 'aiAccountant', 'chat', 'ChatBubbles.tsx'],
    ['components', 'aiAccountant', 'chat', 'TemplateBar.tsx'], ['pages', 'AiAccountantPage.tsx'], ['lib', 'aiAccountant.ts'],
  ];
  const phrases = new Set<string>();
  for (const f of files) for (const m of read(...f).matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) phrases.add(m[1]);
  // العبارات التي تمرّ بـtr(متغيّر) فلا يلتقطها حارس القاموس الحرفيّ
  for (const t of TEMPLATES) phrases.add(t.label);
  for (const s of [{ canPost: true, booksActivated: true }, { canPost: false, booksActivated: false }, { canPost: false, booksActivated: true }]) phrases.add(statusLine(s).text);
  for (const e of [axiosErr(429), axiosErr(429, { code: 'AI_ACCOUNTANT_DAILY_LIMIT' }), axiosErr(503), axiosErr(403), axiosErr(400), axiosErr(500), null,
    axiosErr(403, { code: 'AI_ACCOUNTANT_NOT_ALLOWED' }), axiosErr(403, { code: 'ACCOUNTING_NOT_ALLOWED' }), axiosErr(403, { code: 'AI_ACCOUNTANT_SCOPED' }),
    axiosErr(403, { code: 'AI_ACCOUNTANT_ADMIN_ONLY' })]) {
    phrases.add(chatErrorInfo(e).message);
  }
  phrases.add('أكمل الفراغات (…) قبل الإرسال');
  phrases.add('تعذر تحميل حالة المحاسب الذكي');
  phrases.add('المحادثة');
  phrases.add('قيود المحاسب الذكي');
  assert.ok(phrases.size > 60, `عددٌ أقلّ من المتوقّع: ${phrases.size}`);
  for (const p of phrases) {
    const row = PHRASES[p];
    assert.ok(row, `بلا ترجمة: ${p}`);
    for (const l of LANGS) {
      assert.ok(row[l]?.trim(), `${p} / ${l}`);
      assert.doesNotMatch(row[l], /[؀-ۿ]/, `نصٌّ عربي متسرّب: ${p} / ${l}`);
    }
    assert.doesNotMatch(row.fr, /'/, `الفرنسية بـ’ لا ': ${p}`);
    // العناصر النائبة تبقى في كل لغة
    for (const ph of p.match(/\{[a-z]+\}/g) ?? []) for (const l of LANGS) assert.ok(row[l].includes(ph), `${p} / ${l} بلا ${ph}`);
  }
  // نصوص القوالب مترجمةً كاملةً بلا عربيةٍ متسرّبة ولا عنصرٍ نائب باقٍ
  const ctx = { todayLocal: '2026-11-18', currency: 'SAR', range: { from: '2026-01-01', to: '2026-03-31' } };
  for (const l of LANGS) {
    for (const t of TEMPLATES) {
      const s = templateText(t, ctx, trOf(l));
      assert.doesNotMatch(s, /[؀-ۿ]/, `${t.id}/${l}: ${s}`);
      assert.doesNotMatch(s, /\{[a-z]+\}/, `${t.id}/${l}: ${s}`);
    }
    assert.ok(templateText(TEMPLATES.find(t => t.id === 'post-salaries')!, ctx, trOf(l)).split(BLANK).length === 3, `${l}: فراغا الرواتب`);
  }
});
