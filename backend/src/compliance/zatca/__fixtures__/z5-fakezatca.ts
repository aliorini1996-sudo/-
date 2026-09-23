// «منصّة فاتورة» مزيّفة لمساري المستندات (الإبلاغ والاعتماد) — اختبارات Z5.3/Z5.4. تُحقن في FatooraClient كـfetch: لا شبكة إطلاقاً.
// تتصرّف كالخادم الموثَّق (report §4.5–§4.6) افتراضياً:
//   • تتحقّق من الترويسات (Accept-Version وContent-Type وAccept-Language وClearance-Status: 0 للإبلاغ و1 للاعتماد) ومن Basic
//     بشهادة الإنتاج وسرّها، ومن تطابق uuid/invoiceHash مع الـXML، ومن الختم نفسه (verifyStampedXml بشهادة PCSID).
//   • الإبلاغ ⇒ 200 REPORTED؛ الاعتماد ⇒ 200 CLEARED مع clearedInvoice (الـXML نفسه برمز QR مختلف كي يُختبر استخراجه).
//   • uuid مكرَّر ⇒ 409 على الإبلاغ و208 (مع المستند المعتمد) على الاعتماد.
//   • ردود مبرمَجة لكل استدعاء: 202 بتحذيرات، 400 بأخطاء، 400 فارغ، 413، 401، 303، 406، 429 بـRetry-After، 500/503، عطل شبكة،
//     تأخّر يتجاوز المهلة، و2xx متناقض. كل مخالفة ترويسة تُسجَّل في violations (لا رمي: العميل يحوّل الرمي إلى RETRY فيخفيه).
// كل شيء هنا مصطنع: لا رقم ضريبي حقيقي ولا شهادة حقيقية ولا عنوان هيئة يُتصل به.
import { FATOORA_BASE_URLS, type FatooraEnv, type FatooraFetch, type FatooraFetchInit } from '../api';
import { parseCsidToken } from '../cert';
import { verifyStampedXml } from '../stamp';
import { z3Body } from './z3-fixtures';

export type InvoiceEndpointName = 'reporting' | 'clearance' | 'unknown';

export interface FakeInvoiceCall {
  endpoint: InvoiceEndpointName;
  n: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  uuid: string | null;
  invoiceHash: string | null;
  xml: string | null;
  authToken: string | null;
  authOk: boolean;
  /** تحقّق الختم بشهادة الإنتاج وتطابقت التجزئة. */
  verified: boolean;
}

export type FakeReply =
  | { status: number; body?: unknown; raw?: string; headers?: Record<string, string> }
  | { network: true }
  /** يتأخّر ثمّ يردّ (أو يُلغى بالمهلة) — لاختبار انقضاء المهلة. */
  | { delayMs: number; then?: { status: number; body?: unknown } };

export interface FakeFatooraOptions {
  env: FatooraEnv;
  /** بيانات اعتماد الإنتاج المقبولة (رمز PCSID وسرّه). */
  creds: { token: string; secret: string };
  /** رمز الشهادة للتحقّق من الختم (الافتراضي رمز الاعتماد نفسه). */
  certToken?: string;
  onReport?: (call: FakeInvoiceCall, n: number) => FakeReply | undefined;
  onClear?: (call: FakeInvoiceCall, n: number) => FakeReply | undefined;
  /** لاحقة تُميّز رمز QR في المستند المعتمد عن ختمنا. */
  clearedQrMark?: string;
}

export interface FakeFatoora {
  fetch: FatooraFetch;
  calls: FakeInvoiceCall[];
  violations: string[];
  /** uuid لكل مستند قُبِل (الإرسال الثاني للبايتات نفسها تكرار). */
  accepted: Set<string>;
  opts: FakeFatooraOptions;
  /** المستند المعتمد كما يعيده الاعتماد (الـXML برمز QR مختلف). */
  clearedXmlOf(xml: string): string;
}

const QR_MARK_DEFAULT = 'Q0xFQVJFRC1CWS1aQVRDQQ==';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** رسالة خطأ بشكل الهيئة (errorMessages داخل validationResults). */
export function rejectionBody(code: string, message: string): Record<string, unknown> {
  return {
    validationResults: {
      infoMessages: [], warningMessages: [],
      errorMessages: [{ type: 'ERROR', code, category: 'KSA', message, status: 'ERROR' }],
      status: 'ERROR',
    },
    clearanceStatus: 'NOT_CLEARED',
    clearedInvoice: null,
  };
}

/** 2xx متناقض: الحالة ناجحة والجسم يقول NOT_REPORTED (بوابة معطوبة). */
export function contradictoryBody(): Record<string, unknown> {
  return { validationResults: { infoMessages: [], warningMessages: [], errorMessages: [], status: 'PASS' }, reportingStatus: 'NOT_REPORTED' };
}

// مرجع QR وحده (المستند يحمل أيضاً مرفق PIH بالعنصر نفسه — استبداله يفسد السلسلة لا الرمز)
const QR_RE = /(<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>)([^<]*)(<\/cbc:EmbeddedDocumentBinaryObject>)/;

export function fakeFatoora(opts: FakeFatooraOptions): FakeFatoora {
  const base = FATOORA_BASE_URLS[opts.env];
  const mark = opts.clearedQrMark ?? QR_MARK_DEFAULT;
  const f: FakeFatoora = {
    fetch: null as unknown as FatooraFetch,
    calls: [],
    violations: [],
    accepted: new Set<string>(),
    opts,
    clearedXmlOf: (xml: string) => (QR_RE.test(xml) ? xml.replace(QR_RE, `$1${mark}$3`) : xml),
  };
  const cert = parseCsidToken(opts.certToken ?? opts.creds.token);
  let reports = 0;
  let clears = 0;

  const expectHeaders = (call: FakeInvoiceCall, clearanceStatus: '0' | '1') => {
    const h = call.headers;
    const where = `${call.method} ${call.path}`;
    if (call.method !== 'POST') f.violations.push(`${where}: method`);
    if (h['accept-version'] !== 'V2') f.violations.push(`${where}: Accept-Version`);
    if (h['content-type'] !== 'application/json') f.violations.push(`${where}: Content-Type`);
    if (!('accept-language' in h)) f.violations.push(`${where}: Accept-Language`);
    if (!('authorization' in h)) f.violations.push(`${where}: Authorization`);
    if ('otp' in h) f.violations.push(`${where}: OTP header unexpected`);
    if (h['clearance-status'] !== clearanceStatus) f.violations.push(`${where}: Clearance-Status ${h['clearance-status'] ?? 'missing'}`);
  };

  const checkAuth = (call: FakeInvoiceCall): boolean => {
    const h = call.headers.authorization;
    if (!h || !h.startsWith('Basic ')) return false;
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) return false;
    call.authToken = decoded.slice(0, i);
    return decoded.slice(0, i) === opts.creds.token && decoded.slice(i + 1) === opts.creds.secret;
  };

  const verify = (call: FakeInvoiceCall): boolean => {
    if (!call.xml) return false;
    const m = /<cbc:InvoiceTypeCode name="(\d{2})\d{5}">/.exec(call.xml);
    if (!m) return false;
    try {
      const v = verifyStampedXml(call.xml, cert, m[1] === '01' ? 'standard' : 'simplified');
      return v.invoiceHash === call.invoiceHash;
    } catch {
      return false;
    }
  };

  const toResponse = async (r: FakeReply, init: FatooraFetchInit): Promise<Response> => {
    if ('network' in r) throw new TypeError('fetch failed');
    if ('delayMs' in r) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, r.delayMs);
        const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
        if (init.signal.aborted) onAbort();
        else init.signal.addEventListener('abort', onAbort, { once: true });
      });
      const then = r.then ?? { status: 200, body: z3Body('reporting-200') };
      return json(then.status, then.body ?? {});
    }
    if (r.raw !== undefined) return new Response(r.raw, { status: r.status, headers: r.headers ?? {} });
    return json(r.status, r.body ?? {}, r.headers ?? {});
  };

  f.fetch = async (url: string, init: FatooraFetchInit) => {
    const path = url.startsWith(base) ? url.slice(base.length) : `!${url}`;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = v;
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      f.violations.push(`${path}: body not JSON`);
    }
    const endpoint: InvoiceEndpointName = path === '/invoices/reporting/single' ? 'reporting'
      : path === '/invoices/clearance/single' ? 'clearance' : 'unknown';
    const xml = typeof body?.invoice === 'string' ? Buffer.from(body.invoice, 'base64').toString('utf8') : null;
    const call: FakeInvoiceCall = {
      endpoint, n: 0, method: init.method, path, headers,
      uuid: typeof body?.uuid === 'string' ? body.uuid : null,
      invoiceHash: typeof body?.invoiceHash === 'string' ? body.invoiceHash : null,
      xml, authToken: null, authOk: false, verified: false,
    };
    f.calls.push(call);
    if (endpoint === 'unknown') {
      f.violations.push(`unknown path ${path}`);
      return json(404, {});
    }
    call.n = endpoint === 'reporting' ? ++reports : ++clears;
    expectHeaders(call, endpoint === 'reporting' ? '0' : '1');
    call.authOk = checkAuth(call);
    call.verified = verify(call);

    const scripted = endpoint === 'reporting' ? opts.onReport?.(call, call.n) : opts.onClear?.(call, call.n);
    if (scripted) return toResponse(scripted, init);

    if (!call.authOk) return json(401, z3Body('error-401'));
    const uuid = call.uuid ?? '';
    if (f.accepted.has(uuid)) {
      if (endpoint === 'reporting') return json(409, z3Body('reporting-200'));
      const dup = z3Body<Record<string, unknown>>('clearance-208');
      dup.clearedInvoice = Buffer.from(f.clearedXmlOf(xml ?? ''), 'utf8').toString('base64');
      return json(208, dup);
    }
    if (!call.verified) return json(400, rejectionBody('BR-KSA-SIG', 'Invalid invoice signature or hash mismatch'));
    f.accepted.add(uuid);
    if (endpoint === 'reporting') return json(200, z3Body('reporting-200'));
    const ok = z3Body<Record<string, unknown>>('clearance-200');
    ok.clearedInvoice = Buffer.from(f.clearedXmlOf(xml ?? ''), 'utf8').toString('base64');
    return json(200, ok);
  };
  return f;
}

// ─── ردود جاهزة للاختبارات ───

export const FAKE_REPLIES = Object.freeze({
  /** 202 بتحذيرات (مقبول مع تحذير). */
  warn202: (): FakeReply => ({ status: 202, body: z3Body('reporting-202') }),
  warnCleared202: (clearedB64: string): FakeReply => {
    const b = z3Body<Record<string, unknown>>('clearance-202');
    b.clearedInvoice = clearedB64;
    return { status: 202, body: b };
  },
  /** 200 اعتماد بلا مستند معتمد (يُصنَّف CONFIG: cleared-invoice-missing). */
  clearedMissing200: (): FakeReply => {
    const b = z3Body<Record<string, unknown>>('clearance-200');
    delete b.clearedInvoice;
    return { status: 200, body: b };
  },
  /** 208 تكرار بلا مستند معتمد ⇒ CLEARED_NO_XML. */
  duplicateNoXml208: (): FakeReply => {
    const b = z3Body<Record<string, unknown>>('clearance-208');
    delete b.clearedInvoice;
    return { status: 208, body: b };
  },
  reject400: (code = 'BR-KSA-14', message = 'The buyer identification scheme ID must be one of the allowed codes.'): FakeReply =>
    ({ status: 400, body: rejectionBody(code, message) }),
  empty400: (): FakeReply => ({ status: 400, body: {} }),
  payload413: (): FakeReply => ({ status: 413, body: {} }),
  auth401: (): FakeReply => ({ status: 401, body: z3Body('error-401') }),
  clearanceOff303: (): FakeReply => ({ status: 303, body: z3Body('clearance-303') }),
  notAcceptable406: (): FakeReply => ({ status: 406, raw: 'Not Acceptable' }),
  rate429: (retryAfterSeconds = 120): FakeReply => ({ status: 429, body: {}, headers: { 'retry-after': String(retryAfterSeconds) } }),
  server500: (): FakeReply => ({ status: 500, body: z3Body('error-500-invalid-request') }),
  server503: (): FakeReply => ({ status: 503, body: {} }),
  network: (): FakeReply => ({ network: true }),
  timeout: (delayMs = 60_000): FakeReply => ({ delayMs }),
  contradictory200: (): FakeReply => ({ status: 200, body: contradictoryBody() }),
});
