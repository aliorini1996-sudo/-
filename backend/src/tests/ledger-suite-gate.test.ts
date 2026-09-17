import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * حرّاس ثابتة على تسييج «النظام المحاسبي المتكامل» (M0، §8.1، §9.1).
 *
 * العَلَم مطفأ افتراضياً كالتقرير اليومي، فالحارس `!== true`، ويشترط معه ألا
 * يكون النظام المحاسبي مطفأً صراحةً. وقائمة التجربة فشلٌ مغلق: متغير غائب أو
 * فارغ يعني لا أحد.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('العمود مطفأ افتراضياً', () => {
  const s = read('prisma', 'schema.prisma');
  assert.match(s, /accountingSuiteEnabled\s+Boolean\s+@default\(false\)/, 'يجب أن يكون @default(false)');
  assert.doesNotMatch(s, /accountingSuiteEnabled\s+Boolean\s+@default\(true\)/, 'افتراض true يفتح الدفاتر لكل الشركات');
});

test('الحارس يمنع عند غياب true ويقرأ الشركة من الطلب', () => {
  const s = read('src', 'middleware', 'auth.ts');
  const i = s.indexOf('export async function requireAccountingSuite');
  assert.ok(i > 0, 'requireAccountingSuite مفقود من auth.ts');
  const body = s.slice(i, s.indexOf('\n}', i));
  assert.match(body, /accountingSuiteEnabled !== true/, 'الشرط يجب أن يكون !== true');
  assert.doesNotMatch(body, /accountingSuiteEnabled === false/, '`=== false` يفتح الميزة حين يتعذّر قراءة الصف');
  assert.match(body, /accountingEnabled === false/, 'إطفاء النظام المحاسبي يجب أن يمنع الدفاتر أيضاً');
  assert.match(body, /const tid = req\.user\?\.tenantId/, 'اقرأ tenantId من الطلب لا عبر tenantId(req)');
  assert.match(body, /ACCOUNTING_SUITE_NOT_ALLOWED/, 'رمز الخطأ مفقود');
});

test('العَلَم في مخطّط التحديث لا في الإنشاء', () => {
  const s = read('src', 'routes', 'tenants.ts');
  const cStart = s.indexOf('const createTenantSchema');
  const uStart = s.indexOf('const updateTenantSchema');
  assert.ok(cStart >= 0 && uStart > cStart, 'ترتيب المخطّطين تغيّر — راجع هذا الاختبار');
  assert.doesNotMatch(s.slice(cStart, uStart), /accountingSuiteEnabled/, 'لا يُقبل العَلَم عند إنشاء الشركة');
  assert.match(s.slice(uStart), /accountingSuiteEnabled: z\.boolean\(\)\.optional\(\)/, 'العَلَم مفقود من مخطّط التحديث');
  const post = s.indexOf("router.post('/',");
  assert.ok(post > 0);
  assert.doesNotMatch(s.slice(post, s.indexOf('\n});', post)), /accountingSuiteEnabled/, 'مسار الإنشاء لا يكتب العَلَم');
});

test('/company يُرفق العَلَم بـ=== true', () => {
  const s = read('src', 'routes', 'company.ts');
  assert.match(s, /accountingSuiteEnabled: true/, 'العَلَم مفقود من select');
  assert.match(s, /accountingSuiteEnabled: tenant\?\.accountingSuiteEnabled === true/, 'يجب === true (العَلَم مطفأ افتراضياً)');
  assert.doesNotMatch(s, /accountingSuiteEnabled: !!tenant/, 'التزم بصيغة === true');
});

test('سلسلة الحراسة مركّبة قبل أول مسار في موجّه الدفاتر', () => {
  const s = read('src', 'routes', 'ledger', 'index.ts');
  const guard = s.indexOf('router.use(authenticate, requireAdmin, requireAccountingSuite, ledgerContext)');
  assert.ok(guard > 0, 'سلسلة الحراسة غير مركّبة بالترتيب المحدد في §9.1');
  const firstRoute = Math.min(
    ...['router.get(', 'router.post(', 'router.patch(', 'router.delete(', 'router.put(']
      .map(t => { const i = s.indexOf(t); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }),
  );
  assert.ok(firstRoute < Number.MAX_SAFE_INTEGER, 'لا مسار في الموجّه');
  assert.ok(guard < firstRoute, 'الحارس يجب أن يسبق أول مسار');
  assert.match(s, /router\.get\('\/status', requireLedgerPermission\('canViewLedger'\)/, 'GET /status بلا صلاحية canViewLedger');
  // M0: مسار واحد فقط
  assert.equal((s.match(/router\.(get|post|put|patch|delete)\(/g) || []).length, 1, 'M0 يعرّف GET /status وحده');
});

test('الموجّه مسجَّل تحت /api/ledger', () => {
  const s = read('src', 'index.ts');
  assert.match(s, /import ledgerRouter from '\.\/routes\/ledger'/, 'الموجّه غير مستورد');
  assert.match(s, /app\.use\('\/api\/ledger', ledgerRouter\)/, 'الموجّه غير مسجَّل');
});

test('الدفاتر لا تحرس مسارات التشغيل — الفواتير والسندات والأوف-لاين تعمل أياً كان العَلَم', () => {
  for (const f of ['invoices.ts', 'receipts.ts']) {
    assert.doesNotMatch(read('src', 'routes', f), /requireAccountingSuite/, `${f} لا يجوز أن يتوقف بإطفاء الدفاتر`);
  }
  assert.doesNotMatch(read('..', 'web-admin', 'src', 'rep', 'offlineSync.ts'), /requireAccountingSuite|ACCOUNTING_SUITE_NOT_ALLOWED/,
    'صندوق الأوف-لاين لا علاقة له بالدفاتر');
});

test('الواجهة: عنصر الدفاتر بـ=== true ولا يدخل قائمة الصفحات المحاسبية', () => {
  const s = read('..', 'web-admin', 'src', 'layouts', 'MainLayout.tsx');
  assert.match(s, /companyCfg\?\.accountingSuiteEnabled === true && companyCfg\?\.accountingEnabled !== false/, 'شرط العنصر يجب أن يكون === true مع !== false');
  assert.doesNotMatch(s, /accountingSuiteEnabled !== false/, '`!== false` يُظهر الدفاتر لكل شركة');
  assert.match(s, /canLedger\(user, 'canViewLedger'\)/, 'العنصر بلا فحص صلاحية الدفاتر');
  const pages = s.match(/const ACCOUNTING_PAGES = \[([^\]]*)\]/);
  assert.ok(pages, 'ACCOUNTING_PAGES مفقودة');
  assert.doesNotMatch(pages[1], /ledger/, '/app/ledger لا يُضاف إلى ACCOUNTING_PAGES');
});

test('نافذة المالك: useState(!!…) والخانة ظاهرة لكل الشركات (قرار المالك: لا قائمة تجربة)', () => {
  const s = read('..', 'web-admin', 'src', 'pages', 'PlatformPage.tsx');
  assert.match(s, /useState\(!!tenant\.accountingSuiteEnabled\)/, 'الدلالة الصحيحة !! (مطفأ افتراضياً)');
  assert.doesNotMatch(s, /ledgerPilotAllowed|showLedgerToggle/, 'الخانة لا تُشترط بقائمة تجربة');
  assert.match(s, /checked=\{accountingSuiteEnabled\} disabled=\{!accountingEnabled\}/, 'الخانة معطّلة حين النظام المحاسبي مطفأ');
  const i = s.indexOf('mutationFn: () => tenantApi.update(');
  assert.ok(i > 0);
  assert.match(s.slice(i, i + 800), /accountingSuiteEnabled/, 'العَلَم غائب عن حمولة الحفظ');
});

/* ═══ قرار المالك: لا قائمة تجربة ═══ */

test('tenants.ts: لا حارس قائمة تجربة ولا ledgerPilotAllowed (قرار المالك 17 سبتمبر 2026)', () => {
  const s = read('src', 'routes', 'tenants.ts');
  assert.doesNotMatch(s, /LEDGER_PILOT_ONLY|isLedgerPilotTenant|ledgerPilotAllowed|LEDGER_PILOT_TENANTS/, 'بقايا قائمة التجربة في tenants.ts');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'services', 'gl', 'pilot.ts')), 'services/gl/pilot.ts يجب أن يُحذف مع الحارس');
});
