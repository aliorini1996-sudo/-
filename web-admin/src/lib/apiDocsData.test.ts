import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { API_DENIED, API_SYNC_RESOURCES, API_RATE_PER_MINUTE, API_BASE_URL, API_MAX_PAGE } from './apiDocsData';

/**
 * مستند «الربط البرمجي API» مرآةٌ للخادم — يُسلَّم لمبرمج الشركة فلا يصحّ أن يَعِد بما لا يفعله الخادم.
 * موردٌ يُضاف للمزامنة، أو بادئةٌ تُمنع على المفاتيح، أو حدٌّ يتغيّر، ولا يتغيّر هنا ⇒ يفشل هذا.
 */
const backend = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), '..', 'backend', 'src', ...p), 'utf8');

test('موارد المزامنة في المستند هي موارد الخادم نفسها — بالاسم والنمط والحذف الفعلي والصلاحية', () => {
  const src = backend('services', 'apiSync.ts');
  const server = [...src.matchAll(/name: '([a-z-]+)', model: '\w+', mode: '(\w+)'(?:, tsColumn: '\w+')?, permission: '(\w+)'[^\n]*?hardDeletes: (true|false)/g)]
    .map(m => ({ name: m[1], mode: m[2], permission: m[3], hardDeletes: m[4] === 'true' }));
  assert.ok(server.length >= 10, `قراءة موارد الخادم فشلت (${server.length})`);
  const docs = API_SYNC_RESOURCES.map(r => ({ name: r.name, mode: r.mode, permission: r.permission, hardDeletes: r.hardDeletes }));
  assert.deepEqual([...docs].sort((a, b) => a.name.localeCompare(b.name)), [...server].sort((a, b) => a.name.localeCompare(b.name)));
});

test('المسارات الممنوعة على المفتاح في المستند هي قائمة الخادم نفسها', () => {
  const src = backend('services', 'apiKeys.ts');
  const block = src.slice(src.indexOf('API_KEY_DENIED_PREFIXES'), src.indexOf(']);', src.indexOf('API_KEY_DENIED_PREFIXES')));
  const server = [...block.matchAll(/'(\/[a-z-]+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(API_DENIED.map(d => d.prefix).sort(), server);
});

test('حدّ الدقيقة وأقصى الصفحة والعنوان كما في الخادم والواجهة الحية', () => {
  assert.match(backend('services', 'apiKeys.ts'), new RegExp(`API_KEY_RATE_PER_MINUTE = ${API_RATE_PER_MINUTE};`));
  assert.match(backend('services', 'apiKeys.ts'), new RegExp(`API_KEY_MAX_PAGE = ${API_MAX_PAGE};`));
  assert.equal(API_BASE_URL, 'https://api.fieldsa.net/api');
});
