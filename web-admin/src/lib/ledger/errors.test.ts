import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LEDGER_REASONS_CODE_TEXT, LEDGER_REASONS_INTERNAL, ledgerErrorMessage, ledgerErrorText, ledgerReasonLabels,
} from './errors';

/**
 * نصوص أخطاء الدفاتر (§8.7): السبب قبل الرمز، ولا رسالة خادم عربية في واجهة غير عربية.
 * الحارس يمسح أسباب الخادم (`reason: '…'`) تحت routes/ledger وservices/gl فلا يصل سبب بلا تسمية ونصُّ رمزه مضلِّل.
 */

const tr = (ar: string) => ar;
const backend = path.resolve(process.cwd(), '..', 'backend', 'src');

function serverReasons(): Set<string> {
  const files = [
    ...fs.readdirSync(path.join(backend, 'routes', 'ledger')).map(f => path.join(backend, 'routes', 'ledger', f)),
    ...fs.readdirSync(path.join(backend, 'services', 'gl')).map(f => path.join(backend, 'services', 'gl', f)),
  ].filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const out = new Set<string>();
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/reason:[^,{};\n]*?'([A-Z_]+)'(?:\s*:\s*'([A-Z_]+)')?/g)) { out.add(m[1]); if (m[2]) out.add(m[2]); }
    // اتحادات أنواع الأسباب: reason: 'A' | 'B'
    for (const m of s.matchAll(/reason\??:\s*((?:'[A-Z_]+'\s*\|\s*)+'[A-Z_]+')/g)) for (const x of m[1].matchAll(/'([A-Z_]+)'/g)) out.add(x[1]);
  }
  return out;
}

test('كل سبب يرده الخادم له تسمية مترجمة، أو نص رمزه دقيق، أو داخلي موثَّق', () => {
  const reasons = serverReasons();
  assert.ok(reasons.has('NOT_POSTED') && reasons.has('FILE_TOO_LARGE') && reasons.has('UNKNOWN_LIST'), `المسح لم يجد الأسباب: ${[...reasons].join(',')}`);
  const labels = ledgerReasonLabels(tr);
  const known = new Set<string>([...LEDGER_REASONS_CODE_TEXT, ...LEDGER_REASONS_INTERNAL]);
  const missing = [...reasons].filter(r => !labels[r] && !known.has(r));
  assert.deepEqual(missing, [], 'أسباب بلا تسمية (أضفها إلى ledgerMoveReasonLabels بخمس لغات أو صنّفها)');
});

test('الأسباب المضلِّلة سابقاً تُعرض بتسميتها لا بنص رمزها', () => {
  const t = (code: string, reason: string) => ledgerErrorMessage(tr, { code, details: { reason }, status: 409 });
  assert.equal(t('LEDGER_MOVE_NOT_DRAFT', 'NOT_POSTED'), 'القيد غير مرحّل فلا يُعكس');
  assert.equal(t('LEDGER_MOVE_NOT_DRAFT', 'ALREADY_REVERSED'), 'القيد معكوس مسبقا');
  assert.equal(t('LEDGER_UNBALANCED', 'AMOUNT_PRECISION'), 'المبلغ فيه منازل عشرية أكثر مما تسمح به العملة');
  assert.equal(t('LEDGER_UNBALANCED', 'INVALID_AMOUNT'), 'مبلغ غير صالح');
  assert.equal(t('LEDGER_ACCOUNT_NOT_FOUND', 'TAX_NOT_FOUND'), 'الضريبة غير موجودة');
  assert.equal(t('LEDGER_PERIOD_LOCKED', 'BEFORE_ORIGINAL_DATE'), 'تاريخ العكس لا يسبق تاريخ القيد الأصلي');
  assert.equal(t('LEDGER_ATTACHMENT_QUOTA', 'FILE_TOO_LARGE'), 'الملف أكبر من الحجم المسموح للمرفق الواحد');
  assert.equal(t('LEDGER_ATTACHMENT_QUOTA', 'MONTHLY_QUOTA'), 'تجاوزت شركتك سقف المرفقات الشهري');
  // السبب في جذر الجسم (spread) أيضاً
  assert.equal(ledgerErrorMessage(tr, { reason: 'UNKNOWN_LIST', status: 400 }), 'قائمة التصدير غير معروفة');
  // سبب بلا تسمية ⇒ نص الرمز
  assert.equal(t('LEDGER_UNBALANCED', 'UNBALANCED'), 'القيد غير متوازن');
});

test('بلا رمز ولا سبب معروف: نص عام بحسب الحالة، لا رسالة الخادم العربية (ZodError 400 وغيره)', () => {
  const server = { success: false, message: 'بيانات غير صحيحة lines', errors: {} } as const;
  const zod = ledgerErrorMessage(tr, { ...server, status: 400 });
  assert.equal(zod, 'بيانات غير صالحة');
  assert.notEqual(zod, server.message);
  assert.equal(ledgerErrorMessage(tr, { status: 404 }), 'السجل غير موجود');
  assert.equal(ledgerErrorMessage(tr, { status: 413 }), 'الحجم أكبر من المسموح');
  assert.equal(ledgerErrorMessage(tr, { status: 500 }), 'تعذر تنفيذ الإجراء');
  assert.equal(ledgerErrorMessage(tr, null), 'تعذر تنفيذ الإجراء');
  assert.equal(ledgerErrorText(tr, 'LEDGER_NOT_SETUP'), 'الترحيل متاح بعد اكتمال الإعداد المبدئي للدفاتر');
});

test('صفحات القيود ومكوّناتها لا تعرض message من جسم خطأ الخادم', () => {
  const src = path.resolve(process.cwd(), 'src');
  for (const f of ['pages/ledger/entries/MoveForm.tsx', 'pages/ledger/entries/MoveList.tsx', 'pages/ledger/entries/MoveLineList.tsx',
    'components/ledger/AttachmentPane.tsx', 'components/ledger/LockDatesDialog.tsx']) {
    const s = fs.readFileSync(path.join(src, f), 'utf8');
    assert.doesNotMatch(s, /\b(?:e|body|b)\?*\.message\b|ledgerErrorOf\([^)]*\)\?*\.message/, f);
  }
});
