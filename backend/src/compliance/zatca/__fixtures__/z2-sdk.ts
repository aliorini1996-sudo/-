// أدوات اختبار Z2 للعيّنات الرسمية من حزمة ZATCA SDK 3.4.8 (يضعها المالك محلياً في __fixtures__/sdk).
// المجلد مستبعد من git (LGPL-3.0 test data) — لذا كل اختبار ذهبي يُتخطّى بسبب واضح عند غيابه
// (CI والمستودع العام)، ولا يعتمد عليه أي اختبار آخر. لا نسخ لمحتوى الحزمة في أي ملف ملتزَم.
import fs from 'fs';
import path from 'path';

// ZATCA_SDK_FIXTURES_DIR يسمح بالتحقق من مسار التخطّي (بتوجيهه إلى مجلد غير موجود) دون المساس بالعيّنات.
export const SDK_DIR = process.env.ZATCA_SDK_FIXTURES_DIR || path.join(__dirname, 'sdk');

const REQUIRED = ['cert.pem', 'ec-secp256k1-priv-key.pem', 'Simplified', 'Standard'];

export const SDK_PRESENT = REQUIRED.every(f => fs.existsSync(path.join(SDK_DIR, f)));

/** قيمة skip لـ node:test: false عند توفّر العيّنات، وإلا سبب نصّي. */
export const SDK_SKIP: false | string = SDK_PRESENT
  ? false
  : 'عيّنات ZATCA SDK الرسمية غير موجودة في __fixtures__/sdk (مستبعدة من git؛ محلية لدى المالك فقط)';

export interface SdkSample {
  /** المسار النسبي بفواصل / (مثل Simplified/Invoice/Simplified_Invoice.xml). */
  rel: string;
  xml: string;
  kind: 'standard' | 'simplified';
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.xml') ? [path.join(dir, e.name)] : []));
}

let cache: SdkSample[] | null = null;

/** العيّنات الموقَّعة الـ19 مرتّبة بالمسار (لا تُستدعى إلا داخل اختبار غير متخطّى). */
export function sdkSamples(): SdkSample[] {
  if (cache) return cache;
  cache = [...walk(path.join(SDK_DIR, 'Simplified')), ...walk(path.join(SDK_DIR, 'Standard'))]
    .map(f => {
      const xml = fs.readFileSync(f, 'utf8');
      const rel = path.relative(SDK_DIR, f).split(path.sep).join('/');
      return { rel, xml, kind: rel.startsWith('Simplified/') ? 'simplified' as const : 'standard' as const };
    })
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return cache;
}

export function sdkSample(rel: string): SdkSample {
  const s = sdkSamples().find(x => x.rel === rel);
  if (!s) throw new Error(`عيّنة SDK غير موجودة: ${rel}`);
  return s;
}

export function sdkCertB64(): string {
  return fs.readFileSync(path.join(SDK_DIR, 'cert.pem'), 'utf8');
}

/** المفتاح الخاص للعيّنات: base64 لـ DER بصيغة SEC1 بلا ترويسة PEM. */
export function sdkPrivateKeyB64(): string {
  return fs.readFileSync(path.join(SDK_DIR, 'ec-secp256k1-priv-key.pem'), 'utf8').trim();
}

/** العيّنات الست «الأساسية» (أُعيد توقيعها 2025-07-22) التي فشل فيها الحذف النصّي الساذج. */
export const CORE_SIX = [
  'Simplified/Credit/Simplified_Credit_Note.xml',
  'Simplified/Debit/Simplified_Debit_Note.xml',
  'Simplified/Invoice/Simplified_Invoice.xml',
  'Standard/Credit/Standard_Credit_Note.xml',
  'Standard/Debit/Standard_Debit_Note.xml',
  'Standard/Invoice/Standard_Invoice.xml',
];

/** قيمة أول عنصر مطابق بتعبير نمطي على النص الخام — للاستخراج المستقل عن محلّلنا في الاختبارات. */
export function rawText(xml: string, re: RegExp): string {
  const m = re.exec(xml);
  if (!m) throw new Error(`لم يُعثر على ${re}`);
  return m[1];
}

export const RAW = {
  invoiceDigest: /<ds:Reference Id="invoiceSignedData"[\s\S]*?<ds:DigestValue>([^<]*)<\/ds:DigestValue>/,
  signedPropertiesDigest: /<ds:Reference Type="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#SignatureProperties"[\s\S]*?<ds:DigestValue>([^<]*)<\/ds:DigestValue>/,
  signatureValue: /<ds:SignatureValue>([^<]*)<\/ds:SignatureValue>/,
  certificate: /<ds:X509Certificate>([^<]*)<\/ds:X509Certificate>/,
  signingTime: /<xades:SigningTime>([^<]*)<\/xades:SigningTime>/,
  certDigest: /<xades:CertDigest>[\s\S]*?<ds:DigestValue>([^<]*)<\/ds:DigestValue>/,
  issuerName: /<ds:X509IssuerName>([^<]*)<\/ds:X509IssuerName>/,
  serialNumber: /<ds:X509SerialNumber>([^<]*)<\/ds:X509SerialNumber>/,
  qr: /<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain">([^<]*)<\/cbc:EmbeddedDocumentBinaryObject>/,
};

/**
 * الحذف النصّي الساذج (C-S1 كما جُرّب قبل Z2): إسقاط الإعلان وقصّ الكتل الثلاث حرفياً مع إبقاء ما حولها،
 * وإسقاط LF الأخير بعد </Invoice>. لا يرتّب السمات ولا يطبّع شيئاً.
 */
export function naiveHashInput(xml: string): string {
  const cut = (s: string, from: number, closeTag: string) => {
    const to = s.indexOf(closeTag, from);
    if (from < 0 || to < from) throw new Error(`قصّ فاشل ${closeTag}`);
    return s.slice(0, from) + s.slice(to + closeTag.length);
  };
  let s = xml.replace(/^<\?xml[^>]*\?>\n?/, '');
  s = cut(s, s.indexOf('<ext:UBLExtensions>'), '</ext:UBLExtensions>');
  s = cut(s, s.indexOf('<cac:Signature>'), '</cac:Signature>');
  const qr = s.indexOf('<cbc:ID>QR</cbc:ID>');
  s = cut(s, s.lastIndexOf('<cac:AdditionalDocumentReference>', qr), '</cac:AdditionalDocumentReference>');
  return s.replace(/\n+$/, '');
}
