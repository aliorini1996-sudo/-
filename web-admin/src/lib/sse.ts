/**
 * قارئ Server-Sent Events نقيّ — بلا React ولا متصفّح، فيُختبر في node.
 * يستعمله `liveInvoices.ts` لقراءة قناة التحديث اللحظيّ عبر fetch.
 */

export interface SseEvent { event: string; data: string }

/**
 * يقطّع مخزن SSE إلى أحداث مكتملة ويُرجع الباقي غير المكتمل.
 * الإطار ينتهي بسطر فارغ؛ أسطر `:` تعليقات (نبضات) تُتجاهل.
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: SseEvent[] = [];
  for (const block of parts) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length || event !== 'message') events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}
