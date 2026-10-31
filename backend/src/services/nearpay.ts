import jwt from 'jsonwebtoken';

/**
 * واجهة NearPay (SoftPOS) — «التحصيل بالبطاقة» (طلب المالك ٢٨ أكتوبر ٢٠٢٦).
 *
 * ثلاثة أشياء فقط يحتاجها الخادم من NearPay:
 *  1. قراءة «نيّة الدفع» (intent) بمعرّفها — الحقيقة التي يُبنى عليها سند القبض، لا ما يقوله الجوال.
 *  2. قراءة نقاط البيع (terminals) لتاجر الشركة — كي لا تُسند لمندوبٍ نقطةُ تاجرٍ آخر فيذهب مالُ الشركة لغيرها.
 *  3. توقيع JWT لدخول المندوب إلى وحدة الدفع دون رمز تحقق (jwtLogin) — بمفتاح NearPay الخاص المحفوظ في البيئة.
 *
 * البيئة (لا شيء منها في المستودع):
 *  - NEARPAY_API_KEY: مفتاح «معلومات الربط» (ترويسة api-key).
 *  - NEARPAY_ENV: sandbox (الافتراض) أو production. وNEARPAY_API_BASE يغلبها إن وُجد (العنوان الإنتاجي لا يذكره التوثيق).
 *  - NEARPAY_CLIENT_UUID: «مفتاح العميل» — مطالبة client_uuid في JWT.
 *  - NEARPAY_JWT_PRIVATE_KEY: محتوى pos_key.pem (يُنزَّل مرة واحدة من اللوحة). أسطره الجديدة قد تُحفظ «\n» حرفية.
 *
 * درس القياس (٢٨ أكتوبر ٢٠٢٦): Cloudflare أمام sandbox-api يرفض الطلب بلا User-Agent معروف (1010 browser_signature_banned)
 * — فكل طلب يحمل User-Agent صريحاً.
 */

const UA = 'FieldSales-Server/1.0 (+https://fieldsa.net)';
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 40;

export type NearpayEnv = 'sandbox' | 'production';

export function nearpayEnv(): NearpayEnv {
  return process.env.NEARPAY_ENV === 'production' ? 'production' : 'sandbox';
}

function apiBase(): string {
  const explicit = (process.env.NEARPAY_API_BASE || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  return nearpayEnv() === 'production' ? '' : 'https://sandbox-api.nearpay.io/v1/clients-sdk';
}

/** الواجهة مهيأة للقراءة والتحقق (مفتاح + عنوان) — بدونها لا تُنشأ عملية دفع أصلاً */
export function nearpayConfigured(): boolean {
  return !!(process.env.NEARPAY_API_KEY || '').trim() && !!apiBase();
}

/**
 * دخول JWT مهيأ (المفتاح الخاص + معرّف العميل). وحدة الدفع في تطبيق المندوب لا تنفّذ دخول OTP، فبدونه لا تحصيل بالبطاقة
 * (cardPayLaunchConfigured في cardPayment.ts)
 */
export function nearpayJwtConfigured(): boolean {
  return !!privateKey() && !!(process.env.NEARPAY_CLIENT_UUID || '').trim();
}

function privateKey(): string {
  const raw = (process.env.NEARPAY_JWT_PRIVATE_KEY || '').trim();
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

export class NearpayError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number | string) { super(message); }
}

async function call<T>(method: 'GET' | 'PUT', path: string): Promise<T> {
  const base = apiBase();
  if (!base || !(process.env.NEARPAY_API_KEY || '').trim()) throw new NearpayError('NearPay غير مهيأ', 503);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { 'api-key': process.env.NEARPAY_API_KEY!.trim(), Accept: 'application/json', 'User-Agent': UA },
        signal: ctl.signal,
      });
      text = await res.text();
    } catch (e) {
      // انقطاع أو مهلة — خطأ مزوّدٍ مؤقت (504) لا خطأ خادمنا (500)
      throw new NearpayError(`NearPay ${method} ${path.split('?')[0]} unreachable: ${(e as Error).name}`, 504);
    }
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok) {
      const b = (body ?? {}) as { code?: number | string; code_text?: string };
      throw new NearpayError(`NearPay ${method} ${path.split('?')[0]} → ${res.status}${b.code_text ? ` ${b.code_text}` : ''}`, res.status, b.code ?? b.code_text);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

// ═══ النيّة (intent) — مصدر الحقيقة لسند القبض ═══

/** ما نحتاجه من نيّة NearPay بعد تطبيعه — التوثيق يسمّي الحقل الواحد باسمين أحياناً (intenet_id، is_reconcilied…) */
export interface IntentSnapshot {
  found: boolean;
  id: string | null;
  status: string | null; // new | approved | declined | cancelled … كما ورد بأحرف صغيرة
  amountHalalas: number | null;
  approved: boolean; // إيصالٌ موافَق عليه في معاملات النيّة
  reversed: boolean; // عكسٌ أو استرداد كامل ظاهر
  tid: string | null;
  transactionUuid: string | null;
  rrn: string | null;
  stan: string | null;
  approvalCode: string | null;
  cardScheme: string | null;
  maskedPan: string | null;
  statusMessage: string | null;
  /** معاملات شراء موافَقة لم تُعكس ولم تُسترد — المتوقّع واحدة؛ أكثر = خصمٌ مكرر يحتاج مراجعة */
  effectiveCount: number;
  /** ما أذن به البنك للمعاملة الفعّالة بالهللات (من إيصالها) — null إن لم يُقرأ */
  authorizedHalalas: number | null;
  /** استردادٌ على المعاملة الفعّالة: none، أو full (بالمبلغ كله)، أو partial (أقل، أو مبلغه مجهول) */
  refund: 'none' | 'full' | 'partial';
  /** إشارةُ مالٍ لا تُفسَّر (استردادٌ أو عكسٌ معلّق، أو مستقلٌّ لا يُنسب، أو استرجاع chargeback) — تُوقف القيد والإلغاء معاً */
  anomaly: string | null;
}

const NOT_FOUND: IntentSnapshot = {
  found: false, id: null, status: null, amountHalalas: null, approved: false, reversed: false, tid: null,
  transactionUuid: null, rrn: null, stan: null, approvalCode: null, cardScheme: null, maskedPan: null, statusMessage: null,
  effectiveCount: 0, authorizedHalalas: null, refund: 'none', anomaly: null,
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const o = obj(v);
  if (o) return str(o.value ?? o.english ?? o.name ?? null);
  return null;
};
const truthy = (v: unknown): boolean => v === true || v === 'true' || v === 1;

/** المبلغ بالهللات من حقل النيّة («800» = ٨٫٠٠) — نصٌّ أو رقمٌ صحيح، وما سوى ذلك مجهول */
function halalasOf(v: unknown): number | null {
  const s = str(v);
  if (s === null || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** مبلغ إيصالٍ بالريال («115.00») إلى هللات — الإيصالات بالريال بخلاف النيّة */
function sarToHalalasStrict(v: unknown): number | null {
  const s = str(v);
  if (s === null || !/^\d+(\.\d{1,3})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

const REVERSAL_TYPE = /revers|void|cancel/;
const REFUND_TYPE = /refund/;
const PURCHASE_TYPE = /purchase|sale/;
const CHARGEBACK_TYPE = /charge.?back|dispute/;
// حال الحدث: موافَقٌ (أو منتهٍ بنجاح)، أو مرفوضٌ صراحة — وما سواهما معلّقٌ لا يُهمَل في الاسترداد والعكس
const EVENT_OK = /approv|success|complet|accept/;
const EVENT_REJECTED = /declin|reject|fail|denied|error/;

/**
 * يطبّع ردّ GET /intents/{id}. الشكل الموثّق: { details: { intenet_id, reference_id, status, amount, transactions: [{ id, status,
 * card{pan}, amount, events: [{ rrn, stan, type, status, receipt: { data: { tid, pan, card_scheme, is_approved, approval_code{value},
 * transaction_uuid, amount_authorized, retrieval_reference_number, system_trace_audit_number, status_message } } }] }] } }.
 *
 * كل معاملةٍ على حدة (مراجعة ٢٨ أكتوبر ٢٠٢٦): النيّة الواحدة قد تحمل معاملةً عُكست آلياً ثم إعادةً نجحت، أو خصماً مكرراً —
 * فالمعاملة «الفعّالة» شراءٌ موافَق عليه لم يُعكس ولم يُسترد كاملاً، ومنها وحدها تُقرأ نقطة البيع والمراجع والمبلغ المأذون.
 * ومراجعة ٣١ أكتوبر ٢٠٢٦: المستردّة كاملاً ليست فعّالة (فاستردادُ أحد خصمين لا يُلغي سند الآخر)، والاسترداد يُحسب لكل معاملة،
 * و«reversed» دليل المعاملات وحده (حالة النيّة يقرؤها القرار)، وإشارة مالٍ لا تُفسَّر تصير anomaly لا تُهمَل.
 * دالة صرفة — تُختبر بلا شبكة.
 */
export function parseIntent(raw: unknown): IntentSnapshot {
  const root = obj(raw);
  const d = obj(root?.details) ?? obj(root?.intent) ?? root;
  if (!d) return { ...NOT_FOUND };
  const out: IntentSnapshot = {
    ...NOT_FOUND,
    found: true,
    id: str(d.intenet_id ?? d.intent_id ?? d.id),
    status: (str(d.status) || '').toLowerCase() || null,
    amountHalalas: halalasOf(d.amount),
  };

  interface Item { type: string; evStatus: string; data: Obj; rrn: unknown; stan: unknown }
  interface Effective { r: Obj; tx: Obj; authorized: number | null; refundAmt: number; refundUnknown: boolean; refunded: boolean }
  const effective: Effective[] = [];
  const anomalies: string[] = [];
  let approvedPurchases = 0;
  let fullyRefunded = 0;
  // استردادٌ في معاملةٍ مستقلة بلا شراء — يُنسب بعد الحلقة للشراء الفعّال الوحيد إن وُجد
  const loose = { count: 0, halalas: 0, unknown: false };
  const done = (it: Item) => truthy(it.data.is_approved) || EVENT_OK.test(it.evStatus);
  const rejected = (it: Item) => it.data.is_approved === false || it.data.is_approved === 'false' || EVENT_REJECTED.test(it.evStatus);
  const fullyCovers = (refund: number, unknown: boolean, base: number | null) => !unknown && base !== null && refund >= base;

  for (const t of arr(d.transactions)) {
    const tx = obj(t);
    if (!tx) continue;
    const events = arr(tx.events);
    // بنود المعاملة: أحداثها بإيصالاتها (Find Intent) أو المعاملة نفسها مسطّحة (List Intents)
    const items: Item[] = events.length
      ? events.map((e) => {
        const ev = obj(e) ?? {};
        const data = obj(obj(ev.receipt)?.data) ?? obj(ev.receipt) ?? {};
        return { type: (str(ev.type) || str(data.transaction_type) || '').toLowerCase(), evStatus: (str(ev.status) || '').toLowerCase(), data, rrn: ev.rrn, stan: ev.stan };
      })
      : [{ type: (str(tx.transaction_type) || 'purchase').toLowerCase(), evStatus: '', data: tx, rrn: tx.retrieval_reference_number, stan: undefined }];
    // مبالغ الإيصالات بالريال؛ وفي الشكل المسطّح وحدة amount_authorized غير مؤكدة (هللات في القوائم) — فلا تُقرأ
    const amountsOf = (xs: Item[]) => xs.map((it) => (events.length ? sarToHalalasStrict(it.data.amount_authorized) : null));
    if (items.some((it) => CHARGEBACK_TYPE.test(it.type) && !rejected(it))) anomalies.push('استرجاع (chargeback) على العملية لدى NearPay');
    const refundItems = items.filter((it) => REFUND_TYPE.test(it.type));
    const refundsDone = refundItems.filter(done);
    const refundsOpen = refundItems.filter((it) => !done(it) && !rejected(it));
    // الشراء بنوعه صراحةً — حدثٌ بنوعٍ فارغ أو غريب لا يصير «شراءً موافَقاً» يُقيد به سند
    const purchase = items.find((it) => PURCHASE_TYPE.test(it.type) && truthy(it.data.is_approved));
    if (!purchase) {
      if (refundsDone.length || refundsOpen.length) {
        const amts = amountsOf(refundsDone);
        loose.count += 1;
        loose.halalas += amts.reduce<number>((a, x) => a + (x ?? 0), 0);
        if (refundsOpen.length || amts.some((x) => x === null)) loose.unknown = true;
      }
      const msg = items.map((it) => str(it.data.status_message)).find(Boolean);
      if (msg && !out.statusMessage) out.statusMessage = msg;
      continue;
    }
    approvedPurchases += 1;
    const txStatus = (str(tx.status) || '').toLowerCase();
    const reversals = items.filter((it) => REVERSAL_TYPE.test(it.type));
    const reversedHere = truthy(tx.is_reversed) || truthy(purchase.data.is_reversed) || REVERSAL_TYPE.test(txStatus) || reversals.some(done);
    if (reversedHere) continue;
    // عكسٌ لم يُحسم (لا موافَق ولا مرفوض): قد يعود المال — لا قيد ولا إبقاءٌ صامت
    if (reversals.some((it) => !rejected(it))) anomalies.push('عكس غير محسوم على العملية لدى NearPay');
    const refundAmts = amountsOf(refundsDone);
    const refunded = refundsDone.length > 0 || refundsOpen.length > 0 || truthy(tx.is_refunded) || truthy(purchase.data.is_refunded) || REFUND_TYPE.test(txStatus);
    const refundUnknown = refunded && (refundsDone.length === 0 || refundsOpen.length > 0 || refundAmts.some((x) => x === null));
    const refundAmt = refundAmts.reduce<number>((a, x) => a + (x ?? 0), 0);
    const authorized = events.length ? sarToHalalasStrict(purchase.data.amount_authorized) : null;
    // مستردّةٌ بالمبلغ كله: لا مال باقٍ منها عند التاجر — ليست «فعّالة»
    if (refunded && fullyCovers(refundAmt, refundUnknown, authorized ?? out.amountHalalas)) { fullyRefunded += 1; continue; }
    effective.push({ r: { ...purchase.data, _rrn: purchase.rrn, _stan: purchase.stan }, tx, authorized, refundAmt, refundUnknown, refunded });
  }

  if (loose.count > 0) {
    if (effective.length === 1) {
      const e = effective[0];
      e.refunded = true;
      e.refundAmt += loose.halalas;
      e.refundUnknown = e.refundUnknown || loose.unknown;
      if (fullyCovers(e.refundAmt, e.refundUnknown, e.authorized ?? out.amountHalalas)) { effective.pop(); fullyRefunded += 1; }
    } else if (effective.length > 1 || approvedPurchases === 0) {
      anomalies.push('استرداد في معاملة مستقلة لا يُنسب إلى شراء بعينه');
    }
    // لا فعّال بعد شراءٍ موافَق: عُكس كلّه أو استُرد — لا مال باقٍ يُنسب إليه الاسترداد
  }

  out.effectiveCount = effective.length;
  out.anomaly = anomalies[0] ?? null;
  // دليل المعاملات وحده: عُكس كل شراءٍ موافَق أو استُرد كاملاً — حالة النيّة نفسها يحكم بها القرار (cardPayment.ts)
  out.reversed = approvedPurchases > 0 && effective.length === 0;
  if (out.reversed && fullyRefunded > 0) out.refund = 'full';
  const e = effective[0];
  if (e) {
    const r = e.r;
    out.approved = true;
    out.tid = str(r.tid);
    out.transactionUuid = str(r.transaction_uuid ?? r.uuid);
    out.rrn = str(r.retrieval_reference_number ?? r._rrn);
    out.stan = str(r.system_trace_audit_number ?? r._stan);
    out.approvalCode = str(r.approval_code);
    out.cardScheme = str(r.card_scheme ?? r.scheme);
    out.maskedPan = str(r.pan) ?? str(obj(e.tx.card)?.pan);
    out.authorizedHalalas = e.authorized;
    // المستردّ كاملاً خرج من الفعّال — فما بقي عليه استردادٌ جزئي أو مجهول المبلغ
    if (e.refunded) out.refund = 'partial';
  }
  return out;
}

/**
 * النيّة بمعرّفها — null إن لم تُسجَّل بعد لدى NearPay: 404 برمز intent_not_found (4047) وحده. أيّ 404 آخر (عنوانٌ أو مسارٌ
 * خاطئ) يُرمى فيُسجَّل وتبقى العملية معلّقة — لا تُعدّ «غير مسجّلة» فتنتهي صامتة.
 * وكذلك ردّ 200 بشكلٍ لا نعرفه (صفحة HTML، أو غلافٌ آخر، أو بلا حالة، أو نيّةٌ غير المطلوبة) — مراجعة ٣١ أكتوبر ٢٠٢٦:
 * كان يُقرأ «غير مسجّلة» فتنتهي الدفعة المقبوضة بلا سند ولا تنبيه.
 */
export async function fetchIntent(intentId: string): Promise<IntentSnapshot | null> {
  let raw: unknown;
  try {
    raw = await call<unknown>('GET', `/intents/${encodeURIComponent(intentId)}`);
  } catch (e) {
    if (e instanceof NearpayError && e.status === 404 && (e.code === 4047 || e.code === '4047' || e.code === 'intent_not_found')) return null;
    throw e;
  }
  const snap = parseIntent(raw);
  if (!snap.found || !snap.status || (snap.id || '').toLowerCase() !== intentId.toLowerCase()) {
    throw new NearpayError(`NearPay intent ${intentId}: unrecognized response shape`, 502);
  }
  return snap;
}

// ═══ نقاط البيع — لإسنادها للمناديب ═══

export interface NearpayTerminal { id: string; tid: string; merchantId: string | null; merchantName: string | null; userMobile: string | null; connected: boolean }

export function parseTerminals(raw: unknown): NearpayTerminal[] {
  return arr(obj(raw)?.terminals).map((t) => {
    const o = obj(t) ?? {};
    const m = obj(o.merchant);
    return {
      id: str(o.id) ?? '',
      tid: str(o.tid) ?? '',
      merchantId: str(m?.id),
      merchantName: str(m?.name_ar) ?? str(m?.name),
      userMobile: str(obj(o.user)?.mobile),
      connected: truthy(o.is_connected),
    };
  }).filter((t) => t.id && /^\d{8,20}$/.test(t.tid));
}

/** نقاط بيع تاجرٍ واحد — الصفحات حتى ٢٠ (٣٠ نقطة لكل تاجر في الساند بوكس) */
export async function listMerchantTerminals(merchantId: string): Promise<NearpayTerminal[]> {
  const out: NearpayTerminal[] = [];
  for (let page = 1; ; page++) {
    const raw = await call<unknown>('GET', `/terminals?page=${page}&limit=50`);
    if (!arr(obj(raw)?.terminals).length) break;
    out.push(...parseTerminals(raw).filter((t) => t.merchantId === merchantId));
    const total = Number(obj(obj(raw)?.pages)?.total ?? 1);
    if (page >= total) break;
    // قائمةٌ مبتورة تُظهر نقطةً صحيحة «لتاجرٍ آخر» — الخطأ أصدق من النقص
    if (page >= MAX_PAGES) throw new NearpayError(`NearPay terminals exceed ${MAX_PAGES} pages`, 502);
  }
  return out;
}

export interface NearpayMerchant { id: string; name: string; referenceId: string | null }

export async function listMerchants(): Promise<NearpayMerchant[]> {
  const out: NearpayMerchant[] = [];
  for (let page = 1; ; page++) {
    const raw = obj(await call<unknown>('GET', `/merchants?page=${page}`));
    const list = arr(raw?.merchants);
    if (!list.length) break;
    for (const m of list) {
      const o = obj(m) ?? {};
      const id = str(o.id);
      if (id) out.push({ id, name: str(o.name_ar) ?? str(o.name) ?? id, referenceId: str(o.reference_id) });
    }
    const total = Number(obj(raw?.pages)?.total ?? 1);
    if (page >= total) break;
    if (page >= MAX_PAGES) throw new NearpayError(`NearPay merchants exceed ${MAX_PAGES} pages`, 502);
  }
  return out;
}

// ═══ دخول المندوب بـJWT ═══

/**
 * JWT لدخول وحدة الدفع على نقطة بيع المندوب — RS256 بمفتاح NearPay الخاص، والحمولة بالشكل الموثّق
 * { data: { ops: 'auth', client_uuid, terminal_id } } (غياب data يرجع الخطأ 4038). عمره دقائق: يُطلب لحظة الدفع ولا يُخزَّن.
 */
export function signTerminalJwt(tid: string, ttlSeconds = 300): string {
  const key = privateKey();
  const clientUuid = (process.env.NEARPAY_CLIENT_UUID || '').trim();
  if (!key || !clientUuid) throw new NearpayError('دخول JWT غير مهيأ', 503);
  return jwt.sign({ data: { ops: 'auth', client_uuid: clientUuid, terminal_id: tid } }, key, {
    algorithm: 'RS256',
    ...(ttlSeconds > 0 ? { expiresIn: ttlSeconds } : {}),
  });
}
