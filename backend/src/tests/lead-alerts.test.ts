// التنبيه اللحظي بالعملاء الجدد (طلب المالك ٨ نوفمبر ٢٠٢٦): طلب اجتماع أو تسجيل تجربة ⇒ بريد فوري للبريد الرئيسي والثلاثة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LEAD_ALERT_EMAILS, leadAlertRecipients } from '../services/leadAlerts';

const src = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('المستلمون: البريد الرئيسي ثم abdullah وanas وceo، بلا تكرار، والبيئة تستبدل الثلاثة', () => {
  assert.deepEqual([...LEAD_ALERT_EMAILS], ['abdullah@fieldsa.net', 'anas@fieldsa.net', 'ceo@fieldsa.net']);
  assert.deepEqual(leadAlertRecipients({}), ['info@fieldsa.net', 'abdullah@fieldsa.net', 'anas@fieldsa.net', 'ceo@fieldsa.net']);
  assert.deepEqual(leadAlertRecipients({ MAIL_TO: 'CEO@fieldsa.net' }), ['ceo@fieldsa.net', 'abdullah@fieldsa.net', 'anas@fieldsa.net'], 'بلا تكرار');
  assert.deepEqual(leadAlertRecipients({ LEAD_ALERT_EMAILS: 'a@x.co, bad, b@y.co;a@x.co' }), ['info@fieldsa.net', 'a@x.co', 'b@y.co']);
  assert.deepEqual(leadAlertRecipients({ LEAD_ALERT_EMAILS: '   ' }).length, 4, 'فارغة ⇒ الثلاثة');
});

test('الوصل: طلب الاجتماع وإشعار التجربة (التسجيل الذاتي وما يفتحه سفير) يرسلان لحظياً إلى leadAlertRecipients()', () => {
  const contact = src('routes', 'contact.ts');
  const meeting = contact.slice(contact.indexOf("router.post('/meeting'"));
  assert.match(meeting, /to: leadAlertRecipients\(\),\s*subject: `📅 طلب اجتماع من/);
  const tc = src('services', 'trialCompany.ts');
  const notify = tc.slice(tc.indexOf('export async function notifyOwnerNewTrial'), tc.indexOf('// ─', tc.indexOf('export async function notifyOwnerNewTrial')));
  assert.match(notify, /to: leadAlertRecipients\(\),/);
  // المساران يناديان الإشعار نفسه فور الالتزام (لا طابور ولا جدولة)
  assert.match(src('routes', 'auth.ts'), /await notifyOwnerNewTrial\(\{/);
  assert.match(src('services', 'affiliate', 'portalTrial.ts'), /void notifyOwnerNewTrial\(\{/);
  // البريد يقبل مستلمين متعددين
  assert.match(src('services', 'mailer.ts'), /to\?: string \| string\[\];/);
});
