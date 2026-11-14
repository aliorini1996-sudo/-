// عملية فرعية لاختبار عزل المعاينة (linking-isolate.test.ts): بروتوكول previewIsolate.ts الحقيقي (serveIsolatedRun) بمشغّلٍ مزيّف
// يختار سلوكه من tenantId — بلا قاعدة. ليست ملف اختبار (لا تُشغَّل وحدها).
import { serveIsolatedRun } from '../services/gl/linking/previewIsolate';
import { PREVIEW_ERROR_MESSAGES, PreviewRunError } from '../services/gl/linking/preview';
import { ShadowGlAccessError } from '../services/gl/linking/shadowClient';
import type { PreviewResult } from '../services/gl/linking/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

serveIsolatedRun(async (tenantId, opts, hooks) => {
  switch (tenantId) {
    case 'ok': {
      await hooks.onProgress?.('COSTING', 10);
      await hooks.onProgress?.('POST', 55);
      return {
        tenantId, linkedFrom: opts.linkedFrom, dataHash: 'd'.repeat(64), resultHash: 'r'.repeat(64),
        big: 123_456_789_012_345_678_901n, when: new Date('2027-01-01T00:00:00Z'), byRep: new Map([['r1', -5n]]),
        pid: process.pid, execArgv: process.execArgv, heapLimit: Number(process.env.__CHECK_HEAP ? 1 : 0),
      } as unknown as PreviewResult;
    }
    case 'already': throw new PreviewRunError('ALREADY_ACTIVATED', PREVIEW_ERROR_MESSAGES.ALREADY_ACTIVATED);
    case 'shadow': throw new ShadowGlAccessError('glMove.findMany');
    case 'p2028': throw Object.assign(new Error('Transaction already closed'), { code: 'P2028' });
    case 'boom': throw new Error('boom');
    case 'oom': {
      // كومةٌ تنمو بلا حدّ — سقف --max-old-space-size يُنهي هذه العملية وحدها
      const keep: unknown[] = [];
      for (;;) {
        keep.push(new Array(50_000).fill(keep.length));
        if (keep.length % 50 === 0) await hooks.onProgress?.('POST', 50);
      }
    }
    case 'crash': {
      await hooks.onProgress?.('READ', 2);
      process.exit(3);
      throw new Error('unreachable');
    }
    case 'hang': {
      await hooks.onProgress?.('READ', 2);
      for (;;) await sleep(1_000);
    }
    default: throw new Error(`سلوك غير معروف: ${tenantId}`);
  }
});
