// M3 — ضمانة الحفظ G6 (DESIGN.md §3.9، §9.5 G6، §10.1 بند M3: gl-retention.test.ts).
// الجزء الصرف: ledgerRetentionUntil وقرار حارس حذف الشركة. الحراس الثابتة على tenants.ts تُفعَّل حين يوجد المسار.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LEDGER_RETENTION_YEARS, isLedgerDestroyConfirmed, ledgerRetentionUntil, retentionActiveMessage, tenantDeleteRetentionGuard,
} from '../services/gl/retention';

const fy = (lastPostedDate: string | Date | null, m: number, d: number) =>
  ledgerRetentionUntil({ lastPostedDate, fiscalYearEndMonth: m, fiscalYearEndDay: d });

test('ledgerRetentionUntil: متجهات عمود M3 (نهاية السنة المالية لآخر قيد + 10 سنوات)', () => {
  assert.equal(LEDGER_RETENTION_YEARS, 10);
  assert.equal(fy('2027-05-10', 12, 31), '2037-12-31');
  assert.equal(fy('2027-05-10', 6, 30), '2037-06-30');
  assert.equal(fy('2027-07-01', 6, 30), '2038-06-30');
  // حدود السنة
  assert.equal(fy('2027-06-30', 6, 30), '2037-06-30');
  assert.equal(fy('2027-12-31', 12, 31), '2037-12-31');
  assert.equal(fy('2028-01-01', 12, 31), '2038-12-31');
  // عمود @db.Date (منتصف ليل UTC)
  assert.equal(fy(new Date('2027-05-10T00:00:00.000Z'), 12, 31), '2037-12-31');
  // نهاية فبراير: قصّ اليوم في غير الكبيسة
  assert.equal(fy('2027-02-10', 2, 29), '2037-02-28');
  assert.equal(fy('2029-02-10', 2, 29), '2039-02-28');
  assert.equal(fy('2030-01-05', 2, 29), '2040-02-29');
  // بلا قيد مرحَّل
  assert.equal(fy(null, 12, 31), null);
  assert.throws(() => fy('2027-13-01', 12, 31));
});

test('حارس حذف الشركة: بلا قيد ⇒ كما اليوم، ضمن المدة ⇒ RETENTION_ACTIVE بلا تجاوز، بعدها ⇒ EXPIRED', () => {
  const base = { fiscalYearEndMonth: 12, fiscalYearEndDay: 31, timezone: 'Asia/Riyadh' };
  assert.deepEqual(
    tenantDeleteRetentionGuard({ ...base, postedMoves: 0, lastPostedDate: null, now: new Date('2027-01-01T00:00:00Z') }),
    { action: 'ALLOW', postedMoves: 0, retentionUntil: null },
  );
  assert.deepEqual(
    tenantDeleteRetentionGuard({ ...base, postedMoves: 42, lastPostedDate: '2027-05-10', now: new Date('2030-01-01T00:00:00Z') }),
    { action: 'RETENTION_ACTIVE', postedMoves: 42, retentionUntil: '2037-12-31' },
  );
  // آخر يوم في المدة بتوقيت الشركة (2037-12-31 23:30 الرياض = 20:30 UTC) ⇒ ما زالت سارية
  assert.equal(
    tenantDeleteRetentionGuard({ ...base, postedMoves: 1, lastPostedDate: '2027-05-10', now: new Date('2037-12-31T20:30:00Z') }).action,
    'RETENTION_ACTIVE',
  );
  // بعد منتصف الليل بتوقيت الرياض (21:30 UTC = 00:30 في 2038-01-01) ⇒ انقضت
  assert.deepEqual(
    tenantDeleteRetentionGuard({ ...base, postedMoves: 1, lastPostedDate: '2027-05-10', now: new Date('2037-12-31T21:30:00Z') }),
    { action: 'EXPIRED', postedMoves: 1, retentionUntil: '2037-12-31' },
  );
  assert.throws(() => tenantDeleteRetentionGuard({ ...base, postedMoves: 3, lastPostedDate: null, now: new Date() }));
});

test('confirmLedgerDestroy: القيمة "1" حرفياً من الاستعلام وحدها', () => {
  assert.equal(isLedgerDestroyConfirmed('1'), true);
  assert.equal(isLedgerDestroyConfirmed(['1']), true);
  for (const v of [undefined, null, '', '0', 'true', 1, true, ['1', '1']]) assert.equal(isLedgerDestroyConfirmed(v), false, String(v));
  assert.match(retentionActiveMessage('2037-12-31'), /محفوظة حتى 2037-12-31 — أوقف الشركة بدل حذفها/);
});

// ── الحراس الثابتة (تُفعَّل حين يكتب وكيل المالك المسارين في tenants.ts) ──

const TENANTS = path.join(__dirname, '../routes/tenants.ts');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function routeBody(s: string, method: string, route: string): string | null {
  const re = new RegExp(`router\\.${method}\\(\\s*['"\`]${route.replace(/[/:]/g, (c) => `\\${c}`)}['"\`]`);
  const m = re.exec(s);
  if (!m) return null;
  const rest = s.slice(m.index + 10);
  const next = rest.search(/\nrouter\.(get|post|put|delete|patch)\(/);
  return next < 0 ? s.slice(m.index) : s.slice(m.index, m.index + 10 + next);
}

test('حارس ثابت: DELETE /:id يستدعي ledgerRetentionUntil ويرد LEDGER_RETENTION_ACTIVE قبل أول deleteMany وقبل قراءة confirmLedgerDestroy', (t) => {
  const s = strip(fs.readFileSync(TENANTS, 'utf8'));
  const body = routeBody(s, 'delete', '/:id');
  if (!body || !/ledgerRetentionUntil|tenantDeleteRetentionGuard/.test(body)) {
    t.skip('حارس الحفظ لم يُكتب بعد في routes/tenants.ts (وكيل المالك، M3)');
    return;
  }
  const guard = body.search(/ledgerRetentionUntil|tenantDeleteRetentionGuard/);
  const active = body.indexOf('LEDGER_RETENTION_ACTIVE');
  const confirm = body.indexOf('confirmLedgerDestroy');
  // بعد رأس المسار نفسه (router.delete( يطابق النمط)
  const head = body.indexOf('=>');
  const afterHead = body.slice(head).search(/\.delete(Many)?\(/);
  const firstDelete = afterHead < 0 ? -1 : head + afterHead;
  assert.ok(active > guard, 'LEDGER_RETENTION_ACTIVE بعد حساب المدة');
  if (firstDelete >= 0) assert.ok(guard < firstDelete && active < firstDelete, 'الحارس قبل أول حذف');
  assert.ok(confirm < 0 || confirm > active, 'confirmLedgerDestroy يُقرأ بعد رد LEDGER_RETENTION_ACTIVE');
  if (confirm >= 0) {
    assert.match(body, /req\.query\.confirmLedgerDestroy|req\.query\[['"]confirmLedgerDestroy['"]\]/, 'من الاستعلام');
    assert.doesNotMatch(body, /req\.body\.confirmLedgerDestroy/, 'لا من الجسم');
  }
});

test('حارس ثابت: ledger-reset يفحص POSTED_MOVES قبل أي حذف', (t) => {
  const s = strip(fs.readFileSync(TENANTS, 'utf8'));
  const body = routeBody(s, 'post', '/:id/ledger-reset');
  if (!body) { t.skip('مسار ledger-reset لم يُكتب بعد (وكيل المالك، M3)'); return; }
  const posted = body.search(/POSTED_MOVES|ledgerResetBlockReasons/);
  const del = body.search(/deleteLedgerRows|\.deleteMany\(/);
  assert.ok(posted >= 0, 'فحص POSTED_MOVES');
  assert.ok(del < 0 || posted < del, 'الفحص قبل الحذف');
});

// ── حراس المسارات القائمة الآن (M3، وكيل المالك) — بلا تخطٍّ ──

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'node_modules') walkTs(p, out); }
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

test('حارس ثابت (G6 (د)/(ط)): DELETE /:id — الحارس موجود، ورد RETENTION_ACTIVE بلا تجاوز، والدفاتر لا تُحذف إلا بعد EXPIRED والتأكيد من الاستعلام', () => {
  const s = strip(fs.readFileSync(TENANTS, 'utf8'));
  const body = routeBody(s, 'delete', '/:id');
  assert.ok(body, 'DELETE /:id موجود');
  const guard = body.search(/tenantDeleteRetentionGuard\(|ledgerRetentionUntil\(/);
  assert.ok(guard >= 0, 'حساب مدة الحفظ في المسار');
  // كتلة RETENTION_ACTIVE ترد وتخرج ولا تذكر أي تجاوز
  const activeIf = body.indexOf("retention.action === 'RETENTION_ACTIVE'");
  assert.ok(activeIf > guard, 'فرع RETENTION_ACTIVE بعد الحساب');
  const activeBlock = body.slice(activeIf, body.indexOf('return;', activeIf));
  assert.match(activeBlock, /status\(409\)/);
  assert.match(activeBlock, /LEDGER_RETENTION_ACTIVE/);
  assert.match(activeBlock, /retentionUntil/);
  assert.match(activeBlock, /postedMoves/);
  assert.doesNotMatch(activeBlock, /confirmLedgerDestroy|req\.query|req\.body/, 'لا معامل يتجاوز ضمن مدة الحفظ');
  // التأكيد من الاستعلام وحده، مشروطاً بانقضاء المدة، وقبل المعاملة
  const confirm = body.search(/isLedgerDestroyConfirmed\(\s*req\.query\.confirmLedgerDestroy\s*\)/);
  assert.ok(confirm > activeIf, 'isLedgerDestroyConfirmed(req.query.confirmLedgerDestroy) بعد فرع RETENTION_ACTIVE');
  assert.match(body, /destroyLedger\s*=\s*retention\.action === 'EXPIRED'/);
  assert.match(body, /destroyLedger && !isLedgerDestroyConfirmed\(\s*req\.query\.confirmLedgerDestroy\s*\)/);
  assert.ok(body.indexOf('LEDGER_HAS_POSTED_MOVES') > confirm);
  const tx = body.indexOf('$transaction(');
  assert.ok(tx > body.indexOf('LEDGER_HAS_POSTED_MOVES'), 'المعاملة بعد الحارسين');
  // حذف جداول gl وسجل التدقيق مشروط بـdestroyLedger
  const glDel = body.indexOf('...GL_RESET_KEEP]');
  assert.ok(glDel > tx, 'GlAuditLog (GL_RESET_KEEP) يُحذف داخل المعاملة بعد انقضاء المدة وحده');
  const cond = body.lastIndexOf('destroyLedger', glDel);
  assert.ok(cond > tx && /\.\.\.\(destroyLedger\s*\?/.test(body.slice(cond - 5, cond + 40)), 'حذف الدفاتر خلف ...(destroyLedger ? … : [])');
  assert.match(body, /\[\.\.\.GL_RESET_ORDER, \.\.\.GL_RESET_KEEP\]\.map\(/, 'جداول gl بالترتيب الصريح ثم سجل التدقيق');
  assert.doesNotMatch(body, /req\.body\.confirmLedgerDestroy|req\.body\?\.confirmLedgerDestroy/);
  assert.match(body, /TENANT_DELETED/, 'سطر السجل المنظّم (§9.3)');
});

test('حارس ثابت (G6): لا tenant.delete خارج DELETE /api/tenants/:id في backend/src', () => {
  const src = path.join(__dirname, '..');
  const hits: string[] = [];
  for (const f of walkTs(src)) {
    const s = strip(fs.readFileSync(f, 'utf8'));
    const re = /\.tenant\.delete(Many)?\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (path.resolve(f) === path.resolve(TENANTS)) {
        const body = routeBody(s, 'delete', '/:id')!;
        const start = s.indexOf(body);
        if (m.index >= start && m.index < start + body.length) continue;
      }
      hits.push(path.relative(src, f));
    }
  }
  assert.deepEqual(hits, []);
});

test('حارس ثابت (G6 (هـ)): ledger-reset — confirmName من الخادم قبل المعاملة، POSTED_MOVES أول الفحوص، ولا يمسّ GlAuditLog، وLEDGER_RESET بعد الحذف', () => {
  const s = strip(fs.readFileSync(TENANTS, 'utf8'));
  const body = routeBody(s, 'post', '/:id/ledger-reset');
  assert.ok(body, 'POST /:id/ledger-reset موجود');
  const name = body.search(/resetConfirmNameMatches\(\s*req\.body\?*\.confirmName\s*,\s*tenant\.name\s*\)/);
  const tx = body.indexOf('$transaction(');
  assert.ok(name >= 0 && name < tx, 'confirmName يطابق tenant.name في الخادم قبل المعاملة');
  const lock = body.indexOf('acquirePostLock(');
  const posted = body.indexOf("state: 'POSTED'");
  const firstCount = body.search(/\.count\(/);
  assert.ok(lock > tx && posted > lock, 'القفل ثم عدّ المرحَّل');
  assert.equal(body.lastIndexOf('.count(', posted), firstCount, 'عدّ القيود المرحّلة أول الفحوص');
  const reasons = body.indexOf('ledgerResetBlockReasons(');
  const blocked = body.indexOf('LEDGER_RESET_BLOCKED');
  const del = body.indexOf('deleteLedgerRows(');
  assert.ok(reasons > posted && blocked > reasons && del > blocked, 'الأسباب ثم 409 ثم الحذف');
  assert.ok(body.indexOf("'LEDGER_RESET'") > del, 'تدقيق LEDGER_RESET بعد الحذف');
  assert.ok(body.indexOf('notification.create') > del, 'إشعار الشركة');
  assert.doesNotMatch(body, /glAuditLog\.delete/, 'GL_RESET_KEEP لا يُحذف');
  assert.doesNotMatch(body, /\.deleteMany\(/, 'الحذف عبر deleteLedgerRows وحده');
});
