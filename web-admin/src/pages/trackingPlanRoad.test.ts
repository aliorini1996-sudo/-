import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('خريطة التتبّع: الخطّ المخطَّط يُرسم على الشوارع (roadPath) وإلا المستقيم — طلب المالك ٢١ نوفمبر', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'TrackingPage.tsx'), 'utf8');
  assert.match(page, /const planPath: \[number, number\]\[\] = plan\?\.roadPath\?\.points\?\.length/);
  assert.match(page, /positions=\{planPath\}/);
  const client = fs.readFileSync(path.join(process.cwd(), 'src', 'api', 'client.ts'), 'utf8');
  assert.match(client, /tzOffsetMin: -new Date\(\)\.getTimezoneOffset\(\), shape: 1 \}/);
});
