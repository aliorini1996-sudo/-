// ============================================================================
// عميل شبكة بوابة «سفير فيلد سيلز» — معزول تماماً (العقد §1 القاعدة 7).
//
// عميل axios مستقلّ بمفتاح توكن خاص `ax_token`: البوابة لا تستورد
// `api/client.ts` ولا مخزن مصادقة الشركة، وجلستها لا تتقاطع مع جلسة لوحة
// الشركة أو المندوب أو المالك على المتصفّح نفسه. و401 يمسح `ax_token` وحده.
// ============================================================================
import axios, { AxiosError, type AxiosResponse } from 'axios';
import type {
  PublicTerms, RegisterBody, AffiliateMe, MeResponse, UpdateMeBody, Dashboard, CompanyRow, UserStatus,
  ClaimBody, ClaimRow, CommissionRow, AdjustmentRow, PayoutRow, PayoutProfileBody, PricingResponse } from './types';
import { isTermsOutdated } from './errors';

const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';
export const TOKEN_KEY = 'ax_token';

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token: string): void {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* تخزين محجوب — تبقى الجلسة لهذه الصفحة فقط */ }
}
export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* تجاهل */ }
}

const axApi = axios.create({
  baseURL: `${BASE}/affiliate`,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30_000,
});

axApi.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** مستمعو سقوط الجلسة — AffiliateApp يعود لشاشة الدخول */
const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => { unauthorizedListeners.delete(fn); };
}

/**
 * مستمعو «شروطٌ جديدة لم تُقبل» — 403 `terms_outdated` من أي مسارٍ للمعتمدين.
 * AffiliateApp يعيد قراءة /me ويعرض بوابة القبول: لا خطأ عامّ ولا خروج.
 */
const termsOutdatedListeners = new Set<() => void>();
export function onTermsOutdated(fn: () => void): () => void {
  termsOutdatedListeners.add(fn);
  return () => { termsOutdatedListeners.delete(fn); };
}

axApi.interceptors.response.use(
  (r) => r,
  (err: AxiosError) => {
    // 401 على طلبٍ حمل توكناً = جلسة ساقطة. أمّا 401 الدخول (كلمة مرور خاطئة) فبلا
    // توكن أصلاً ولا يجوز أن يطرد أحداً.
    const sentToken = !!(err.config?.headers as Record<string, unknown> | undefined)?.Authorization;
    if (err.response?.status === 401 && sentToken) {
      clearToken();
      unauthorizedListeners.forEach((fn) => { try { fn(); } catch { /* تجاهل */ } });
    }
    if (isTermsOutdated(err)) {
      termsOutdatedListeners.forEach((fn) => { try { fn(); } catch { /* تجاهل */ } });
    }
    return Promise.reject(err);
  },
);

/** يفكّ الغلاف `{ success, data }` — ويتسامح مع ردٍّ بلا غلاف */
function unwrap<T>(res: AxiosResponse): T {
  const body = res.data as { data?: unknown } | undefined;
  if (body && typeof body === 'object' && 'data' in body) return body.data as T;
  return body as T;
}

export function httpStatus(err: unknown): number | undefined {
  return (err as AxiosError)?.response?.status;
}

/**
 * نصّ الرسالة الموحّدة لردود 202 كما أرسلها الخادم (عربي) أو null — والشاشة تختار
 * بين عرضه بالعربية ونصّه المترجم (errors.ts: localizedServerText).
 */
function uniformMessage(res: AxiosResponse): string | null {
  const d = unwrap<{ message?: string } | undefined>(res);
  const top = (res.data as { message?: string } | undefined)?.message;
  return (d && typeof d.message === 'string' && d.message) || (typeof top === 'string' && top) || null;
}

export const affiliateApi = {
  // ---- عام ----
  publicTerms: async () => unwrap<PublicTerms>(await axApi.get('/terms/public')),
  register: async (body: RegisterBody) => uniformMessage(await axApi.post('/register', body)),
  /**
   * يتطلّب كلمة المرور التي سُجّل بها آخر طلب (400 `password_mismatch` إن لم تطابق).
   * `status` = حالة الحساب **الفعلية** (قد يكون مؤكَّداً مسبقاً ومقبولاً أو مرفوضاً).
   */
  verifyEmail: async (token: string, password: string) =>
    unwrap<{ status: UserStatus }>(await axApi.post('/verify-email', { token, password })),
  login: async (email: string, password: string) =>
    unwrap<{ token: string; user: AffiliateMe }>(await axApi.post('/login', { email, password })),
  resendVerification: async (email: string) => uniformMessage(await axApi.post('/resend-verification', { email })),
  forgot: async (email: string) => uniformMessage(await axApi.post('/forgot', { email })),
  /** `token`/`user` يُعادان لكل حساب مؤكَّد البريد — الاستعادة تُدخل صاحبها وتفكّ القفل */
  reset: async (token: string, password: string) =>
    unwrap<{ ok: true; token?: string; user?: AffiliateMe }>(await axApi.post('/reset', { token, password })),

  // ---- بجلسة ----
  me: async () => unwrap<MeResponse>(await axApi.get('/me')),
  updateMe: async (body: UpdateMeBody) => unwrap<{ user: AffiliateMe }>(await axApi.put('/me', body)),
  acceptTerms: async (termsVersion: string) => unwrap<{ user: AffiliateMe }>(await axApi.post('/accept-terms', { termsVersion })),

  // ---- approved فقط ----
  dashboard: async () => unwrap<Dashboard>(await axApi.get('/dashboard')),
  pricing: async () => unwrap<PricingResponse>(await axApi.get('/pricing')),
  companies: async () => unwrap<CompanyRow[]>(await axApi.get('/companies')),
  createClaim: async (body: ClaimBody) =>
    unwrap<{ id: string; message: string }>(await axApi.post('/claims', body)),
  claims: async () => unwrap<ClaimRow[]>(await axApi.get('/claims')),
  withdrawClaim: async (id: string) => unwrap<{ ok: true }>(await axApi.post(`/claims/${encodeURIComponent(id)}/withdraw`)),
  commissions: async () => unwrap<CommissionRow[]>(await axApi.get('/commissions')),
  adjustments: async () => unwrap<AdjustmentRow[]>(await axApi.get('/adjustments')),
  payouts: async () => unwrap<PayoutRow[]>(await axApi.get('/payouts')),
  setPayoutProfile: async (body: PayoutProfileBody) => unwrap<{ user: AffiliateMe }>(await axApi.put('/payout-profile', body)),
};

/** مفاتيح react-query — كلها تحت 'ax' لتُمسح دفعةً عند الخروج */
export const qk = {
  all: ['ax'] as const,
  me: ['ax', 'me'] as const,
  terms: ['ax', 'terms'] as const,
  dashboard: ['ax', 'dashboard'] as const,
  pricing: ['ax', 'pricing'] as const,
  companies: ['ax', 'companies'] as const,
  claims: ['ax', 'claims'] as const,
  commissions: ['ax', 'commissions'] as const,
  adjustments: ['ax', 'adjustments'] as const,
  payouts: ['ax', 'payouts'] as const,
};

/** لا إعادة محاولة لأخطاء القرار (401/403/404/409) — فقط لعطل الشبكة أو الخادم */
export function shouldRetry(failureCount: number, err: unknown): boolean {
  const s = httpStatus(err);
  if (s && s < 500) return false;
  return failureCount < 1;
}
