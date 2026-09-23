// ============================================================================
// ZATCA المرحلة الثانية (Z5.2) — قفل داخل العملية لكل وحدة EGS قبل فتح معاملة الإصدار
// ----------------------------------------------------------------------------
// نقد الخطة (8): «SELECT … FOR UPDATE» على صفّ الوحدة هو الضمان الحقيقي لتسلسل ICV/PIH، لكن N طلبات إصدار متزامنة
// لشركة واحدة كانت ستفتح N معاملات تفاعلية يحجز كلٌّ منها اتصالاً من المجمّع وهو ينتظر القفل — فيجوع حامل القفل حتى
// P2028 ويفرغ المجمّع للمنصّة كلها. هذا القفل يُصفّ الطلبات في الذاكرة **قبل** طلب أي اتصال: معاملة واحدة مفتوحة لكل
// وحدة في هذه النسخة من الخادم، والباقي ينتظر بلا اتصال.
//   • FIFO عادل، ومهلة انتظار (تجاوزها ⇒ ZATCA_UNIT_BUSY 503 قابل للإعادة)، وسقف للطابور (الزائد يُرفض فوراً بدل تراكم
//     طلبات معلّقة تستهلك الذاكرة ومهلات العملاء).
//   • يُحرَّر دائماً (نجاحاً أو رمياً)، وحالة المفتاح تُحذف حين يفرغ — لا تسرّب لكل وحدة مرّت.
//   • ليس ضماناً عبر نسخ الخادم (Render نسخة واحدة اليوم): القفل على الصفّ يبقى الحارس الحقيقي.
// نقيّ: لا قاعدة بيانات ولا شبكة ولا services/gl.
// ============================================================================

import { ZatcaHttpError } from './errors';

/** أقصى انتظار افتراضي في الطابور قبل ZATCA_UNIT_BUSY (≈ maxWait لمعاملة الإصدار). */
export const ISSUANCE_MUTEX_WAIT_MS = 10_000;
/** أقصى عدد منتظرين لكل وحدة؛ الزائد يُرفض فوراً. */
export const ISSUANCE_MUTEX_MAX_WAITERS = 50;

interface Waiter {
  resolve: () => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

interface KeyState {
  held: boolean;
  queue: Waiter[];
}

export interface KeyedMutexRunOptions {
  /** مهلة الانتظار في الطابور (ms). */
  waitTimeoutMs?: number;
}

function busy(code: 'WAIT_TIMEOUT' | 'QUEUE_FULL'): ZatcaHttpError {
  return new ZatcaHttpError('ZATCA_UNIT_BUSY', { logDetail: { source: 'UNIT_MUTEX', code } });
}

export class KeyedAsyncMutex {
  private readonly states = new Map<string, KeyState>();
  private readonly maxWaiters: number;
  private readonly defaultWaitMs: number;

  constructor(opts: { maxWaiters?: number; waitTimeoutMs?: number } = {}) {
    this.maxWaiters = Math.max(0, Math.trunc(opts.maxWaiters ?? ISSUANCE_MUTEX_MAX_WAITERS));
    this.defaultWaitMs = Math.max(0, Math.trunc(opts.waitTimeoutMs ?? ISSUANCE_MUTEX_WAIT_MS));
  }

  /** عدد المفاتيح المحجوزة حالياً (للاختبار: يعود صفراً بعد انتهاء كل شيء). */
  get activeKeys(): number {
    return this.states.size;
  }

  /** عدد المنتظرين على مفتاح. */
  waiting(key: string): number {
    return this.states.get(key)?.queue.length ?? 0;
  }

  isHeld(key: string): boolean {
    return this.states.get(key)?.held === true;
  }

  private async acquire(key: string, waitMs: number): Promise<void> {
    let st = this.states.get(key);
    if (!st) {
      st = { held: false, queue: [] };
      this.states.set(key, st);
    }
    if (!st.held) {
      st.held = true;
      return;
    }
    if (st.queue.length >= this.maxWaiters) throw busy('QUEUE_FULL');
    const state = st;
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = { resolve, reject, timer: null, settled: false };
      w.timer = setTimeout(() => {
        if (w.settled) return;
        w.settled = true;
        const i = state.queue.indexOf(w);
        if (i >= 0) state.queue.splice(i, 1);
        reject(busy('WAIT_TIMEOUT'));
      }, waitMs);
      state.queue.push(w);
    });
  }

  private release(key: string): void {
    const st = this.states.get(key);
    if (!st) return;
    while (st.queue.length) {
      const next = st.queue.shift()!;
      if (next.settled) continue;
      next.settled = true;
      if (next.timer) clearTimeout(next.timer);
      // يبقى held = true: القفل ينتقل مباشرة إلى المنتظر التالي (لا نافذة يسبق فيها وافدٌ جديد الطابور)
      next.resolve();
      return;
    }
    this.states.delete(key);
  }

  /** ينفّذ fn حصرياً لهذا المفتاح (FIFO)، ويحرّر القفل مهما كانت النتيجة. */
  async runExclusive<T>(key: string, fn: () => Promise<T>, opts: KeyedMutexRunOptions = {}): Promise<T> {
    if (typeof key !== 'string' || key === '') throw new TypeError('KeyedAsyncMutex: مفتاح غير صالح');
    await this.acquire(key, Math.max(0, Math.trunc(opts.waitTimeoutMs ?? this.defaultWaitMs)));
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }
}

/** القفل المشترك لإصدار الفواتير في هذه العملية (مفتاحه معرّف الوحدة). */
export const issuanceUnitMutex = new KeyedAsyncMutex();
