/**
 * عزل معاينة «ربط الدفاتر» في عملية Node مستقلة بسقف ذاكرة (L2 — إصلاح نفاد ذاكرة الخادم وتجميد حلقة الأحداث).
 *
 * المعاينة تبني ظلّ السنة كلها في الذاكرة (~4KB حيّة لكل حدث) وتطوي التكلفة وتجمّع النتيجة بعمل متزامن طويل. داخل عملية
 * الـAPI نفسها (خطة starter: 512MB، نصف نواة) كانت شركةٌ كبيرة تُسقط الخادم كله بنفاد الذاكرة قبل أن تبلغ سقف الأحداث
 * (TOO_LARGE)، وتجمّد حلقة الأحداث ثوانيَ لكل الشركات والمناديب. هنا تُشغَّل runPreview في **عملية فرعية** (child_process.fork):
 *  - بـ`--max-old-space-size` = PREVIEW_CHILD_HEAP_MB (أو LEDGER_PREVIEW_HEAP_MB): تجاوزه يُنهي العملية الفرعية وحدها، فتُعلَّم
 *    المعاينة FAILED(TOO_LARGE) ويبقى الخادم سليماً — والعملية + الخادم دون سقف الحاوية (الخادم ~140MB).
 *  - حلقة أحداث مستقلة: لا تجميد للـAPI مهما طال العمل المتزامن.
 *  - عميل Prisma مستقل بها باتصالين (المُصدِّرة والدوّارة في snapshot.ts)، يُغلق بانتهائها — لا اتصال خامل في الخادم.
 *  - قتلٌ قسريّ بعد killAfterMs (مهلة المهمة وهامش): لا معاينة متروكة تستمرّ بعد أن عُلّمت TIMEOUT.
 * البروتوكول (IPC بتسلسل advanced — BigInt وDate وMap تعبر كما هي): الأب ⇐ {run}، والابن ⇒ progress* ثم result أو error.
 * الخطأ يعبر برمزه (previewErrorCodeOf في الابن) فيُعاد PreviewRunError بالرمز نفسه في الأب، والتفاصيل في سجلّ الخادم (stderr).
 */
import { fork } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { withConnectionLimit } from '../sync/postingStore.prisma';
import { PREVIEW_ERROR_MESSAGES, PreviewRunError, previewErrorCodeOf, runPreview } from './preview';
import {
  PREVIEW_TIMEOUT_MS,
  type PreviewErrorCode, type PreviewHooks, type PreviewOptions, type PreviewPhase, type PreviewResult,
} from './types';

/** سقف كومة العملية الفرعية (MB): الخادم ~140MB + العملية (الكومة + المحرّك والشيفرة ~80MB) دون 512MB */
export const PREVIEW_CHILD_HEAP_MB = 192;
/** متغيّر بيئة يرفع السقف/يخفضه دون نشر شيفرة (خطة أكبر) */
export const PREVIEW_HEAP_ENV = 'LEDGER_PREVIEW_HEAP_MB';
/** علامة العملية الفرعية: وحدها تجعل هذه الوحدة تخدم طلب تشغيل حين تكون الوحدة الرئيسية */
export const PREVIEW_CHILD_ENV_FLAG = 'LEDGER_PREVIEW_CHILD';
/** اتصالا العملية الفرعية: معاملة تصدير اللقطة + المعاملة الدوّارة (snapshot.ts) */
export const PREVIEW_CHILD_CONNECTIONS = 2;
/** هامش القتل القسري بعد مهلة المهمة */
export const PREVIEW_KILL_GRACE_MS = 30_000;

type RunMessage = { type: 'run'; tenantId: string; opts: PreviewOptions };
type ChildMessage =
  | { type: 'progress'; phase: PreviewPhase; pct: number }
  | { type: 'result'; result: PreviewResult }
  | { type: 'error'; code: PreviewErrorCode; detail: string };

export interface IsolateOptions {
  /** وحدة العملية الفرعية (الافتراضي هذه الوحدة) — للاختبار */
  entry?: string;
  heapMb?: number;
  killAfterMs?: number;
  env?: NodeJS.ProcessEnv;
  /** وسائط Node للأب (الافتراضي process.execArgv) — يُبقى منها محمّل الشيفرة وحده (tsx في التطوير) */
  execArgv?: readonly string[];
}

/** حدّ الكومة من البيئة أو الثابت (عددٌ صحيح بين 64 و4096) */
export function previewHeapMb(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env[PREVIEW_HEAP_ENV]);
  return Number.isInteger(v) && v >= 64 && v <= 4096 ? v : PREVIEW_CHILD_HEAP_MB;
}

/**
 * وسائط Node للعملية الفرعية: محمّلات الشيفرة وحدها من وسائط الأب (`--require`/`--import`/`--loader` — tsx في التطوير
 * والاختبار؛ لا شيء في الإنتاج)، ثم سقف الكومة. لا يُورَّث --inspect ولا --test* ولا سقف كومة الأب.
 */
export function childExecArgv(parent: readonly string[], heapMb: number): string[] {
  const out: string[] = [];
  const LOADERS = ['--require', '-r', '--import', '--loader', '--experimental-loader'];
  for (let i = 0; i < parent.length; i++) {
    const a = parent[i];
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (!LOADERS.includes(flag)) continue;
    if (eq > 0) out.push(a);
    else if (i + 1 < parent.length) { out.push(a, parent[i + 1]); i++; }
  }
  out.push(`--max-old-space-size=${heapMb}`);
  return out;
}

/** خرجت العملية الفرعية بنفاد الكومة؟ (V8: «Reached heap limit»/«heap out of memory» ثم abort) */
export function isHeapExhaustion(stderr: string, code: number | null, signal: NodeJS.Signals | null): boolean {
  if (/Reached heap limit|heap out of memory|Allocation failed - JavaScript heap/i.test(stderr)) return true;
  return signal === 'SIGABRT' || code === 134;
}

/**
 * يشغّل runPreview في عملية فرعية ويعيد نتيجتها (أو PreviewRunError برمزها). onProgress يصل من الابن كما هو.
 * لا يمسّ قاعدة البيانات في الأب.
 */
export function runPreviewIsolated(
  tenantId: string, opts: PreviewOptions, hooks: PreviewHooks = {}, iso: IsolateOptions = {},
): Promise<PreviewResult> {
  const env = iso.env ?? process.env;
  const heapMb = iso.heapMb ?? previewHeapMb(env);
  const killAfterMs = iso.killAfterMs ?? PREVIEW_TIMEOUT_MS + PREVIEW_KILL_GRACE_MS;
  return new Promise<PreviewResult>((resolve, reject) => {
    const child = fork(iso.entry ?? __filename, [], {
      execArgv: childExecArgv(iso.execArgv ?? process.execArgv, heapMb),
      env: { ...env, [PREVIEW_CHILD_ENV_FLAG]: '1' },
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
    });
    let settled = false;
    let stderrTail = '';
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      fn();
    };
    const killer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      finish(() => reject(new PreviewRunError('TIMEOUT', PREVIEW_ERROR_MESSAGES.TIMEOUT, { killAfterMs })));
    }, killAfterMs);
    killer.unref?.();
    child.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(d);
      stderrTail = (stderrTail + d.toString('utf8')).slice(-8_000);
    });
    child.on('message', (m: ChildMessage) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'progress') {
        if (!settled && hooks.onProgress) void Promise.resolve().then(() => hooks.onProgress!(m.phase, m.pct)).catch(() => undefined);
        return;
      }
      if (m.type === 'result') finish(() => resolve(m.result));
      else if (m.type === 'error') {
        const code: PreviewErrorCode = m.code in PREVIEW_ERROR_MESSAGES ? m.code : 'INTERNAL';
        finish(() => reject(new PreviewRunError(code, PREVIEW_ERROR_MESSAGES[code], { child: m.detail })));
      }
    });
    child.on('error', (e) => finish(() => reject(e)));
    // close لا exit: يُطلق بعد تفريغ قناة IPC والمخرجات، فلا تسبق النهايةُ رسالةَ النتيجة
    child.on('close', (code, signal) => {
      finish(() => {
        if (isHeapExhaustion(stderrTail, code, signal)) {
          reject(new PreviewRunError('TOO_LARGE', PREVIEW_ERROR_MESSAGES.TOO_LARGE, { heapMb }));
        } else {
          reject(new PreviewRunError('INTERNAL', PREVIEW_ERROR_MESSAGES.INTERNAL, { exitCode: code, signal, stderr: stderrTail.slice(-1_000) }));
        }
      });
    });
    child.send({ type: 'run', tenantId, opts } satisfies RunMessage, (err) => {
      if (err) finish(() => { child.kill('SIGKILL'); reject(err); });
    });
  });
}

/**
 * runPreview بتوقيعه (لاعتماديات المهمة) معزولاً: العميل المُمرَّر لا يُستعمل — للعملية الفرعية عميلها (createPreviewJobDeps
 * بـownsClient فلا يُنشأ عميل معاينة في الخادم).
 */
export const isolatedRunPreview: typeof runPreview = (_db, tenantId, opts, hooks) => runPreviewIsolated(tenantId, opts, hooks);

/**
 * جانب العملية الفرعية: ينتظر طلب التشغيل الوحيد، ويرسل التقدّم ثم النتيجة أو الخطأ برمزه، ثم يخرج بعد تسليم الرسالة.
 * مُصدَّر لاختبار البروتوكول بمشغّلٍ مزيّف (بلا قاعدة).
 */
export function serveIsolatedRun(run: (tenantId: string, opts: PreviewOptions, hooks: PreviewHooks) => Promise<PreviewResult>): void {
  const send = (msg: ChildMessage): Promise<void> => new Promise((res) => {
    if (!process.send || !process.connected) { res(); return; }
    process.send(msg, undefined, {}, () => res());
  });
  process.once('message', (raw: unknown) => {
    const m = raw as RunMessage;
    void (async () => {
      if (!m || m.type !== 'run') { process.exit(2); return; }
      try {
        const result = await run(m.tenantId, m.opts, { onProgress: (phase, pct) => { void send({ type: 'progress', phase, pct }); } });
        await send({ type: 'result', result });
      } catch (e) {
        const code = previewErrorCodeOf(e);
        console.error('[ledger-linking] preview child failed', { tenantId: m.tenantId, code }, e);
        await send({ type: 'error', code, detail: String((e as Error)?.message ?? e).slice(0, 2_000) });
      }
      process.disconnect?.();
      process.exit(0);
    })();
  });
}

/** المشغّل الإنتاجي في العملية الفرعية: عميل Prisma مستقل باتصالين يُغلق بانتهاء المعاينة */
async function runInChild(tenantId: string, opts: PreviewOptions, hooks: PreviewHooks): Promise<PreviewResult> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL غير مضبوط في عملية المعاينة');
  const db = new PrismaClient({ datasources: { db: { url: withConnectionLimit(url, PREVIEW_CHILD_CONNECTIONS) } }, log: ['error'] });
  try {
    return await runPreview(db, tenantId, opts, hooks);
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

if (require.main === module && process.env[PREVIEW_CHILD_ENV_FLAG] === '1') serveIsolatedRun(runInChild);
