// اختبارات Z4 لتشفير أسرار وحدات EGS: ذهاب وإياب، ربط السياق (AAD)، العبث بكل جزء، المفتاح الخاطئ، التدوير،
// قراءة البيئة المُمرَّرة بإغلاق عند الخلل، وأن لا رسالة خطأ تحمل نصاً صريحاً أو مادة مفتاح.
// كل المفاتيح هنا تُولَّد وقت التشغيل — لا مفتاح حقيقي ولا ثابت في الملف.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import util from 'util';
import {
  MAX_KEYRING_KEYS, MAX_SECRET_PLAINTEXT_BYTES, SECRETS_ENV_KEY, SECRETS_ENV_PREVIOUS_KEYS, SECRET_PURPOSES, SecretContext, SecretKeyring,
  SecretsError, SecretsErrorCode, createKeyring, decryptSecret, decryptSecretBytes, encryptSecret, inspectStoredSecret, keyIdFor,
  keyringFromEnv, needsReencryption, reencryptSecret, secretAad,
} from './secrets';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const newKey = () => crypto.randomBytes(32);
const KEY_A = newKey();
const KEY_B = newKey();
const RING_A = createKeyring({ current: KEY_A });
const RING_B = createKeyring({ current: KEY_B });
const CTX: SecretContext = { purpose: 'egs-key', ownerId: 'unit_01J8Z4ABCDEF' };

/** نصّ صريح يشبه مفتاحاً خاصاً بصيغة PEM، مبنيّ وقت التشغيل (لا ترويسة مفتاح حرفية في الملف). */
function fakePem(): string {
  const label = ['EC', 'PRIVATE', 'KEY'].join(' ');
  return `-----BEGIN ${label}-----\n${crypto.randomBytes(90).toString('base64')}\n-----END ${label}-----\n`;
}

function expectCode(fn: () => unknown, code: SecretsErrorCode, why = ''): SecretsError {
  let caught: unknown;
  assert.throws(fn, (e: unknown) => {
    caught = e;
    assert.ok(e instanceof SecretsError, `${why}: ${String(e)}`);
    assert.equal(e.code, code, `${why}: ${e.message}`);
    return true;
  });
  return caught as SecretsError;
}

/** يعدّل بايتاً في جزء base64url ويعيد ترميزه قانونياً (فالرفض من المصادقة لا من فحص الصيغة). */
function flipSegment(stored: string, index: 2 | 3 | 4, byte = 0): string {
  const parts = stored.split(':');
  const b = Buffer.from(parts[index], 'base64url');
  b[byte] ^= 0x01;
  parts[index] = b.toString('base64url');
  return parts.join(':');
}

test('ذهاب وإياب: نصّ UTF-8 (عربي ومفتاح PEM) وبايتات؛ الصيغة v1:<kid>:<iv>:<tag>:<ct>؛ IV عشوائي لكل تشفير', () => {
  const pem = fakePem();
  const stored = encryptSecret(pem, CTX, RING_A);
  assert.match(stored, /^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$/);
  const [version, kid, iv, tag, ct] = stored.split(':');
  assert.equal(version, 'v1');
  assert.equal(kid, RING_A.currentKid);
  assert.equal(kid, keyIdFor(KEY_A));
  assert.equal(Buffer.from(iv, 'base64url').length, 12);
  assert.equal(Buffer.from(tag, 'base64url').length, 16);
  assert.equal(Buffer.from(ct, 'base64url').length, Buffer.byteLength(pem), 'GCM بلا حشو: طول النصّ المشفّر = طول الصريح');
  assert.equal(decryptSecret(stored, CTX, RING_A), pem);
  assert.deepEqual(inspectStoredSecret(stored), { version: 'v1', kid });

  const again = encryptSecret(pem, CTX, RING_A);
  assert.notEqual(again, stored, 'IV جديد ⇒ نصّ مشفّر مختلف');
  assert.notEqual(again.split(':')[2], iv);
  assert.equal(decryptSecret(again, CTX, RING_A), pem);

  const arabic = 'سرّ الوحدة — Dehvg1fc8GF6Jwt5bOxXwC6enR93VxeNEo2mlUatfgw= 🔐';
  assert.equal(decryptSecret(encryptSecret(arabic, { purpose: 'pcsid-secret', ownerId: 'u-1' }, RING_A), { purpose: 'pcsid-secret', ownerId: 'u-1' }, RING_A), arabic);

  const bytes = crypto.randomBytes(300);
  const copy = Buffer.from(bytes);
  const sb = encryptSecret(bytes, CTX, RING_A);
  assert.deepEqual(bytes, copy, 'مخزن المستدعي لا يُعدَّل (لا يُصفَّر)');
  const out = decryptSecretBytes(sb, CTX, RING_A);
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual(out, bytes);
  out.fill(0); // على المستدعي
  // بايتات ليست UTF-8 صالحاً لا تُعاد نصاً مشوّهاً
  expectCode(() => decryptSecret(encryptSecret(Uint8Array.from([0xff, 0xfe, 0x80]), CTX, RING_A), CTX, RING_A), 'PLAINTEXT_INVALID');
});

test('سياق الربط إلزامي ومصادَق: مالك آخر أو غرض آخر ⇒ DECRYPT_FAILED؛ سياق مشوّه ⇒ CONTEXT_INVALID', () => {
  assert.equal(secretAad(CTX), 'zatca:egs-key:unit_01J8Z4ABCDEF');
  const stored = encryptSecret('secret-value', CTX, RING_A);
  expectCode(() => decryptSecret(stored, { purpose: 'egs-key', ownerId: 'unit_01J8Z4ABCDEG' }, RING_A), 'DECRYPT_FAILED', 'وحدة أخرى');
  for (const purpose of SECRET_PURPOSES.filter(p => p !== 'egs-key')) {
    expectCode(() => decryptSecret(stored, { purpose, ownerId: CTX.ownerId }, RING_A), 'DECRYPT_FAILED', `غرض ${purpose}`);
  }
  // تبادل قيمتين مخزّنتين بين وحدتين يفشل في الاتجاهين
  const ctx2: SecretContext = { purpose: 'egs-key', ownerId: 'unit_other' };
  const s2 = encryptSecret('other-secret', ctx2, RING_A);
  expectCode(() => decryptSecret(s2, CTX, RING_A), 'DECRYPT_FAILED');
  expectCode(() => decryptSecret(stored, ctx2, RING_A), 'DECRYPT_FAILED');

  const bad: unknown[] = [
    undefined, null, 'zatca:egs-key:u', {}, { purpose: 'egs-key' }, { ownerId: 'u' }, { purpose: 'EGS-KEY', ownerId: 'u' },
    { purpose: 'api-token', ownerId: 'u' }, { purpose: 'egs-key', ownerId: '' }, { purpose: 'egs-key', ownerId: 'a:b' },
    { purpose: 'egs-key', ownerId: 'a b' }, { purpose: 'egs-key', ownerId: 'x'.repeat(129) }, { purpose: 'egs-key', ownerId: 42 },
  ];
  for (const c of bad) {
    expectCode(() => encryptSecret('v', c as SecretContext, RING_A), 'CONTEXT_INVALID', `encrypt ${util.inspect(c)}`);
    expectCode(() => decryptSecret(stored, c as SecretContext, RING_A), 'CONTEXT_INVALID', `decrypt ${util.inspect(c)}`);
  }
});

test('العبث بـIV أو الوسم أو النصّ المشفّر أو الترويسة ⇒ فشل؛ صيغة مشوّهة ⇒ FORMAT_INVALID/UNSUPPORTED_VERSION', () => {
  const stored = encryptSecret(fakePem(), CTX, RING_A);
  for (const [idx, what] of [[2, 'IV'], [3, 'الوسم'], [4, 'النصّ المشفّر']] as const) {
    for (const byte of [0, 5, 11]) {
      const t = flipSegment(stored, idx, byte);
      assert.notEqual(t, stored);
      expectCode(() => decryptSecret(t, CTX, RING_A), 'DECRYPT_FAILED', `${what} بايت ${byte}`);
    }
  }
  const parts = stored.split(':');
  // حذف بايت من آخر النصّ المشفّر، أو إلحاق بايت
  const ct = Buffer.from(parts[4], 'base64url');
  for (const alt of [ct.subarray(0, ct.length - 1), Buffer.concat([ct, Buffer.from([0])])]) {
    expectCode(() => decryptSecret([...parts.slice(0, 4), alt.toString('base64url')].join(':'), CTX, RING_A), 'DECRYPT_FAILED', 'طول مختلف');
  }
  // الترويسة مصادَقة: نقل النصّ المشفّر إلى kid مفتاح آخر موجود في الحلقة ⇒ فشل مصادقة لا فكّ بمفتاح آخر
  const both = createKeyring({ current: KEY_A, previous: [KEY_B] });
  expectCode(() => decryptSecret([parts[0], RING_B.currentKid, ...parts.slice(2)].join(':'), CTX, both), 'DECRYPT_FAILED', 'kid مبدَّل');
  expectCode(() => decryptSecret([parts[0], 'AAAAAAAAAAAAAAAA', ...parts.slice(2)].join(':'), CTX, RING_A), 'UNKNOWN_KEY_ID');

  expectCode(() => decryptSecret(`v2:${parts.slice(1).join(':')}`, CTX, RING_A), 'UNSUPPORTED_VERSION');
  const malformed: unknown[] = [
    '', 42, null, 'v1', parts.slice(0, 4).join(':'), `${stored}:extra`, `V1:${parts.slice(1).join(':')}`, `x${stored}`,
    [parts[0], 'kid!', ...parts.slice(2)].join(':'),
    [...parts.slice(0, 2), 'AAAA', ...parts.slice(3)].join(':'), // IV 3 بايت
    [...parts.slice(0, 3), 'AAAA', parts[4]].join(':'), // وسم قصير
    [...parts.slice(0, 4), ''].join(':'), // نصّ مشفّر فارغ
    [...parts.slice(0, 2), `${parts[2]}=`, ...parts.slice(3)].join(':'), // حشو
    [...parts.slice(0, 2), `${parts[2].slice(0, 15)}/`, ...parts.slice(3)].join(':'), // محرف base64 عادي لا base64url
    'v1:' + 'A'.repeat(200000),
  ];
  for (const m of malformed) expectCode(() => decryptSecret(m as string, CTX, RING_A), 'FORMAT_INVALID', `مشوّه ${String(m).slice(0, 40)}`);
  // base64url غير قانوني: الوسم 22 محرفاً لـ16 بايتاً ⇒ آخر 4 بتات حشو يجب أن تكون صفراً؛ بتّ حشو واحد ⇒ رفض الصيغة
  const tagText = parts[3];
  const nonCanonical = tagText.slice(0, -1) + B64U[B64U.indexOf(tagText[21]) | 0x01];
  assert.deepEqual(Buffer.from(nonCanonical, 'base64url'), Buffer.from(tagText, 'base64url'), 'Buffer يتجاهل بتات الحشو — فالفحص القانوني لازم');
  expectCode(() => decryptSecret([...parts.slice(0, 3), nonCanonical, parts[4]].join(':'), CTX, RING_A), 'FORMAT_INVALID', 'base64url غير قانوني');
});

test('المفتاح الخاطئ: حلقة بلا المفتاح ⇒ UNKNOWN_KEY_ID؛ المعرّف مشتقّ من المفتاح فلا يُفكّ بمفتاح آخر أبداً', () => {
  const stored = encryptSecret('value', CTX, RING_A);
  expectCode(() => decryptSecret(stored, CTX, RING_B), 'UNKNOWN_KEY_ID');
  assert.notEqual(RING_A.currentKid, RING_B.currentKid);
  // حلقة مزوّرة (كائن عادي بالشكل نفسه) لا تُقبل
  const forged = { currentKid: RING_A.currentKid, kids: [RING_A.currentKid] } as SecretKeyring;
  expectCode(() => decryptSecret(stored, CTX, forged), 'KEYRING_INVALID');
  expectCode(() => encryptSecret('v', CTX, forged), 'KEYRING_INVALID');
  expectCode(() => encryptSecret('v', CTX, undefined as unknown as SecretKeyring), 'KEYRING_INVALID');
});

test('التدوير: الحلقة الجديدة تفكّ القديم وتشفّر بالجديد، وreencryptSecret ينقل القيمة، وإزالة القديم بعدها آمنة', () => {
  const oldStored = encryptSecret('pcsid-secret-value', { purpose: 'pcsid-secret', ownerId: 'unit1' }, RING_A);
  const rotated = createKeyring({ current: KEY_B, previous: [KEY_A] });
  assert.equal(rotated.currentKid, RING_B.currentKid);
  assert.deepEqual([...rotated.kids], [RING_B.currentKid, RING_A.currentKid]);
  const ctx: SecretContext = { purpose: 'pcsid-secret', ownerId: 'unit1' };
  assert.equal(decryptSecret(oldStored, ctx, rotated), 'pcsid-secret-value');
  assert.equal(needsReencryption(oldStored, rotated), true);
  const fresh = encryptSecret('new', ctx, rotated);
  assert.equal(inspectStoredSecret(fresh).kid, RING_B.currentKid);
  assert.equal(needsReencryption(fresh, rotated), false);

  const r = reencryptSecret(oldStored, ctx, rotated);
  assert.equal(r.rotated, true);
  assert.equal(inspectStoredSecret(r.stored).kid, RING_B.currentKid);
  assert.equal(decryptSecret(r.stored, ctx, RING_B), 'pcsid-secret-value', 'بعد إزالة المفتاح القديم');
  expectCode(() => decryptSecret(oldStored, ctx, RING_B), 'UNKNOWN_KEY_ID', 'القديم بلا مفتاحه');
  const same = reencryptSecret(r.stored, ctx, rotated);
  assert.deepEqual(same, { stored: r.stored, rotated: false });
  // إعادة التشفير تتحقق بالسياق أولاً: لا «تغسل» قيمة من وحدة أخرى
  expectCode(() => reencryptSecret(oldStored, { purpose: 'pcsid-secret', ownerId: 'unit2' }, rotated), 'DECRYPT_FAILED');

  // المفتاح نفسه مكرّراً يُتجاهل؛ حلقة أكبر من الحدّ ترفض
  assert.equal(createKeyring({ current: KEY_A, previous: [KEY_A, KEY_A.toString('hex')] }).kids.length, 1);
  expectCode(() => createKeyring({ current: KEY_A, previous: Array.from({ length: MAX_KEYRING_KEYS }, newKey) }), 'KEYRING_INVALID');
});

test('keyringFromEnv: كائن بيئة مُمرَّر، hex/base64/base64url صالحة، وكل خلل يرمي (fail closed) بلا قيمة افتراضية', () => {
  const hex = KEY_A.toString('hex');
  const b64 = KEY_A.toString('base64');
  const b64u = KEY_A.toString('base64url');
  assert.equal(b64.length, 44);
  assert.equal(b64u.length, 43);
  for (const v of [hex, hex.toUpperCase(), b64, b64u]) {
    const ring = keyringFromEnv({ [SECRETS_ENV_KEY]: v });
    assert.equal(ring.currentKid, RING_A.currentKid, `الصيغة ${v.length}`);
    assert.equal(decryptSecret(encryptSecret('x', CTX, RING_A), CTX, ring), 'x');
  }
  const withPrev = keyringFromEnv({ [SECRETS_ENV_KEY]: hex, [SECRETS_ENV_PREVIOUS_KEYS]: `${KEY_B.toString('base64')},${newKey().toString('hex')}` });
  assert.equal(withPrev.kids.length, 3);
  assert.equal(keyringFromEnv({ [SECRETS_ENV_KEY]: hex, [SECRETS_ENV_PREVIOUS_KEYS]: '' }).kids.length, 1, 'PREVIOUS فارغة = لا مفاتيح سابقة');

  // لا قراءة ضمنية لـprocess.env
  const saved = process.env[SECRETS_ENV_KEY];
  process.env[SECRETS_ENV_KEY] = hex;
  try {
    expectCode(() => keyringFromEnv({}), 'KEY_MISSING', 'process.env لا يُقرأ');
  } finally {
    if (saved === undefined) delete process.env[SECRETS_ENV_KEY]; else process.env[SECRETS_ENV_KEY] = saved;
  }

  const cases: Array<[Record<string, unknown> | undefined, SecretsErrorCode, string]> = [
    [undefined, 'KEY_MISSING', 'بلا كائن'],
    [{}, 'KEY_MISSING', 'غائب'],
    [{ [SECRETS_ENV_KEY]: '' }, 'KEY_MISSING', 'فارغ'],
    [{ [SECRETS_ENV_KEY]: hex.slice(0, 62) }, 'KEY_LENGTH', 'hex قصير (31 بايت)'],
    [{ [SECRETS_ENV_KEY]: hex.slice(0, 32) }, 'KEY_LENGTH', 'hex 16 بايت'],
    [{ [SECRETS_ENV_KEY]: `${hex}00` }, 'KEY_LENGTH', 'hex طويل'],
    [{ [SECRETS_ENV_KEY]: `${hex.slice(0, 63)}` }, 'KEY_LENGTH', 'hex بطول فردي'],
    [{ [SECRETS_ENV_KEY]: crypto.randomBytes(16).toString('base64') }, 'KEY_LENGTH', 'base64 لـ16 بايت'],
    [{ [SECRETS_ENV_KEY]: crypto.randomBytes(48).toString('base64') }, 'KEY_LENGTH', 'base64 لـ48 بايت'],
    [{ [SECRETS_ENV_KEY]: ` ${hex}` }, 'KEY_MALFORMED', 'فراغ بادئ'],
    [{ [SECRETS_ENV_KEY]: `${hex}\n` }, 'KEY_MALFORMED', 'سطر جديد لاحق'],
    [{ [SECRETS_ENV_KEY]: `${b64}\r\n` }, 'KEY_MALFORMED', 'CRLF لاحق'],
    [{ [SECRETS_ENV_KEY]: `${hex.slice(0, 32)} ${hex.slice(32)}` }, 'KEY_MALFORMED', 'فراغ داخلي'],
    [{ [SECRETS_ENV_KEY]: `\t${b64u}` }, 'KEY_MALFORMED', 'تاب'],
    [{ [SECRETS_ENV_KEY]: 'change-me-please!' }, 'KEY_MALFORMED', 'نصّ عشوائي'],
    [{ [SECRETS_ENV_KEY]: `+/${b64.slice(2, 43)}` }, 'KEY_MALFORMED', 'base64 بحشو ناقص'],
    [{ [SECRETS_ENV_KEY]: `${b64.slice(0, 42)}${B64[B64.indexOf(b64[42]) | 0x01]}=` }, 'KEY_MALFORMED', 'base64 غير قانوني (بتات حشو غير صفرية)'],
    [{ [SECRETS_ENV_KEY]: `${b64u.slice(0, 42)}${B64U[B64U.indexOf(b64u[42]) | 0x01]}` }, 'KEY_MALFORMED', 'base64url غير قانوني (بتات حشو غير صفرية)'],
    [{ [SECRETS_ENV_KEY]: `-+${b64u.slice(2)}` }, 'KEY_MALFORMED', 'خلط أبجديتَي base64 وbase64url'],
    [{ [SECRETS_ENV_KEY]: '0'.repeat(64) }, 'KEY_WEAK', 'أصفار'],
    [{ [SECRETS_ENV_KEY]: 'f'.repeat(64) }, 'KEY_WEAK', 'بايتات متساوية'],
    [{ [SECRETS_ENV_KEY]: 42 }, 'KEY_MALFORMED', 'ليس نصاً'],
    [{ [SECRETS_ENV_KEY]: hex, [SECRETS_ENV_PREVIOUS_KEYS]: 'nope!' }, 'KEY_MALFORMED', 'سابق مشوّه'],
    [{ [SECRETS_ENV_KEY]: hex, [SECRETS_ENV_PREVIOUS_KEYS]: 'nope' }, 'KEY_LENGTH', 'سابق base64url لـ3 بايت'],
    [{ [SECRETS_ENV_KEY]: hex, [SECRETS_ENV_PREVIOUS_KEYS]: `${KEY_B.toString('hex')},` }, 'KEY_MALFORMED', 'عنصر فارغ'],
    [{ [SECRETS_ENV_KEY]: hex, [SECRETS_ENV_PREVIOUS_KEYS]: `${KEY_B.toString('hex')}, ${newKey().toString('hex')}` }, 'KEY_MALFORMED', 'فراغ بعد الفاصلة'],
    [{ [SECRETS_ENV_KEY]: hex, [SECRETS_ENV_PREVIOUS_KEYS]: KEY_B.toString('hex').slice(2) }, 'KEY_LENGTH', 'سابق قصير'],
  ];
  for (const [env, code, why] of cases) {
    const e = expectCode(() => keyringFromEnv(env as Record<string, string>), code, why);
    assert.ok(e.message.includes(SECRETS_ENV_KEY), `${why}: الرسالة تسمّي المتغيّر — ${e.message}`);
  }
  // المواد الصريحة بالقواعد نفسها
  expectCode(() => createKeyring({ current: crypto.randomBytes(31) }), 'KEY_LENGTH');
  expectCode(() => createKeyring({ current: new Uint8Array(32) }), 'KEY_WEAK');
  expectCode(() => createKeyring({ current: undefined as unknown as Uint8Array }), 'KEY_MISSING');
  expectCode(() => createKeyring({ current: 12345 as unknown as string }), 'KEY_MALFORMED');
});

test('لا رسالة خطأ ولا حلقة مفاتيح تكشف نصاً صريحاً أو مادة مفتاح', () => {
  const key = newKey();
  const ring = createKeyring({ current: key, previous: [KEY_B] });
  const forms = [key.toString('hex'), key.toString('hex').toUpperCase(), key.toString('base64'), key.toString('base64url'), KEY_B.toString('hex')];
  const plaintext = `${fakePem()}PLAINTEXT-MARKER-${crypto.randomBytes(8).toString('hex')}`;
  const stored = encryptSecret(plaintext, CTX, ring);
  const errors: SecretsError[] = [];
  const collect = (fn: () => unknown) => {
    try { fn(); assert.fail('كان يجب أن يرمي'); } catch (e) { assert.ok(e instanceof SecretsError, String(e)); errors.push(e); }
  };
  collect(() => decryptSecret(stored, { ...CTX, ownerId: 'other' }, ring));
  collect(() => decryptSecret(flipSegment(stored, 4), CTX, ring));
  collect(() => decryptSecret(flipSegment(stored, 3), CTX, ring));
  collect(() => decryptSecret(stored, CTX, RING_A));
  collect(() => decryptSecret(`${stored}:x`, CTX, ring));
  collect(() => decryptSecret(`v9:${stored.slice(3)}`, CTX, ring));
  collect(() => encryptSecret(`${plaintext}\uD800`, CTX, ring));
  collect(() => encryptSecret('x'.repeat(MAX_SECRET_PLAINTEXT_BYTES + 1), CTX, ring));
  collect(() => encryptSecret('', CTX, ring));
  collect(() => encryptSecret(plaintext, { purpose: 'egs-key', ownerId: plaintext }, ring));
  collect(() => keyringFromEnv({ [SECRETS_ENV_KEY]: `${key.toString('hex')} ` }));
  collect(() => keyringFromEnv({ [SECRETS_ENV_KEY]: key.toString('hex').slice(1) }));
  collect(() => keyringFromEnv({ [SECRETS_ENV_KEY]: `${key.toString('base64')}\n` }));
  collect(() => keyringFromEnv({ [SECRETS_ENV_KEY]: key.toString('base64').slice(0, 40) }));
  collect(() => keyringFromEnv({ [SECRETS_ENV_KEY]: key.toString('hex'), [SECRETS_ENV_PREVIOUS_KEYS]: `${KEY_B.toString('hex')}!` }));
  collect(() => createKeyring({ current: key.subarray(0, 31) }));
  assert.equal(errors.length, 16);
  const secrets = [...forms, plaintext, 'PLAINTEXT-MARKER', key.toString('hex').slice(1), key.toString('base64').slice(0, 40), stored.split(':')[4]];
  for (const e of errors) {
    const surfaces = [e.message, String(e), e.stack ?? '', JSON.stringify(e), util.inspect(e)];
    for (const s of surfaces) {
      for (const secret of secrets) assert.ok(!s.includes(secret), `${e.code}: الرسالة تكشف مادة سرّية`);
    }
    assert.equal((e as { cause?: unknown }).cause, undefined, 'لا cause من OpenSSL');
  }
  // الحلقة معتمة
  for (const view of [JSON.stringify(ring), util.inspect(ring, { depth: 10, showHidden: true }), Object.keys(ring).join()]) {
    for (const f of forms) assert.ok(!view.includes(f), 'الحلقة تكشف مادة مفتاح');
  }
  assert.deepEqual(Object.keys(ring).sort(), ['currentKid', 'kids']);
  assert.ok(Object.isFrozen(ring));
});

test('النصّ الصريح: فارغ أو أكبر من الحدّ أو بديل منفرد أو نوع خاطئ ⇒ PLAINTEXT_INVALID', () => {
  expectCode(() => encryptSecret('', CTX, RING_A), 'PLAINTEXT_INVALID');
  expectCode(() => encryptSecret(new Uint8Array(0), CTX, RING_A), 'PLAINTEXT_INVALID');
  expectCode(() => encryptSecret(Buffer.alloc(MAX_SECRET_PLAINTEXT_BYTES + 1, 1), CTX, RING_A), 'PLAINTEXT_INVALID');
  expectCode(() => encryptSecret('abc\uDC00', CTX, RING_A), 'PLAINTEXT_INVALID');
  expectCode(() => encryptSecret(123 as unknown as string, CTX, RING_A), 'PLAINTEXT_INVALID');
  const max = Buffer.alloc(MAX_SECRET_PLAINTEXT_BYTES, 7);
  assert.deepEqual(decryptSecretBytes(encryptSecret(max, CTX, RING_A), CTX, RING_A), max, 'الحدّ نفسه مقبول');
});

test('decryptSecretBytes: الناتج في ArrayBuffer مستقل بطوله بالضبط، لا شريحة من مجمّع Node المشترك (8 KiB) يكشفها .buffer مخزنٍ آخر', () => {
  const egsKeyPem = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey.export({ type: 'sec1', format: 'pem' }) as string;
  const cases: Array<[string, string | Uint8Array, SecretContext]> = [
    ['مفتاح EGS بصيغة PEM', egsKeyPem, { purpose: 'egs-key', ownerId: 'unit1' }],
    ['سرّ CSID (44 محرفاً)', crypto.randomBytes(32).toString('base64'), { purpose: 'pcsid-secret', ownerId: 'unit1' }],
    ['بايت واحد', Uint8Array.from([7]), CTX],
    ['4095 بايتاً (آخر حجم يأخذه المجمّع)', Buffer.alloc(4095, 0x5a), CTX],
    ['5 KiB (خارج المجمّع أصلاً)', Buffer.alloc(5 * 1024, 0x33), CTX],
  ];
  for (const [why, plain, ctx] of cases) {
    const stored = encryptSecret(plain, ctx, RING_A);
    const out = decryptSecretBytes(stored, ctx, RING_A);
    const unrelated = Buffer.allocUnsafe(5); // شريحة من المجمّع المشترك
    try {
      const expected = typeof plain === 'string' ? Buffer.byteLength(plain) : plain.length;
      assert.equal(out.length, expected, why);
      assert.equal(out.byteOffset, 0, `${why}: ليس شريحة داخل مخزن أكبر`);
      assert.equal(out.buffer.byteLength, out.length, `${why}: ArrayBuffer بطول الناتج بالضبط`);
      assert.notEqual(out.buffer, unrelated.buffer, `${why}: لا يشارك مخزناً صغيراً آخر`);
      // الإبرة خارج المجمّع (allocUnsafeSlow)، فالعثور عليها في مخزن unrelated يعني أن المجمّع يحمل النصّ الصريح
      // (للنصوص الطويلة وحدها: بايت واحد يوجد في أي مخزن مصادفةً)
      if (expected >= 16) {
        const needle = Buffer.allocUnsafeSlow(expected);
        out.copy(needle);
        assert.equal(Buffer.from(unrelated.buffer).indexOf(needle), -1, `${why}: .buffer لمخزن آخر يكشف النصّ الصريح`);
        needle.fill(0);
      }
    } finally {
      out.fill(0);
    }
  }
});

test('secrets.ts نقيّ: يستورد crypto وحده، ولا يقرأ process.env ضمنياً، ولا نصّ ترويسة مفتاح خاص حرفياً', () => {
  const src = fs.readFileSync(path.join(__dirname, 'secrets.ts'), 'utf8');
  const imports = [...src.matchAll(/^import\s+[\s\S]*?from\s+'([^']+)';/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['crypto']);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/process\.env|require\(|@prisma|fetch\(/.test(code));
  assert.ok(!src.includes(['BEGIN', 'PRIVATE', 'KEY'].join(' ')) && !src.includes(['BEGIN EC', 'PRIVATE', 'KEY'].join(' ')));
});
