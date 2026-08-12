// ============================================================================
// ZATCA المرحلة الثانية — لبنات التشفير الأساسية (native، بلا تبعيات خارجية)
// ----------------------------------------------------------------------------
// الهيئة تتطلّب:
//   • مفتاح EC على منحنى secp256k1 (لا P-256) — يُنشأ منه CSR ثم شهادة (CSID).
//   • تجزئة SHA-256 للفاتورة (base64) تُسلسَل عبر PIH (تجزئة الفاتورة السابقة).
//   • توقيع ECDSA للتجزئة بالمفتاح الخاصّ (يدخل في XAdES وفي QR المرحلة الثانية).
// هنا الأساس النقيّ القابل للاختبار؛ بناء CSR والـXML والتوقيع الكامل في Z0ب/Z1/Z2.
// ============================================================================
import crypto from 'crypto';

/**
 * التجزئة الأوّليّة المعتمدة من الهيئة للفاتورة الأولى في السلسلة:
 * base64 لسلسلة hex الست عشرية لـ SHA-256("0"). قيمةٌ ثابتة تُبنى عليها أول PIH.
 * (محروسةٌ باختبار يتحقّق من اشتقاقها.)
 */
export const INITIAL_PIH =
  'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

/** يولّد زوج مفاتيح EC secp256k1 بصيغة PEM (الخاصّ بصيغة SEC1 كما تتوقّع الهيئة). */
export function generateEgsKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKeyPem: privateKey as string, publicKeyPem: publicKey as string };
}

/** تجزئة SHA-256 تُعاد base64 لبايتات التجزئة الخام — تجزئة الفاتورة والـPIH. */
export function sha256Base64(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('base64');
}

/** تجزئة SHA-256 بصيغة hex. */
export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** UUID للفاتورة (حقل cbc:UUID في UBL 2.1). */
export function newInvoiceUuid(): string {
  return crypto.randomUUID();
}

/**
 * توقيع ECDSA (SHA-256) للبيانات بالمفتاح الخاصّ — يُعاد base64 (DER).
 * أساسٌ لتوقيع XAdES وحقل التوقيع في QR المرحلة الثانية؛ يُضبط ما يُوقَّع بدقّة في Z2.
 */
export function signSha256(data: string | Buffer, privateKeyPem: string): string {
  const s = crypto.createSign('SHA256');
  s.update(data);
  s.end();
  return s.sign({ key: privateKeyPem }, 'base64');
}

/** يتحقّق من توقيع ECDSA (SHA-256) — للاختبار والتدقيق. */
export function verifySha256(data: string | Buffer, signatureBase64: string, publicKeyPem: string): boolean {
  const v = crypto.createVerify('SHA256');
  v.update(data);
  v.end();
  return v.verify(publicKeyPem, Buffer.from(signatureBase64, 'base64'));
}
