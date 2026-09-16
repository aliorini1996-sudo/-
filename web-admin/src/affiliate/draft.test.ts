import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REGISTER_DRAFT_KEY, clearRegisterDraft, draftOf, isEmptyDraft, loadRegisterDraft, saveRegisterDraft } from './draft';
import { EMPTY_REGISTER, type RegisterForm } from './validation';

/**
 * مسودّة نموذج الانضمام — تبقى عبر الرجوع والتنقّل، ولا تحفظ كلمة المرور أبداً.
 * تخزين الجلسة مزيّف على globalThis (لا DOM في node).
 */

class FakeStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

let saved: PropertyDescriptor | undefined;
const setSession = (v: unknown) => Object.defineProperty(globalThis, 'sessionStorage', { value: v, configurable: true, writable: true });

beforeEach(() => {
  saved = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  setSession(new FakeStorage());
});
afterEach(() => {
  if (saved) Object.defineProperty(globalThis, 'sessionStorage', saved);
  else delete (globalThis as Record<string, unknown>).sessionStorage;
});

const filled = (): RegisterForm => ({
  ...EMPTY_REGISTER,
  fullName: 'سارة أحمد', email: 'sara@example.com', phone: '0551234567', city: 'الرياض',
  password: 'correct-horse-battery', vatNumber: '300000000000003', marketingConsent: true, acceptTerms: true,
});

test('كلمة المرور لا تُحفظ أبداً — ولا الموافقة على الشروط', () => {
  saveRegisterDraft(filled());
  const raw = sessionStorage.getItem(REGISTER_DRAFT_KEY)!;
  assert.ok(raw, 'المسودّة لم تُحفظ');
  assert.ok(!raw.includes('correct-horse-battery'), 'كلمة المرور في التخزين');
  assert.ok(!('password' in JSON.parse(raw)), 'حقل password في المسودّة');
  assert.ok(!('acceptTerms' in JSON.parse(raw)));
  assert.ok(!('password' in draftOf(filled())));
});

test('المسودّة تُستعاد كاملة عدا كلمة المرور والموافقة على الشروط', () => {
  saveRegisterDraft(filled());
  const back = loadRegisterDraft();
  assert.ok(back);
  assert.deepEqual(back, { ...filled(), password: '', acceptTerms: false });
});

test('تُمسح بعد الإرسال الناجح، والنموذج الفارغ لا يُحفظ', () => {
  saveRegisterDraft(filled());
  clearRegisterDraft();
  assert.equal(loadRegisterDraft(), null);
  assert.equal(sessionStorage.getItem(REGISTER_DRAFT_KEY), null);

  assert.equal(isEmptyDraft(draftOf(EMPTY_REGISTER)), true);
  saveRegisterDraft({ ...EMPTY_REGISTER, password: 'only-password' });
  assert.equal(sessionStorage.getItem(REGISTER_DRAFT_KEY), null, 'كلمة مرور وحدها ليست مسودّة');
  saveRegisterDraft({ ...EMPTY_REGISTER, acceptTerms: true });
  assert.equal(sessionStorage.getItem(REGISTER_DRAFT_KEY), null, 'الموافقة وحدها ليست مسودّة');
  saveRegisterDraft({ ...EMPTY_REGISTER, marketingConsent: true });
  assert.ok(sessionStorage.getItem(REGISTER_DRAFT_KEY), 'الموافقة التسويقية وحدها تُحفظ');
  saveRegisterDraft(filled());
  saveRegisterDraft(EMPTY_REGISTER);
  assert.equal(sessionStorage.getItem(REGISTER_DRAFT_KEY), null, 'تفريغ النموذج يمسح المسودّة');
});

test('قيم تالفة: الحقل التالف يُهمل لا النموذج، والتالف كلياً يُمسح', () => {
  sessionStorage.setItem(REGISTER_DRAFT_KEY, JSON.stringify({
    fullName: 'سارة', email: 42, city: 'x'.repeat(500), marketingConsent: 'yes', password: 'leaked', acceptTerms: true,
  }));
  const f = loadRegisterDraft()!;
  assert.equal(f.fullName, 'سارة');
  assert.equal(f.email, '');
  assert.equal(f.city.length, 200);
  assert.equal(f.marketingConsent, false);
  assert.equal(f.password, '', 'كلمة مرور مزروعة في التخزين لا تُقرأ');
  assert.equal(f.acceptTerms, false, 'موافقة مزروعة في التخزين لا تُقرأ');

  for (const bad of ['{nope', '[]', 'null', '"str"']) {
    sessionStorage.setItem(REGISTER_DRAFT_KEY, bad);
    assert.equal(loadRegisterDraft(), null, bad);
  }
});

test('مسودّة قديمة بإقرارات و«موثوق» تُستعاد بحقولها الحالية فقط', () => {
  sessionStorage.setItem(REGISTER_DRAFT_KEY, JSON.stringify({
    fullName: 'سارة أحمد', email: 'sara@example.com', phone: '0551234567', city: 'جدة', vatNumber: '', marketingConsent: true,
    publicPromoter: true, mawthooqNo: '778899', mawthooqExpiry: '2027-06-30',
    declarations: { independent: true, noSpam: true, disclose: true, noSelfReferral: true },
  }));
  const f = loadRegisterDraft()!;
  assert.deepEqual(f, { ...EMPTY_REGISTER, fullName: 'سارة أحمد', email: 'sara@example.com', phone: '0551234567', city: 'جدة', marketingConsent: true });
  for (const k of ['publicPromoter', 'mawthooqNo', 'mawthooqExpiry', 'declarations']) assert.ok(!(k in f), `${k} لا يُستعاد`);
  saveRegisterDraft(f);
  const raw = JSON.parse(sessionStorage.getItem(REGISTER_DRAFT_KEY)!);
  assert.deepEqual(Object.keys(raw).sort(), ['city', 'email', 'fullName', 'marketingConsent', 'phone', 'phoneCountry', 'vatNumber']);
});

test('مفتاح دولة الجوال يُحفظ ويُستعاد، وقيمةٌ تالفة تعود للسعودية', () => {
  saveRegisterDraft({ ...EMPTY_REGISTER, fullName: 'Omar', phoneCountry: 'AE', phone: '501234567' });
  assert.equal(loadRegisterDraft()!.phoneCountry, 'AE');
  sessionStorage.setItem(REGISTER_DRAFT_KEY, JSON.stringify({ fullName: 'Omar', phoneCountry: '<script>' }));
  assert.equal(loadRegisterDraft()!.phoneCountry, 'SA');
  // المفتاح وحده لا يجعل المسودّة «غير فارغة»
  saveRegisterDraft({ ...EMPTY_REGISTER, phoneCountry: 'EG' });
  assert.equal(sessionStorage.getItem(REGISTER_DRAFT_KEY), null);
});

test('تخزين محجوب أو غائب لا يُسقط النموذج', () => {
  setSession(new Proxy({}, { get() { throw new Error('blocked'); } }));
  assert.doesNotThrow(() => saveRegisterDraft(filled()));
  assert.equal(loadRegisterDraft(), null);
  assert.doesNotThrow(() => clearRegisterDraft());
  delete (globalThis as Record<string, unknown>).sessionStorage;
  assert.doesNotThrow(() => saveRegisterDraft(filled()));
  assert.equal(loadRegisterDraft(), null);
});

test('RegisterScreen: يستعيد المسودّة ويحفظها ويمسحها بعد النجاح', () => {
  const s = readFileSync(new URL('./screens/AuthScreens.tsx', import.meta.url), 'utf8');
  const reg = s.match(/export function RegisterScreen[\s\S]*?\n\}\n/);
  assert.ok(reg, 'RegisterScreen غير موجود');
  assert.match(reg![0], /loadRegisterDraft\(\)/, 'لا استعادة للمسودّة');
  assert.match(reg![0], /saveRegisterDraft\(form\)/, 'لا حفظ للمسودّة');
  assert.match(reg![0], /onSuccess: \(message\) => \{ clearRegisterDraft\(\);/, 'المسودّة لا تُمسح بعد الإرسال الناجح');
});
