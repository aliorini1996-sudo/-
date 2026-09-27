/**
 * المندوب الذكي — «العقل» لكل شركة: كل شركة تضع مفتاح مزوّد الذكاء الاصطناعي الخاص بها (والكلفة على حسابها).
 *
 *   - مزوّدون بإعدادات جاهزة فقط (لا عنوان حرّ يكتبه أحد ⇒ لا طلبات من خادمنا إلى شبكات داخلية)، والنموذج قابل للتعديل.
 *   - المفتاح يُخزَّن **مشفّراً** (AES-256-GCM) بمفتاح مشتقّ (HKDF) من سرّ الخادم ZATCA_SECRETS_KEY بسياق مستقل
 *     لهذا الغرض، ومربوطاً بمعرّف الشركة (AAD) — نسخة القاعدة وحدها لا تكشفه، ولا يصلح نصّه المشفّر لشركة أخرى.
 *   - لا يُعاد المفتاح للواجهة أبداً: آخر ٤ محارف فقط.
 *   - لا مفتاح للشركة ⇒ إعداد الخادم العام (AI_REP_LLM_*) إن وُجد، وإلا المستشار «غير مضبوط».
 */
import * as crypto from 'crypto';
import prisma from '../config/database';
import { llmConfig, LlmConfig } from './llm';

export interface LlmProviderPreset {
  label: string;
  baseUrl: string;
  defaultModel: string;
  extraBody: Record<string, unknown>;
  keyHelpUrl: string;
}

export const LLM_PROVIDERS: Record<string, LlmProviderPreset> = {
  FIREWORKS_US: {
    label: 'DeepSeek V4.1 Flash عبر Fireworks (أمريكا حصراً) — موصى به',
    baseUrl: 'https://us.api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/routers/deepseek-v4p1-flash-us',
    extraBody: { reasoning_effort: 'high' },
    keyHelpUrl: 'https://fireworks.ai/account/api-keys',
  },
  DEEPINFRA: {
    label: 'DeepSeek V4.1 Flash عبر DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
    extraBody: { reasoning_effort: 'high' },
    keyHelpUrl: 'https://deepinfra.com/dash/api_keys',
  },
  GROQ: {
    label: 'OpenAI gpt-oss-120b عبر Groq — الأسرع',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
    // التفكير لا يُعاد في الرد (Groq يرفض إعادته بحقل reasoning_content) — يبقى محسوباً عندهم
    extraBody: { reasoning_effort: 'high', include_reasoning: false },
    keyHelpUrl: 'https://console.groq.com/keys',
  },
  GEMINI: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.8-flash',
    extraBody: { reasoning_effort: 'low' },
    keyHelpUrl: 'https://aistudio.google.com/apikey',
  },
  OPENAI: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6-sol',
    // Chat Completions في OpenAI لا تقبل الأدوات مع الاستدلال إلا بـnone
    extraBody: { reasoning_effort: 'none' },
    keyHelpUrl: 'https://platform.openai.com/api-keys',
  },
};

export const LLM_PROVIDER_CODES = Object.keys(LLM_PROVIDERS);

// ───────────── التشفير ─────────────

function masterKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = (env.ZATCA_SECRETS_KEY || '').trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b = Buffer.from(raw, raw.includes('-') || raw.includes('_') ? 'base64url' : 'base64');
    return b.length === 32 ? b : null;
  } catch { return null; }
}

function subKey(env?: NodeJS.ProcessEnv): Buffer | null {
  const m = masterKey(env);
  if (!m) return null;
  // اشتقاق بسياق مستقل: مفتاح هذا الغرض لا يساوي مفتاح أسرار الفوترة
  return Buffer.from(crypto.hkdfSync('sha256', m, Buffer.from('fieldsales-ai-rep'), Buffer.from('llm-api-key:v1'), 32));
}

export function secretsReady(env?: NodeJS.ProcessEnv): boolean { return !!subKey(env); }

export function encryptLlmKey(tenantId: string, apiKey: string, env?: NodeJS.ProcessEnv): string {
  const k = subKey(env);
  if (!k) throw new Error('SECRETS_NOT_CONFIGURED');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(Buffer.from(`ai-rep:llm:${tenantId}`));
  const ct = Buffer.concat([c.update(apiKey, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}.${c.getAuthTag().toString('base64url')}`;
}

export function decryptLlmKey(tenantId: string, stored: string, env?: NodeJS.ProcessEnv): string | null {
  const k = subKey(env);
  const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(stored || '');
  if (!k || !m) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(m[1], 'base64url'));
    d.setAAD(Buffer.from(`ai-rep:llm:${tenantId}`));
    d.setAuthTag(Buffer.from(m[3], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(m[2], 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}

export const keyHint = (apiKey: string): string => apiKey.trim().slice(-4);

// ───────────── إعداد الشركة ─────────────

export interface TenantLlmRow { llmProvider: string | null; llmModel: string | null; llmKeyEnc: string | null }

/** إعداد العقل من صفّ الشركة؛ لا مفتاح ⇒ الإعداد العام من البيئة (إن وُجد). */
export function llmConfigFromRow(tenantId: string, row: TenantLlmRow | null, env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const preset = row?.llmProvider ? LLM_PROVIDERS[row.llmProvider] : undefined;
  if (row?.llmKeyEnc && preset) {
    const apiKey = decryptLlmKey(tenantId, row.llmKeyEnc, env);
    if (apiKey) {
      return {
        baseUrl: preset.baseUrl, apiKey, model: (row.llmModel || '').trim() || preset.defaultModel,
        extraBody: { ...preset.extraBody }, timeoutMs: 20000, maxTokens: 8192,
      };
    }
  }
  return llmConfig(env);
}

const cache = new Map<string, { at: number; cfg: LlmConfig | null }>();
const TTL_MS = 30 * 1000;

export async function tenantLlmConfig(tenantId: string): Promise<LlmConfig | null> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.cfg;
  const row = await prisma.aiRepSettings.findUnique({ where: { tenantId }, select: { llmProvider: true, llmModel: true, llmKeyEnc: true } });
  const cfg = llmConfigFromRow(tenantId, row);
  cache.set(tenantId, { at: Date.now(), cfg });
  return cfg;
}

export function clearTenantLlmCache(tenantId: string): void { cache.delete(tenantId); }
