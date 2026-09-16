// اختبارات Z2 لقارئ وكاتب DER: ترميزات معروفة، ذهاب وإياب، وصرامة DER (لا تعتمد على عيّنات الـSDK).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  DerError, TAG, childrenOf, decodeBitString, decodeInteger, decodeOid, decodeString, decodeTime, encBitString, encBoolean,
  encContext, encGeneralizedTime, encIa5String, encInteger, encNull, encOctetString, encOid, encPrintableString, encSequence,
  encSet, encTlv, encUtcTime, encUtf8String, parseDer, readDer,
} from './der';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/\s+/g, ''), 'hex'));
const derErr = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof DerError);

test('INTEGER: ترميزات X.690 المعروفة وذهاب وإياب بإشارة وبأقصر صيغة', () => {
  const known: Array<[bigint | number, string]> = [
    [0, '020100'], [1, '020101'], [127, '02017f'], [128, '02020080'], [255, '020200ff'], [256, '02020100'],
    [-1, '0201ff'], [-128, '020180'], [-129, '0202ff7f'], [-256, '0202ff00'], [BigInt('18446744073709551616'), '0209010000000000000000'],
  ];
  for (const [v, h] of known) {
    assert.equal(hex(encInteger(v)), h, String(v));
    assert.equal(decodeInteger(parseDer(unhex(h))), BigInt(v), h);
  }
  // الرقم التسلسلي لشهادة الاختبار الرسمية (19 بايت بعد الترميز)
  const serial = BigInt('379112742831380471835263969587287663520528387');
  assert.equal(decodeInteger(parseDer(encInteger(serial))), serial);
  // من بايتات مقدار بلا إشارة: البت الأعلى يستلزم 00 بادئاً، والأصفار الزائدة تُقصّ
  assert.equal(hex(encInteger(unhex('80'))), '02020080');
  assert.equal(hex(encInteger(unhex('0000017f'))), '0202017f');
  assert.equal(hex(encInteger(new Uint8Array(0))), '020100');
  for (let i = 0; i < 2000; i++) {
    const v = BigInt.asIntN(128, BigInt(`0x${crypto.randomBytes(16).toString('hex')}`)) >> BigInt(i % 120);
    assert.equal(decodeInteger(parseDer(encInteger(v))), v);
  }
  derErr(() => decodeInteger(parseDer(unhex('0202007f'))));
  derErr(() => decodeInteger(parseDer(unhex('0202ff80'))));
  derErr(() => decodeInteger(parseDer(unhex('0200'))));
  derErr(() => encInteger(1.5));
});

test('OID: ترميزات معروفة (ecPublicKey، secp256k1، ecdsa-with-SHA256، DC) وذهاب وإياب لأقواس كبيرة', () => {
  const known: Array<[string, string]> = [
    ['1.2.840.10045.2.1', '06072a8648ce3d0201'],
    ['1.3.132.0.10', '06052b8104000a'],
    ['1.2.840.10045.4.3.2', '06082a8648ce3d040302'],
    ['0.9.2342.19200300.100.1.25', '060a0992268993f22c640119'],
    ['2.5.4.3', '0603550403'],
    ['1.3.6.1.4.1.311.20.2', '06092b0601040182371402'],
  ];
  for (const [oid, h] of known) {
    assert.equal(hex(encOid(oid)), h, oid);
    assert.equal(decodeOid(parseDer(unhex(h))), oid);
  }
  for (const oid of ['2.999.3', '2.100.1', '0.0', '1.39.18446744073709551616.7']) assert.equal(decodeOid(parseDer(encOid(oid))), oid);
  for (const bad of ['1', '3.1', '1.40', '1.2.03', '1..2', 'a.b']) derErr(() => encOid(bad));
  derErr(() => decodeOid(parseDer(unhex('06022a80'))));  // مبتور
  derErr(() => decodeOid(parseDer(unhex('0603808001')))); // غير أقصر
});

test('الطول: الصيغة القصيرة والطويلة بأقصر ترميز، ورفض غير المحدود وغير الأقصر والمبتور والزائد', () => {
  for (const n of [0, 1, 127, 128, 255, 256, 300, 65535, 65536, 200000]) {
    const enc = encOctetString(new Uint8Array(n));
    const node = parseDer(enc);
    assert.equal(node.value.length, n);
    assert.equal(node.valueOffset, n < 0x80 ? 2 : n < 0x100 ? 3 : n < 0x10000 ? 4 : 5, `رأس الطول ${n}`);
  }
  assert.equal(hex(encOctetString(new Uint8Array(200))).slice(0, 6), '0481c8');
  assert.equal(hex(encOctetString(new Uint8Array(300))).slice(0, 8), '0482012c');
  derErr(() => parseDer(unhex('3080')));          // غير محدود
  derErr(() => parseDer(unhex('04810a' + '00'.repeat(10)))); // طويل لطول قصير
  derErr(() => parseDer(unhex('0482000a' + '00'.repeat(10)))); // بايت صفري بادئ
  derErr(() => parseDer(unhex('0405000000')));    // مبتور
  derErr(() => parseDer(unhex('040100ff')));      // بايت زائد
  derErr(() => parseDer(unhex('04')));
  derErr(() => parseDer(unhex('0485ffffffffff')));
  assert.equal(readDer(unhex('040100ff')).end, 3, 'readDer يقبل ما بعد الـTLV');
  // وسم برقم طويل (مقروء) ورفض الطويل غير الأقصر
  assert.equal(parseDer(unhex('9f2000')).tagNumber, 32);
  derErr(() => parseDer(unhex('9f0100')));
  derErr(() => parseDer(unhex('9f808100')));
  // حدّ العمق
  let deep: Uint8Array = encNull();
  for (let i = 0; i < 40; i++) deep = encSequence([deep]);
  derErr(() => parseDer(deep));
});

test('SEQUENCE/SET/السياقي: ذهاب وإياب، SET OF مرتّب بايتياً، وإعادة بناء SPKI من node:crypto بايتاً ببايت', () => {
  const set = encSet([encInteger(3), encInteger(1), encPrintableString('B'), encInteger(2)]);
  assert.equal(hex(set), '310c020101020102020103130142');
  assert.equal(hex(encSet([encInteger(3), encInteger(1)], false)), '3106020103020101');
  const seq = encSequence([encBoolean(true), encNull(), encContext(0, encInteger(2)), encContext(1, unhex('abcd'), false), encOctetString(unhex('00ff'))]);
  const node = parseDer(seq);
  const kids = childrenOf(node);
  assert.deepEqual(kids.map(k => k.tag), [TAG.BOOLEAN, TAG.NULL, 0xa0, 0x81, TAG.OCTET_STRING]);
  assert.equal(kids[2].cls, 'context');
  assert.equal(decodeInteger(childrenOf(kids[2])[0]), BigInt(2));
  assert.equal(hex(kids[3].value), 'abcd');
  assert.equal(kids[3].constructed, false);
  assert.equal(hex(encBoolean(false)), '010100');
  derErr(() => encContext(31, encNull()));
  derErr(() => encTlv(0x1f, new Uint8Array(0)));

  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const p = parseDer(spki);
  const [alg, bits] = childrenOf(p);
  const [algOid, curve] = childrenOf(alg);
  assert.equal(decodeOid(algOid), '1.2.840.10045.2.1');
  assert.equal(decodeOid(curve), '1.3.132.0.10');
  const point = decodeBitString(bits);
  assert.equal(point.unusedBits, 0);
  assert.equal(point.bytes.length, 65);
  const rebuilt = encSequence([encSequence([encOid(decodeOid(algOid)), encOid(decodeOid(curve))]), encBitString(point.bytes)]);
  assert.equal(hex(rebuilt), spki.toString('hex'));
  assert.equal(spki.length, 88);
});

test('BIT STRING وOCTET STRING والنصوص: ذهاب وإياب ورفض الحشو غير الصفري والمحارف غير المسموحة', () => {
  assert.equal(hex(encBitString(unhex('80'), 7)), '03020780');
  assert.deepEqual(decodeBitString(parseDer(unhex('03020780'))), { unusedBits: 7, bytes: unhex('80') });
  derErr(() => decodeBitString(parseDer(unhex('03020781'))));
  derErr(() => decodeBitString(parseDer(unhex('030108'))));
  derErr(() => decodeBitString(parseDer(unhex('0300'))));
  derErr(() => encBitString(unhex('81'), 7));

  assert.equal(decodeString(parseDer(encUtf8String('شركة ☕ 🚚'))), 'شركة ☕ 🚚');
  assert.equal(decodeString(parseDer(encPrintableString("PREZATCA-Code-Signing (1)"))), 'PREZATCA-Code-Signing (1)');
  assert.equal(decodeString(parseDer(encIa5String('extgazt'))), 'extgazt');
  assert.equal(decodeString(parseDer(unhex('1e0400410042'))), 'AB');
  derErr(() => encPrintableString('a_b'));
  derErr(() => encPrintableString('عربي'));
  derErr(() => encIa5String('é'));
  derErr(() => decodeString(parseDer(unhex('13015f'))));   // '_' ليس Printable
  derErr(() => decodeString(parseDer(unhex('0c01ff'))));   // UTF-8 غير صالح
  derErr(() => decodeString(parseDer(unhex('1601c3'))));   // IA5 غير ASCII
  derErr(() => decodeString(parseDer(encInteger(1))));
});

test('الأزمنة: UTCTime (قاعدة 1950/2049) وGeneralizedTime ذهاباً وإياباً ورفض غير الصالح', () => {
  const cases = ['2024-01-11T09:19:30Z', '1950-01-01T00:00:00Z', '2049-12-31T23:59:59Z', '2000-02-29T12:00:00Z'];
  for (const iso of cases) {
    const d = new Date(iso);
    assert.equal(decodeTime(parseDer(encUtcTime(d))).toISOString(), d.toISOString(), iso);
    assert.equal(decodeTime(parseDer(encGeneralizedTime(d))).toISOString(), d.toISOString(), iso);
  }
  assert.equal(Buffer.from(parseDer(encUtcTime(new Date('2024-01-11T09:19:30Z'))).value).toString(), '240111091930Z');
  assert.equal(decodeTime(parseDer(encGeneralizedTime(new Date('2050-06-01T00:00:00Z')))).getUTCFullYear(), 2050);
  assert.equal(decodeTime(parseDer(unhex('180f30303530303130313030303030305a'))).getUTCFullYear(), 50, 'السنة 0050 لا تصير 1950');
  derErr(() => encUtcTime(new Date('2050-01-01T00:00:00Z')));
  derErr(() => encUtcTime(new Date('1949-12-31T23:59:59Z')));
  const bad = (tag: number, s: string) => parseDer(encTlv(tag, Buffer.from(s, 'latin1')));
  derErr(() => decodeTime(bad(TAG.UTC_TIME, '2402300000000Z')));
  derErr(() => decodeTime(bad(TAG.UTC_TIME, '240230000000Z')));  // 30 فبراير
  derErr(() => decodeTime(bad(TAG.UTC_TIME, '2401110919Z')));    // بلا ثوانٍ
  derErr(() => decodeTime(bad(TAG.UTC_TIME, '240111091930+0300')));
  derErr(() => decodeTime(bad(TAG.GENERALIZED_TIME, '20240111091930.5Z')));
  derErr(() => decodeTime(bad(TAG.OCTET_STRING, '240111091930Z')));
});

test('ذهاب وإياب عشوائي: شجرة DER مولّدة ⇒ قراءة ⇒ إعادة ترميز من العُقد = البايتات نفسها', () => {
  const rnd = (n: number) => Math.floor(Math.random() * n);
  const gen = (depth: number): Uint8Array => {
    const k = depth > 4 ? rnd(5) : rnd(8);
    switch (k) {
      case 0: return encInteger(BigInt.asIntN(64, BigInt(`0x${crypto.randomBytes(8).toString('hex')}`)));
      case 1: return encOctetString(crypto.randomBytes(rnd(300)));
      case 2: return encUtf8String('نص' + rnd(1000));
      case 3: return encOid(`1.2.${rnd(100000)}.${rnd(10)}`);
      case 4: return encBitString(crypto.randomBytes(1 + rnd(40)));
      case 5: return encSequence(Array.from({ length: rnd(5) }, () => gen(depth + 1)));
      case 6: return encSet(Array.from({ length: rnd(5) }, () => gen(depth + 1)));
      default: return encContext(rnd(4), Array.from({ length: 1 + rnd(3) }, () => gen(depth + 1)));
    }
  };
  const reencode = (n: ReturnType<typeof parseDer>): Uint8Array => (n.children ? encTlv(n.tag, Buffer.concat(n.children.map(c => Buffer.from(reencode(c))))) : encTlv(n.tag, n.value));
  for (let i = 0; i < 500; i++) {
    const der = gen(0);
    assert.equal(hex(reencode(parseDer(der))), hex(der));
  }
});
