// «منصّة فاتورة» مزيّفة في الذاكرة لاختبارات Z4 — تُحقن في FatooraClient كـfetch، ولا شبكة إطلاقاً.
// تتصرّف كالخادم الموثَّق (report §4.1–§4.4) افتراضياً:
//   • POST /compliance: OTP صالح مرة واحدة ⇒ CCSID لمفتاح الـCSR ورقمه الضريبي (شهادة بـSAN حقيقية)، وإلا 400 Invalid-OTP (مثبّت Z3).
//   • POST /compliance/invoices: Basic بشهادة امتثال صادرة؛ يتحقّق من الختم (verifyStampedXml بشهادة CCSID) ويسجّل الخطوة.
//   • POST /production/csids: Basic بالـCCSID نفسها، ويلزم نجاح الخطوات الست لذلك الطلب وإلا 400 Missing-ComplianceSteps.
//   • PATCH /production/csids: Basic بشهادة الإنتاج الحالية + OTP تجديد ⇒ 200 (PCSID جديدة) أو 428 (CCSID جديدة).
// كل مخالفة للترويسات تُسجَّل في violations (لا رمي: العميل يحوّل الرمي إلى RETRY فيُخفيه)، وكل ردّ يمكن تجاوزه بمعالج.
import crypto from 'crypto';
import { FATOORA_BASE_URLS, FatooraEnv, FatooraFetch, FatooraFetchInit } from '../api';
import { parseCsidToken } from '../cert';
import type { ComplianceStep } from '../complianceSamples';
import { parseCsr } from '../csr';
import { verifyStampedXml } from '../stamp';
import { CCSID_ISSUER, CsidCertSpec, buildCsidCert } from './z4-csidcert';
import { z3Body } from './z3-fixtures';

export type Endpoint = 'compliance' | 'compliance-invoices' | 'production-csid' | 'renewal' | 'unknown';

export interface FakeCall {
  endpoint: Endpoint;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  /** للفحوص: الخطوة المستنتجة من الـXML. */
  step?: ComplianceStep;
  /** للفحوص: هل تحقّق الختم بشهادة CCSID المصرِّحة. */
  verified?: boolean;
  /** بيانات الاعتماد المستعملة (token) إن وُجدت. */
  authToken?: string;
}

export type Reply = { status: number; body?: unknown; raw?: string } | { network: true };

export interface IssuedCsid {
  kind: 'ccsid' | 'pcsid';
  requestID: number;
  token: string;
  secret: string;
  publicKey: crypto.KeyObject;
  vatNumber: string;
  serialNumber: string;
  serial: bigint;
  notBefore: Date;
  notAfter: Date;
  passedSteps: Set<ComplianceStep>;
}

export interface FakeZatcaOptions {
  env: FatooraEnv;
  otps?: string[];
  renewalOtps?: string[];
  renewalMode?: 200 | 428;
  validity?: { notBefore: Date; notAfter: Date };
  /** تعديل مواصفة الشهادة قبل إصدارها (عدم تطابق مفتاح/رقم ضريبي). */
  certSpec?: (kind: 'ccsid' | 'pcsid', spec: CsidCertSpec) => CsidCertSpec;
  onCompliance?: (call: FakeCall) => Reply | undefined;
  /** n = رقم استدعاء الفحص (1…) عبر كل التشغيل. */
  onCheck?: (call: FakeCall, n: number) => Reply | undefined;
  onProduction?: (call: FakeCall, n: number) => Reply | undefined;
  onRenewal?: (call: FakeCall, n: number) => Reply | undefined;
}

export interface FakeZatca {
  fetch: FatooraFetch;
  calls: FakeCall[];
  violations: string[];
  issued: IssuedCsid[];
  /** شهادة الإنتاج السارية حالياً (تتبدّل مع التجديد). */
  current: { production: IssuedCsid | null };
  otps: Set<string>;
  renewalOtps: Set<string>;
  opts: FakeZatcaOptions;
}

const STEP_BY: Record<string, ComplianceStep> = {
  '01:388': 'standard-compliant', '01:381': 'standard-credit-note-compliant', '01:383': 'standard-debit-note-compliant',
  '02:388': 'simplified-compliant', '02:381': 'simplified-credit-note-compliant', '02:383': 'simplified-debit-note-compliant',
};

export const ALL_STEPS: ComplianceStep[] = [
  'standard-compliant', 'standard-credit-note-compliant', 'standard-debit-note-compliant',
  'simplified-compliant', 'simplified-credit-note-compliant', 'simplified-debit-note-compliant',
];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function fakeZatca(opts: FakeZatcaOptions): FakeZatca {
  const base = FATOORA_BASE_URLS[opts.env];
  const validity = opts.validity ?? { notBefore: new Date('2026-02-03T04:05:06Z'), notAfter: new Date('2030-07-08T09:10:11Z') };
  const f: FakeZatca = {
    fetch: null as unknown as FatooraFetch, calls: [], violations: [], issued: [], current: { production: null },
    otps: new Set(opts.otps ?? []), renewalOtps: new Set(opts.renewalOtps ?? []), opts,
  };
  let nextRequestId = 1234567890100;
  let checks = 0;
  let productions = 0;
  let renewals = 0;

  const issue = (kind: 'ccsid' | 'pcsid', publicKey: crypto.KeyObject, vatNumber: string, serialNumber: string): IssuedCsid => {
    let spec: CsidCertSpec = {
      subjectKey: publicKey, vatNumbers: [vatNumber], serialNumber, notBefore: validity.notBefore, notAfter: validity.notAfter,
      ...(kind === 'ccsid' ? { issuer: CCSID_ISSUER } : {}),
    };
    if (opts.certSpec) spec = opts.certSpec(kind, spec);
    const cert = buildCsidCert(spec);
    const rec: IssuedCsid = {
      kind, requestID: nextRequestId++, token: cert.token, secret: crypto.randomBytes(32).toString('base64'), publicKey, vatNumber, serialNumber,
      serial: cert.serial, notBefore: cert.notBefore, notAfter: cert.notAfter, passedSteps: new Set(),
    };
    f.issued.push(rec);
    return rec;
  };

  const csidBody = (r: IssuedCsid, disposition = 'ISSUED') => ({
    requestID: r.requestID, tokenType: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3',
    dispositionMessage: disposition, binarySecurityToken: r.token, secret: r.secret, errors: null,
  });

  const csrFacts = (body: Record<string, unknown> | null) => {
    const pem = Buffer.from(String(body?.csr ?? ''), 'base64').toString('utf8');
    const parsed = parseCsr(pem);
    return {
      publicKey: crypto.createPublicKey({ key: Buffer.from(parsed.subjectPublicKeyInfoDer), format: 'der', type: 'spki' }),
      vat: parsed.fields.vatNumber ?? '',
      sn: parsed.fields.serialNumber ?? '',
      signatureValid: parsed.signatureValid,
    };
  };

  const authOf = (call: FakeCall): { token: string; secret: string } | null => {
    const h = call.headers.authorization;
    if (!h || !h.startsWith('Basic ')) return null;
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    return i < 0 ? null : { token: decoded.slice(0, i), secret: decoded.slice(i + 1) };
  };

  const findCreds = (call: FakeCall, kind: 'ccsid' | 'pcsid'): IssuedCsid | null => {
    const a = authOf(call);
    if (!a) return null;
    call.authToken = a.token;
    return f.issued.find(r => r.kind === kind && r.token === a.token && r.secret === a.secret) ?? null;
  };

  const expectHeaders = (call: FakeCall, want: { otp: boolean; auth: boolean; lang: boolean; method: string }) => {
    const h = call.headers;
    const where = `${call.method} ${call.path}`;
    if (call.method !== want.method) f.violations.push(`${where}: method`);
    if (h['accept-version'] !== 'V2') f.violations.push(`${where}: Accept-Version`);
    if (h['content-type'] !== 'application/json') f.violations.push(`${where}: Content-Type`);
    if (want.otp !== ('otp' in h)) f.violations.push(`${where}: OTP header ${want.otp ? 'missing' : 'unexpected'}`);
    if (want.auth !== ('authorization' in h)) f.violations.push(`${where}: Authorization ${want.auth ? 'missing' : 'unexpected'}`);
    if (want.lang !== ('accept-language' in h)) f.violations.push(`${where}: Accept-Language`);
  };

  const toResponse = (r: Reply): Response => {
    if ('network' in r) throw new TypeError('fetch failed');
    return r.raw !== undefined ? new Response(r.raw, { status: r.status }) : json(r.status, r.body ?? {});
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
    const endpoint: Endpoint = path === '/compliance' ? 'compliance'
      : path === '/compliance/invoices' ? 'compliance-invoices'
        : path === '/production/csids' ? (init.method === 'PATCH' ? 'renewal' : 'production-csid') : 'unknown';
    const call: FakeCall = { endpoint, method: init.method, path, headers, body };
    f.calls.push(call);

    switch (endpoint) {
      case 'compliance': {
        expectHeaders(call, { otp: true, auth: false, lang: false, method: 'POST' });
        const o = opts.onCompliance?.(call);
        if (o) return toResponse(o);
        if (!f.otps.has(headers.otp)) return json(400, z3Body('compliance-400-invalid-otp'));
        f.otps.delete(headers.otp);
        const facts = csrFacts(body);
        if (!facts.signatureValid) return json(400, { errors: [{ code: 'Invalid-CSR', message: 'invalid csr' }] });
        return json(200, csidBody(issue('ccsid', facts.publicKey, facts.vat, facts.sn)));
      }
      case 'compliance-invoices': {
        expectHeaders(call, { otp: false, auth: true, lang: true, method: 'POST' });
        const ccsid = findCreds(call, 'ccsid');
        const xml = Buffer.from(String(body?.invoice ?? ''), 'base64').toString('utf8');
        const m = /<cbc:InvoiceTypeCode name="(\d{2})\d{5}">(\d{3})<\/cbc:InvoiceTypeCode>/.exec(xml);
        call.step = m ? STEP_BY[`${m[1]}:${m[2]}`] : undefined;
        if (ccsid && m) {
          try {
            const v = verifyStampedXml(xml, parseCsidToken(ccsid.token), m[1] === '01' ? 'standard' : 'simplified');
            call.verified = v.invoiceHash === body?.invoiceHash;
          } catch {
            call.verified = false;
          }
        }
        checks++;
        const o = opts.onCheck?.(call, checks);
        if (o) return toResponse(o);
        if (!ccsid) return json(401, {});
        if (!call.verified || !call.step) return json(400, z3Body('compliance-invoices-400'));
        ccsid.passedSteps.add(call.step);
        return json(200, z3Body('compliance-invoices-200'));
      }
      case 'production-csid': {
        expectHeaders(call, { otp: false, auth: true, lang: false, method: 'POST' });
        productions++;
        const o = opts.onProduction?.(call, productions);
        if (o) return toResponse(o);
        const ccsid = findCreds(call, 'ccsid');
        if (!ccsid) return json(401, {});
        if (String(body?.compliance_request_id) !== String(ccsid.requestID)) return json(400, { errors: [{ code: 'Invalid-ComplianceRequestId', message: 'bad id' }] });
        if (ALL_STEPS.some(s => !ccsid.passedSteps.has(s))) return json(400, z3Body('production-csid-400-missing-steps'));
        const pcsid = issue('pcsid', ccsid.publicKey, ccsid.vatNumber, ccsid.serialNumber);
        f.current.production = pcsid;
        return json(200, csidBody(pcsid));
      }
      case 'renewal': {
        expectHeaders(call, { otp: true, auth: true, lang: true, method: 'PATCH' });
        renewals++;
        const o = opts.onRenewal?.(call, renewals);
        if (o) return toResponse(o);
        const cur = findCreds(call, 'pcsid');
        if (!cur || cur !== f.current.production) return json(401, {});
        if (!f.renewalOtps.has(headers.otp)) return json(400, z3Body('compliance-400-invalid-otp'));
        f.renewalOtps.delete(headers.otp);
        const facts = csrFacts(body);
        if ((opts.renewalMode ?? 200) === 428) return json(428, csidBody(issue('ccsid', facts.publicKey, facts.vat, facts.sn), 'NOT_COMPLIANT'));
        const pcsid = issue('pcsid', facts.publicKey, facts.vat, facts.sn);
        f.current.production = pcsid;
        return json(200, csidBody(pcsid));
      }
      default:
        f.violations.push(`unknown path ${path}`);
        return json(404, {});
    }
  };
  return f;
}
