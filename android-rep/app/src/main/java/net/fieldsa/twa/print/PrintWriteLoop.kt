package net.fieldsa.twa.print

import java.io.IOException
import java.io.OutputStream

/**
 * حلقة الكتابة إلى الطابعة — نظير sendJob في web-admin/src/lib/print/transport/btSerial.ts: دفعات بحجم chunkBytes بالترتيب،
 * والتقدّم بعد كل دفعة، ومهلة قصيرة بعد كل دفعة على الوصلة البطيئة، والإلغاء عند أقرب نهاية أمرٍ مكتمل (لا قطع في منتصف
 * صورة) ثم بايتات الإلغاء. خالصة بلا android.* فتختبرها PrintWriteLoopTest؛ مهلة الإغلاق على المستدعي (BluetoothPrinter).
 */
internal object PrintWriteLoop {
    const val MIN_CHUNK = 64
    const val MAX_CHUNK = 4096
    const val MAX_PAUSE_MS = 200
    const val MAX_GRACE_MS = 5000

    /** يعيد true إن أُلغيت: يكمل حتى أقرب علامة ≥ المُرسَل ثم يرسل بايتات الإلغاء — كـsendJob في الويب حرفياً */
    @Throws(IOException::class)
    fun write(
        out: OutputStream,
        job: PrintJob,
        cancelRequested: () -> Boolean,
        sleep: (Long) -> Unit,
        progress: (sent: Int, total: Int) -> Unit,
    ): Boolean {
        val chunk = job.chunkBytes.coerceIn(MIN_CHUNK, MAX_CHUNK)
        val pause = job.pauseMs.coerceIn(0, MAX_PAUSE_MS).toLong()
        val total = job.bytes.size
        var sent = 0
        var stopAt = total
        var cancelled = false
        while (sent < stopAt) {
            if (!cancelled && cancelRequested()) {
                cancelled = true
                stopAt = job.marks.firstOrNull { it >= sent } ?: total
                if (sent >= stopAt) break
            }
            val end = minOf(sent + chunk, stopAt)
            out.write(job.bytes, sent, end - sent)
            out.flush()
            sent = end
            progress(sent, total)
            if (job.slow) sleep(pause)
        }
        if (cancelled && job.cancel.isNotEmpty()) {
            out.write(job.cancel)
            out.flush()
        }
        return cancelled
    }
}
