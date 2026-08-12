import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  generateEgsKeyPair, sha256Base64, sha256Hex, INITIAL_PIH, newInvoiceUuid, signSha256, verifySha256,
} from './crypto';

test('توليد مفتاح EC على منحنى secp256k1 صالح بصيغة PEM', () => {
  const { privateKeyPem, publicKeyPem } = generateEgsKeyPair();
  assert.match(privateKeyPem, /-----BEGIN EC PRIVATE KEY-----/);
  assert.match(publicKeyPem, /-----BEGIN PUBLIC KEY-----/);
  // المنحنى المطلوب من الهيئة تحديداً (لا P-256)
  const jwk = crypto.createPrivateKey(privateKeyPem).export({ format: 'jwk' }) as { crv?: string };
  assert.equal(jwk.crv, 'secp256k1');
});

test('كل استدعاء يولّد مفتاحاً مختلفاً', () => {
  assert.notEqual(generateEgsKeyPair().privateKeyPem, generateEgsKeyPair().privateKeyPem);
});

test('SHA-256 base64/hex: متّجه معروف "abc"', () => {
  const hex = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.equal(sha256Hex('abc'), hex);
  assert.equal(sha256Base64('abc'), Buffer.from(hex, 'hex').toString('base64'));
});

test('PIH الأوّليّة = base64 لسلسلة hex لـ SHA-256("0") (حارس الاشتقاق)', () => {
  const derived = Buffer.from(sha256Hex('0'), 'utf8').toString('base64');
  assert.equal(INITIAL_PIH, derived);
  assert.equal(INITIAL_PIH, 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==');
});

test('التوقيع والتحقّق يتّسقان (ECDSA)، والعبث يُبطل التحقّق', () => {
  const { privateKeyPem, publicKeyPem } = generateEgsKeyPair();
  const sig = signSha256('hello ZATCA', privateKeyPem);
  assert.equal(verifySha256('hello ZATCA', sig, publicKeyPem), true);
  assert.equal(verifySha256('tampered', sig, publicKeyPem), false);
});

test('UUID الفاتورة بصيغة v4 صحيحة', () => {
  assert.match(newInvoiceUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
