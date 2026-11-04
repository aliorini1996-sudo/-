// محرّر «نصوص المطبوعات» — الحفظ المشروط بالمراجعة (بلاغ ٤ نوفمبر ٢٠٢٦، D-G2): المحرّر كان يبذر مسودّته من ذاكرة ['company'] ويحفظ
// العمود كلّه بلا شرط، فمديرٌ ثانٍ أو نافذةٌ قديمة يمسح صياغات غيره وحذوفه بلا تنبيه. الآن يقرأ النصوص من الخادم عند الفتح، ويحفظ
// بمراجعتها (x-print-texts-rev)، ورفض الخادم لقِدمها (409 PRINT_TEXTS_STALE) يُعيد الأصل والمراجعة من الخادم ويُبقي مسودة المستخدم.
//
// ١) المنطق الخالص (PrintTextsCard): قراءة ردّ الخادم، وتمييز رفض القِدم، والمصالحة بين المسودة وحال الخادم — ومحاكاة مديرَين.
// ٢) حرّاس مصدرية: العميل يرسل الرأس، والمحرّر يقرأ من الخادم ويرسل المراجعة ويعالج 409، ونصوص المحرّر الجديدة في القاموس بلغاته.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PRINT_TEXT_WARNINGS, canonicalPrintTexts, checkPrintTexts, emptyPrintTexts, type PrintTextsV1 } from '../../lib/print/printTexts';
import {
  PRINT_TEXTS_STALE_MSG, isPrintTextsStale, printTextsServerState, reconcilePrintTexts, withTextEdit,
  type PrintTextsBase, type PrintTextsServerState,
} from './PrintTextsCard';
import { PHRASES } from '../../i18n/strings';

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const editor = () => read('src', 'components', 'print', 'PrintTextsEditor.tsx');
const canon = (t: PrintTextsV1) => JSON.stringify(canonicalPrintTexts(t));

const phone = (text: string) => withTextEdit(emptyPrintTexts(), 'h.phone', { text });
const server = (texts: PrintTextsV1 | null, rev: string | null, stored = texts !== null): PrintTextsServerState =>
  ({ texts: texts ?? emptyPrintTexts(), stored, rev });

test('ردّ الخادم ⇒ حاله: النصوص بالقراءة المتسامحة، وstored، وrev (خادمٌ أقدم بلا rev ⇒ null فيُحفظ بلا شرط)', () => {
  const t = phone('الهاتف');
  assert.deepEqual(printTextsServerState({ success: true, data: t, stored: true, hasCompany: true, rev: 'abcdef0123456789' }),
    { texts: t, stored: true, rev: 'abcdef0123456789' });
  assert.deepEqual(printTextsServerState({ success: true, data: emptyPrintTexts(), stored: false, hasCompany: true }),
    { texts: emptyPrintTexts(), stored: false, rev: null });
  for (const bad of [null, undefined, 'x', 42, { rev: '' }, { rev: 5 }, { data: { version: 9 } }]) {
    const s = printTextsServerState(bad);
    assert.deepEqual([canon(s.texts), s.stored, s.rev], [canon(emptyPrintTexts()), false, null], JSON.stringify(bad));
  }
});

test('رفض القِدم: 409 PRINT_TEXTS_STALE وحده — لا 409 «احفظ بيانات الشركة» ولا 400 ولا خطأ الشبكة', () => {
  assert.equal(isPrintTextsStale({ response: { status: 409, data: { code: 'PRINT_TEXTS_STALE' } } }), true);
  assert.equal(isPrintTextsStale({ response: { status: 409, data: { code: 'COMPANY_SETTINGS_MISSING' } } }), false);
  assert.equal(isPrintTextsStale({ response: { status: 400, data: { code: 'PRINT_TEXTS_STALE' } } }), false);
  for (const e of [null, undefined, new Error('Network Error'), { response: null }]) assert.equal(isPrintTextsStale(e), false);
  assert.equal(PRINT_TEXTS_STALE_MSG, 'تغيرت نصوص المطبوعات من جهاز آخر — راجع المعاينة ثم احفظ مرة أخرى');
});

test('المصالحة: مسودةٌ بلا تعديل تُبذر من الخادم لا من ذاكرة [company] القديمة', () => {
  const cached = phone('هاتف قديم');
  const cur: PrintTextsBase = { initial: cached, draft: cached, rev: null };
  const fresh = phone('هاتف الخادم');
  const r = reconcilePrintTexts(cur, server(fresh, 'r1'));
  assert.deepEqual(r, { initial: fresh, draft: fresh, rev: 'r1', conflict: false });
  // والخادم بلا نصوص (null) ⇒ النصوص الافتراضية
  assert.deepEqual(reconcilePrintTexts(cur, server(null, 'r0')), { initial: emptyPrintTexts(), draft: emptyPrintTexts(), rev: 'r0', conflict: false });
});

test('المصالحة: مسودةٌ معدّلة على أصلٍ لم يتغيّر تبقى كما هي (نفس الكائن) وتؤخذ المراجعة', () => {
  const base = phone('الهاتف');
  const draft = withTextEdit(base, 'cust.phone', { hidden: true });
  const r = reconcilePrintTexts({ initial: base, draft, rev: null }, server(JSON.parse(JSON.stringify(base)), 'r1'));
  assert.equal(r.draft, draft);
  assert.equal(r.initial, base);
  assert.deepEqual([r.rev, r.conflict], ['r1', false]);
});

test('المصالحة: تغيّر الأصل وفي المسودة تعديلات ⇒ المسودة كما هي، والأصل والمراجعة من الخادم، وconflict', () => {
  const base = phone('الهاتف');
  const draft = withTextEdit(base, 'inv.title', { text: 'فاتورة مبيعات' });
  const theirs = withTextEdit(base, 'cust.phone', { hidden: true });
  const r = reconcilePrintTexts({ initial: base, draft, rev: 'r0' }, server(theirs, 'r1'));
  assert.equal(r.draft, draft, 'لا يضيع ما كتبه المستخدم');
  assert.deepEqual([canon(r.initial), r.rev, r.conflict], [canon(theirs), 'r1', true]);
  assert.notEqual(canon(r.draft), canon(r.initial), 'تبقى المسودة «غير محفوظة» فيُعاد الحفظ بالمراجعة الجديدة');
});

/** خادمٌ في الذاكرة بقواعد PUT /company/print-texts: الرأس يطابق المراجعة الحالية أو 409، وبلا رأس يكتب كما كان */
function fakeServer() {
  let value: PrintTextsV1 | null = null;
  let n = 0;
  let rev = 'r0';
  return {
    get: (): unknown => ({ success: true, data: value ?? emptyPrintTexts(), stored: value !== null, hasCompany: true, rev }),
    put(v: PrintTextsV1 | null, sentRev: string | null): { status: number; body: unknown } {
      if (sentRev !== null && sentRev !== rev) return { status: 409, body: { success: false, code: 'PRINT_TEXTS_STALE' } };
      const r = v === null ? null : checkPrintTexts(v, true);
      value = r && r.ok ? r.value : null;
      rev = `r${++n}`;
      return { status: 200, body: { success: true, data: value ?? emptyPrintTexts(), stored: value !== null, hasCompany: true, rev } };
    },
    current: () => value,
  };
}

/** محرّرٌ بخطوات المكوّن نفسها: الفتح يصالح قراءة الخادم، والحفظ يرسل المراجعة، و409 يعيد القراءة ويصالح */
function editorSession(srv: ReturnType<typeof fakeServer>, cached: PrintTextsV1) {
  let st: PrintTextsBase = { initial: cached, draft: cached, rev: null };
  let conflicts = 0;
  // الفتح ينبّه إن تعارضت قراءته مع مسودةٍ معدّلة؛ ورفض الحفظ ينبّه مرّةً واحدة بنفسه (المكوّن يتجاهل conflict هناك)
  const apply = (body: unknown, warn: boolean) => { const r = reconcilePrintTexts(st, printTextsServerState(body)); st = r; if (warn && r.conflict) conflicts++; };
  apply(srv.get(), true);
  return {
    edit(key: string, patch: Parameters<typeof withTextEdit>[2]) { st = { ...st, draft: withTextEdit(st.draft, key, patch) }; },
    save(): number {
      const res = srv.put(st.draft, st.rev);
      if (res.status === 409 && isPrintTextsStale({ response: { status: res.status, data: res.body } })) { conflicts++; apply(srv.get(), false); return 409; }
      const s = printTextsServerState(res.body);
      st = { initial: s.texts, draft: s.texts, rev: s.rev };
      return res.status;
    },
    get state() { return st; },
    get conflicts() { return conflicts; },
  };
}

test('مديران فتحا المحرّر معاً: حفظ الثاني يُرفض بدل أن يمسح حفظ الأول، ومسودته باقية، ثم يحفظ فوق ما حفظه الأول', () => {
  const srv = fakeServer();
  const a = editorSession(srv, emptyPrintTexts());
  const b = editorSession(srv, emptyPrintTexts());
  a.edit('inv.title', { text: 'فاتورة مبيعات' });
  assert.equal(a.save(), 200);
  b.edit('cust.phone', { hidden: true });
  const bDraft = b.state.draft;
  assert.equal(b.save(), 409);
  assert.equal(srv.current()?.edits['inv.title']?.text, 'فاتورة مبيعات', 'حفظ الأول باقٍ');
  assert.equal(b.state.draft, bDraft, 'مسودة الثاني لم تُمسّ');
  assert.equal(b.conflicts, 1);
  // الثاني يدمج يدوياً ما رآه في المعاينة ثم يحفظ بالمراجعة الجديدة
  b.edit('inv.title', { text: 'فاتورة مبيعات' });
  assert.equal(b.save(), 200);
  assert.deepEqual(srv.current()?.edits, {
    'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false },
    'cust.phone': { text: null, alt: null, hidden: true },
  });
});

test('نافذةٌ قديمة بذاكرة [company] أقدم: تُبذر من الخادم عند الفتح فلا تحفظ «القديم + تعديلها» فوق الجديد', () => {
  const srv = fakeServer();
  const first = editorSession(srv, emptyPrintTexts());
  first.edit('h.phone', { text: 'الهاتف' });
  first.edit('cust.phone', { hidden: true });
  assert.equal(first.save(), 200);
  // ذاكرة النافذة القديمة ما زالت بلا نصوص — والمحرّر يبذر من الخادم
  const stale = editorSession(srv, emptyPrintTexts());
  assert.equal(stale.conflicts, 0);
  stale.edit('inv.title', { text: 'فاتورة مبيعات' });
  assert.equal(stale.save(), 200);
  const saved = srv.current();
  assert.equal(saved?.edits['h.phone']?.text, 'الهاتف');
  assert.equal(saved?.edits['cust.phone']?.hidden, true);
  assert.equal(saved?.edits['inv.title']?.text, 'فاتورة مبيعات');
});

test('حارس مصدري: العميل يرسل x-print-texts-rev حين تُعطى المراجعة وحدها — وبلاها الطلب كما كان', () => {
  const client = read('src', 'api', 'client.ts');
  assert.ok(client.includes('put: (data: PrintTextsV1 | null, rev?: string | null) =>'));
  assert.ok(client.includes("api.put('/company/print-texts', data ?? { reset: true }, rev ? { headers: { 'x-print-texts-rev': rev } } : undefined),"));
  assert.ok(client.includes("get: () => api.get('/company/print-texts'),"));
});

test('حارس مصدري: المحرّر يقرأ من الخادم عند الفتح ويرسل المراجعة ويعالج 409 قبل رسالة الخطأ العامة', () => {
  const e = editor();
  assert.ok(e.includes('queryFn: async () => printTextsServerState((await companyApi.printTexts.get()).data),'));
  assert.ok(e.includes("gcTime: 0, staleTime: 0, refetchOnMount: 'always'"), 'لا ذاكرة قديمة للقراءة');
  assert.ok(e.includes('mutationFn: (v: PrintTextsV1 | null) => companyApi.printTexts.put(v, revRef.current),'));
  assert.ok(e.includes('revRef.current = printTextsServerState(res.data).rev;'), 'المراجعة من كل ردّ حفظ');
  const onError = e.slice(e.indexOf('onError: (e) => {'), e.indexOf("toast.error(tr(saveErrorMessage(e)));"));
  assert.ok(onError.includes('if (isPrintTextsStale(e)) {') && onError.includes('toast.error(tr(PRINT_TEXTS_STALE_MSG));') && onError.includes('refetch()'));
  assert.ok(e.includes("qc.invalidateQueries({ queryKey: ['company'] });"), 'إبطال ردّ /company باقٍ');
  assert.ok(e.includes('qc.setQueryData([\'company\'],'), 'تحديث ذاكرة /company باقٍ');
  assert.ok(e.includes("const PRINT_TEXTS_QUERY_KEY = ['company-print-texts'] as const;"), 'مفتاحٌ لا يمسّه إبطال [company]');
});

test('صياغة المحرّر: الإشعار المدين صفّ عنوان، وعناوين الحالة صفوفٌ تُعدَّل وتُحذف (قرار المالك ٤ نوفمبر ٢٠٢٦)، وسطر الترويسة يذكر كشف الحساب والإشعارات — بلغات القاموس الخمس', () => {
  const e = editor();
  assert.ok(e.includes("const TITLE_KEYS: ReadonlySet<string> = new Set(['inv.title', 'inv.returnTitle', 'inv.debitTitle']);"));
  assert.ok(e.includes('const isTitle = TITLE_KEYS.has(entry.key);'));
  assert.match(e, /case 'inv\.title': case 'inv\.debitTitle':[^\n]*\n[^\n]*\n\s*n = \{ isReturn: false \}; break;/);
  // سطر «عناوين الحالة ثابتة ولا تعدل» أُزيل: صارت صفوفاً في مجموعة العنوان بتنبيهها (lineWarning ⇒ 'status') وتأكيد حذفها
  assert.ok(!e.includes('STATUS_TITLES_NOTE') && !e.includes('data-pt-status-titles'), 'سطر «ثابتة ولا تعدل» باقٍ');
  assert.ok(!e.includes('عناوين الحالة ثابتة ولا تعدل'));
  // اختيار صفّ عنوان حالةٍ يعرض المستند النموذجي بحالته (والملغى/المعلَّق على A4 وحده: لا ورقة رول لهما)
  for (const [k, st] of [['inv.deliveryNoteTitle', 'deliveryNote'], ['inv.voidTitle', 'void'], ['inv.pendingTitle', 'pending']]) {
    assert.ok(e.includes(`case '${k}': n = { isReturn: false, status: '${st}' }; break;`), k);
  }
  assert.ok(e.includes("if (status === 'none' || (paper !== 'a4' && status !== 'deliveryNote')) return null;"));
  assert.ok(e.includes('sampleInvoice(docCompany, tr, sample, now, grid, paper)'));
  const header = 'بعد حفظ أي تعديل تطبع الفاتورة والسند بالعربية أولا أيا كانت لغة واجهة الجهاز، وتتبع ترويسة كشف الحساب والإشعارات النصوص المحفوظة';
  assert.ok(e.includes(`{tr('${header}')}`));
  assert.ok(!e.includes("{tr('بعد حفظ أي تعديل تطبع الفاتورة والسند بالعربية أولا أيا كانت لغة واجهة الجهاز')}"), 'السطر القديم استُبدل');
  for (const k of [header, PRINT_TEXT_WARNINGS.status, PRINT_TEXTS_STALE_MSG]) {
    const d = PHRASES[k] as Record<string, string> | undefined;
    assert.ok(d, `غائب عن القاموس: ${k}`);
    for (const l of ['en', 'fr', 'tr', 'zh']) assert.ok(typeof d?.[l] === 'string' && d[l].trim() !== '' && !/[؀-ۿ]/.test(d[l]), `${l}: ${k}`);
  }
});
