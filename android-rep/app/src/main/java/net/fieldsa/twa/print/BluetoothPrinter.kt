package net.fieldsa.twa.print

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import java.io.IOException
import java.util.UUID

/** سبب فشل الطباعة كما تعرضه PrintActivity — لا نصّ تقنيّ يصل إلى المندوب */
enum class PrintFailure { CONNECT, DISCONNECTED, PERMISSION }

class PrintException(val failure: PrintFailure, cause: Throwable?) : Exception(failure.name, cause)

/**
 * عميل RFCOMM لطابعة مقترنة بالجوال (SPP). كل دوالّه حاجزة فتُستدعى على خيط io وحده؛ abort() وحدها من أي خيط.
 * المستدعي (PrintActivity) يتحقق من إذن BLUETOOTH_CONNECT على أندرويد 12+ قبل أي استدعاء، وعلى 11 فأقدم يكفي BLUETOOTH
 * (maxSdkVersion 30 في البيان) — لذلك يُكتم MissingPermission هنا، وSecurityException يصل إلى المستدعي PrintFailure.PERMISSION.
 * لا بحث عن أجهزة (لا BLUETOOTH_SCAN ولا cancelDiscovery) ولا createRfcommSocket بالانعكاس.
 */
@SuppressLint("MissingPermission")
internal class BluetoothPrinter {

    @Volatile
    private var socket: BluetoothSocket? = null

    @Volatile
    private var aborted = false

    /** يغلق المقبس فيفكّ connect() أو write() معلّقاً، ولا يُفتح بعده مقبس — من أي خيط */
    fun abort() {
        aborted = true
        closeQuietly(socket)
    }

    /** المقبس الآمن أولاً، ثم غير الآمن (طابعات كثيرة تُقرن بلا مصادقة) — آخر IOException يُرمى إن فشلا */
    @Throws(IOException::class)
    fun connect(device: BluetoothDevice): BluetoothSocket {
        val spp = UUID.fromString(BridgeContract.SPP_UUID)
        var last: IOException? = null
        for (secure in booleanArrayOf(true, false)) {
            if (aborted) throw IOException("aborted")
            val s = if (secure) {
                device.createRfcommSocketToServiceRecord(spp)
            } else {
                device.createInsecureRfcommSocketToServiceRecord(spp)
            }
            socket = s
            // abort() بين الإنشاء والإسناد لم يرَ هذا المقبس: يُغلق هنا
            if (aborted) {
                closeQuietly(s)
                socket = null
                throw IOException("aborted")
            }
            try {
                s.connect() // حاجز: ينتهي بنجاح أو IOException بعد نحو ١٢ ثانية، أو فوراً إن أُغلق المقبس
                return s
            } catch (e: IOException) {
                closeQuietly(s)
                socket = null
                last = e
            }
        }
        throw last ?: IOException("connect failed")
    }

    /**
     * يتصل ثم يكتب الأمر كله (أو حتى نقطة الإلغاء الآمنة) ثم يمهل الطابعة قبل الإغلاق. يعيد true إن أُلغيت.
     * progress(0, total) بعد نجاح الاتصال مباشرة، ثم بعد كل دفعة.
     */
    @Throws(PrintException::class)
    fun print(
        device: BluetoothDevice,
        job: PrintJob,
        cancelRequested: () -> Boolean,
        progress: (sent: Int, total: Int) -> Unit,
    ): Boolean {
        val s = try {
            connect(device)
        } catch (e: IOException) {
            throw PrintException(PrintFailure.CONNECT, e)
        } catch (e: SecurityException) {
            throw PrintException(PrintFailure.PERMISSION, e)
        }
        try {
            progress(0, job.bytes.size)
            val cancelled = try {
                PrintWriteLoop.write(s.outputStream, job, cancelRequested, { sleepQuietly(it) }, progress)
            } catch (e: IOException) {
                throw PrintException(PrintFailure.DISCONNECTED, e)
            }
            // write على RFCOMM يعود حين تُصفّ البيانات لا حين تصل: إغلاقٌ فوري قد يُسقط ذيل الأمر
            sleepQuietly(job.closeGraceMs.coerceIn(0, PrintWriteLoop.MAX_GRACE_MS).toLong() + DRAIN_EXTRA_MS)
            return cancelled
        } catch (e: SecurityException) {
            throw PrintException(PrintFailure.PERMISSION, e)
        } finally {
            closeQuietly(s)
            socket = null
        }
    }

    private companion object {
        const val DRAIN_EXTRA_MS = 700L

        fun closeQuietly(s: BluetoothSocket?) {
            try {
                s?.close()
            } catch (e: IOException) {
                // مغلقٌ أصلاً أو انقطع
            }
        }

        fun sleepQuietly(ms: Long) {
            if (ms <= 0) return
            try {
                Thread.sleep(ms)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
    }
}
