import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { ruleFor, STAFF_PERMISSIONS } from '../services/platformAccess';

// «الملاحظات» و«حالة الصفقة» في لوحة المنصة (طلب المالك ٩ نوفمبر ٢٠٢٦)

test('مسارات الملاحظات وحالة الصفقة للموظف بمفتاح tenants.view — بلا مفتاح جديد', () => {
  assert.equal(ruleFor('GET', '/api/tenants/abc/notes')?.key, 'tenants.view');
  assert.equal(ruleFor('POST', '/api/tenants/abc/notes')?.key, 'tenants.view');
  assert.equal(ruleFor('DELETE', '/api/tenants/abc/notes/n1')?.key, 'tenants.view');
  assert.equal(ruleFor('PUT', '/api/tenants/abc/deal')?.key, 'tenants.view');
  // لا تبتلع مسارات الشركة القائمة
  assert.equal(ruleFor('PUT', '/api/tenants/abc')?.key, 'tenants.edit');
  assert.equal(ruleFor('DELETE', '/api/tenants/abc')?.key, 'tenants.delete');
  // مفتاح جديد كان سيُسقط «كل الصلاحيات» عن موظفٍ قائم (hasAllStaffPermissions)
  assert.equal(STAFF_PERMISSIONS.some((p) => /notes|deal/i.test(p.key)), false);
});

test('الخيارات السبعة نفسها في الخادم والواجهة وبالترتيب', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, ...p), 'utf8');
  const srv = read('..', 'routes', 'tenants.ts');
  const web = read('..', '..', '..', 'web-admin', 'src', 'components', 'TenantCrm.tsx');
  const keys = ['NOT_FIT', 'CONTACTED', 'MEETING', 'NO_REPLY', 'NEGOTIATION', 'BUYER', 'LOST'];
  assert.match(srv, new RegExp(`DEAL_STAGES = \\[${keys.map((k) => `'${k}'`).join(', ')}\\] as const`));
  const labels = ['غير مناسب', 'تم التواصل', 'تم الاجتماع', 'لم يتم الرد', 'المفاوضة', 'مشتري', 'تم خسارة العميل'];
  const webOrder = [...web.matchAll(/\{ value: '(\w+)', label: '([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(webOrder, keys.map((k, i) => [k, labels[i]]));
  for (const [i, k] of keys.entries()) assert.ok(srv.includes(`${k}: '${labels[i]}'`), k);
});

test('الشركة لا تقرأ الملاحظات: الجدولان لا يظهران إلا في مسارات المنصة', () => {
  const routesDir = path.join(__dirname, '..', 'routes');
  const users: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(f) && /tenantNote|tenantDeal|platformNotes|platformDeal/.test(fs.readFileSync(p, 'utf8'))) users.push(path.relative(routesDir, p));
    }
  };
  walk(routesDir);
  assert.deepEqual(users, ['tenants.ts']);
  // وراوتر الشركات كله خلف بوابة المنصة
  assert.match(fs.readFileSync(path.join(routesDir, 'tenants.ts'), 'utf8'), /router\.use\(platformGate\);/);
});
