// «تتبّع اللوط» — حرّاس نصّية للحزمة B7 (المواصفة §٥.٣ و§٥.٤ و§٨.٣): services/apiSync.ts وroutes/apiV1.ts ومستند الربط.
// نصّي على المصدر: لا قاعدة بيانات ولا شبكة. السلوك نفسه مختبرٌ فوق Prisma مزيّف في api-sync.test.ts؛ هنا ما يجب ألا ينجرف.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LOT_ERROR_STATUS } from '../services/lots';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
/** يزيل التعليقات مع الحفاظ على عدد الأسطر (نمط lots-static.test.ts) */
const stripComments = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`])\/\/.*$/gm, (_m, p1: string) => p1);

const LOT_RESOURCES = ['product-lots', 'van-load-item-lots', 'invoice-item-lots', 'lot-relabels', 'lot-events'];

test('B7: موارد المزامنة الخمسة بعَلَم lots، ورأس كل تعريف سطرٌ واحد بالترتيب name وmodel وmode وpermission ثم الأعلام ثم hardDeletes', () => {
  const src = stripComments(read('services/apiSync.ts'));
  // نمط اختبار المستند (web-admin/src/lib/apiDocsData.test.ts) — رأسٌ مقسوم على سطرين يُسقط المورد من المقارنة بصمت
  const heads = [...src.matchAll(/^\s*name: '([a-z-]+)', model: '\w+', mode: '\w+'(?:, tsColumn: '\w+')?, permission: '\w+'([^\n]*?)hardDeletes: (?:true|false),$/gm)];
  const lotHeads = heads.filter((m) => /\blots: true\b/.test(m[2]));
  assert.deepEqual(lotHeads.map((m) => m[1]).sort(), [...LOT_RESOURCES].sort());
  for (const m of lotHeads) {
    assert.match(m[2], /^, accounting: true, lots: true, tenantPath: 'direct', $/, `${m[1]}: المحاسبة ثم العَلَم في الرأس`);
  }
  // كل تعريفٍ في الملف رأسه سطرٌ واحد (عدد الرؤوس = عدد الأسماء)
  const names = [...src.matchAll(/^\s*name: '([a-z-]+)'/gm)].map((m) => m[1]);
  assert.deepEqual(heads.map((m) => m[1]), names);
});

test('B7: بوّابة /api/v1 تقرأ عَلَم اللوط في استعلام الشركة نفسه (§١٠.١ لا استعلام زائد)، بعد المحاسبة، فاشلةً مغلقة', () => {
  const src = stripComments(read('routes/apiV1.ts'));
  // استعلاما شركةٍ في الملف: البوّابة (العَلَم مع بقية الأعلام)، ومسار الخطأ UNKNOWN_RESOURCE وحده — لا ثالث في مسار الصفحات
  assert.equal((src.match(/prisma\.tenant\.findUnique\(/g) ?? []).length, 2, 'البوّابة وقائمة المورد المجهول وحدهما');
  assert.match(src, /prisma\.tenant\.findUnique\(\{ where: \{ id: tid \}, select: \{ accountingEnabled: true, warehouseEnabled: true, locationsEnabled: true, lotTrackingEnabled: true \} \}\)/);
  const unknownFn = src.slice(src.indexOf('async function unknown('), src.indexOf("router.get('/me',"));
  assert.ok(unknownFn.includes('prisma.tenant.findUnique('), 'الاستعلام الثاني في مسار المورد المجهول');
  assert.ok(unknownFn.includes('() => false)'), 'تعذّر القراءة يُبقي القائمة القديمة');
  // /me: العَلَم من شركة المفتاح في استعلامه نفسه، وموارد اللوط للمفعّلة وحدها (§١٠.١)
  const me = src.slice(src.indexOf("router.get('/me',"), src.indexOf("router.get('/sync/:resource',"));
  assert.ok(me.includes('tenant: { select: { name: true, lotTrackingEnabled: true } }'));
  assert.ok(me.includes('resources: listedResources(key?.tenant.lotTrackingEnabled === true)'));
  assert.ok(!/SYNC_RESOURCES\.map/.test(src), 'لا قائمة موارد بلا ترشيح العَلَم');
  assert.match(src, /const lotsOn = tenant\?\.lotTrackingEnabled === true;/, 'المطفأ أو غير المقروء ليس مفعّلاً');
  const acc = src.indexOf("code: 'ACCOUNTING_DISABLED'");
  const lots = src.indexOf("code: 'LOTS_DISABLED'");
  assert.ok(acc > 0 && lots > acc, 'المحاسبة قبل العَلَم كـrequireLots');
  assert.match(src, /if \(def\.lots && !lotsOn\) return refuse\(\{ status: 403, code: 'LOTS_DISABLED'/);
  // أعمدة اللوط على الموارد القائمة بعَلَم البوّابة نفسه، و/ids بلا أعمدة
  const sync = src.slice(src.indexOf("router.get('/sync/:resource',"), src.indexOf("router.get('/sync/:resource/ids',"));
  assert.ok(sync.includes('const { refusal, lotsOn } = await resourceGate(req, def);'));
  assert.ok(sync.includes('select: { ...selectFor(def, lotsOn), id: true,'));
  assert.ok(!sync.includes('def.select'), 'لا select المورد الخام في مسار الصفحات');
  const ids = src.slice(src.indexOf("router.get('/sync/:resource/ids',"));
  assert.ok(ids.includes('await resourceGate(req, def)') && !ids.includes('selectFor('));
});

test('B7: كل رمز «تتبّع اللوط» يرسله الخادم موثّقٌ في مستند الربط، وكل رمزٍ يذكره المستند يرسله الخادم حرفياً', () => {
  const web = path.resolve(SRC, '..', '..', 'web-admin', 'src');
  const docs = [path.join(web, 'lib', 'apiDocsCatalog.ts'), path.join(web, 'lib', 'apiDocsData.ts'), path.join(web, 'components', 'ApiDocs.tsx')]
    .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const documented = new Set([...docs.matchAll(/\bLOTS?_[A-Z0-9]+(?:_[A-Z0-9]+)*\b/g)].map((m) => m[0]));
  // الخادم: نصوصه كلها بلا الاختبارات
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(d, e.name);
    if (e.isDirectory()) return e.name === 'tests' ? [] : walk(f);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [f] : [];
  });
  const server = walk(SRC).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const unknown = [...documented].filter((c) => !server.includes(`'${c}'`));
  assert.deepEqual(unknown, [], 'رموزٌ في المستند لا يرسلها الخادم');
  // الاتجاه العكسي: كل رمز خطأ في LOT_ERROR_STATUS (§٣.٣) وكل تحذير في warnings[] — نظام الشركة يتفرّع على الرمز
  const lots = read('services/lots.ts');
  const union = /export interface LotWarning \{ code: ([^;]+);/.exec(lots);
  assert.ok(union, 'اتحاد رموز التحذير في lots.ts');
  const warnings = [...union[1].matchAll(/'(LOT_[A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(warnings.length >= 6, `قُرئ ${warnings.length} تحذيراً فقط`);
  const missing = [...Object.keys(LOT_ERROR_STATUS), ...warnings].filter((c) => !documented.has(c));
  assert.deepEqual(missing, [], 'رموزٌ يرسلها الخادم غائبة عن المستند');
});
