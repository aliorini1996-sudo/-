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
  password: 'correct-horse-battery', publicPromoter: true, mawthooqNo: '778899', mawthooqExpiry: '2027-06-30',
  vatNumber: '300000000000003', marketingConsent: true, acceptTerms: true,
  declarations: { independent: true, noSpam: false, disclose: true, noSelfReferral: false },
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
  saveRegisterDraft(filled());
  saveRegisterDraft(EMPTY_REGISTER);
  assert.equal(sessionStorage.getItem(REGISTER_DRAFT_KEY), null, 'تفريغ النموذج يمسح المسودّة');
});

test('قيم تالفة: الحقل التالف يُهمل لا النموذج، والتالف كلياً يُمسح', () => {
  sessionStorage.setItem(REGISTER_DRAFT_KEY, JSON.stringify({
    fullName: 'سارة', email: 42, city: 'x'.repeat(500), publicPromoter: 'yes', password: 'leaked',
    declarations: { independent: true, noSpam: 'true' },
  }));
  const f = loadRegisterDraft()!;
  assert.equal(f.fullName, 'سارة');
  assert.equal(f.email, '');
  assert.equal(f.city.length, 200);
  assert.equal(f.publicPromoter, false);
  assert.equal(f.password, '', 'كلمة مرور مزروعة في التخزين لا تُقرأ');
  assert.deepEqual(f.declarations, { independent: true, noSpam: false, disclose: false, noSelfReferral: false });

  for (const bad of ['{nope', '[]', 'null', '"str"']) {
    sessionStorage.setItem(REGISTER_DRAFT_KEY, bad);
    assert.equal(loadRegisterDraft(), null, bad);
  }
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
