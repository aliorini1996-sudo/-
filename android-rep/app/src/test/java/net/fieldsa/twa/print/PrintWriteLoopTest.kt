package net.fieldsa.twa.print

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.OutputStream

/** نظير btSerial.test.ts في الويب: الدفعات نفسها، والإلغاء عند العلامة نفسها، وبايتات الإلغاء نفسها */
class PrintWriteLoopTest {

    /** يسجّل كل write دفعةً مستقلة، ويعدّ flush */
    private class RecordingStream : OutputStream() {
        val writes = mutableListOf<ByteArray>()
        var flushes = 0

        override fun write(b: Int) {
            writes += byteArrayOf(b.toByte())
        }

        override fun write(b: ByteArray, off: Int, len: Int) {
            writes += b.copyOfRange(off, off + len)
        }

        override fun flush() {
            flushes++
        }
    }

    private fun bytesOf(n: Int) = ByteArray(n) { (it % 251).toByte() }

    private fun job(
        bytes: ByteArray,
        marks: IntArray,
        cancel: ByteArray = byteArrayOf(),
        slow: Boolean = false,
        chunkBytes: Int = 512,
    ) = PrintJob(PrinterKind.ESCPOS, slow, chunkBytes, 20, 800, cancel, "", marks, bytes)

    @Test
    fun writesChunksOf512InOrderWithProgressAfterEach() {
        val out = RecordingStream()
        val progress = mutableListOf<Pair<Int, Int>>()
        val sleeps = mutableListOf<Long>()
        val bytes = bytesOf(1300)
        val cancelled = PrintWriteLoop.write(out, job(bytes, intArrayOf(1300)), { false }, { sleeps += it }) { s, t ->
            progress += s to t
        }
        assertFalse(cancelled)
        assertEquals(listOf(512, 512, 276), out.writes.map { it.size })
        assertArrayEquals(bytes, out.writes.reduce { a, b -> a + b })
        assertEquals(listOf(512 to 1300, 1024 to 1300, 1300 to 1300), progress)
        assertEquals(3, out.flushes)
        assertTrue(sleeps.isEmpty())
    }

    @Test
    fun cancelFinishesAtNextMarkThenSendsCancelBytes() {
        val out = RecordingStream()
        val cancel = byteArrayOf(0x1b, 0x40, 0x0c)
        var asked = 0
        // الإلغاء يُطلب بعد الدفعة الأولى (كـctrl.abort() بعد أول كتابة في اختبار الويب)
        val cancelled = PrintWriteLoop.write(
            out,
            job(bytesOf(3000), intArrayOf(2, 700, 1800, 3000), cancel),
            { asked++ > 0 },
            { },
        ) { _, _ -> }
        assertTrue(cancelled)
        assertEquals(listOf(512, 700 - 512, 3), out.writes.map { it.size })
        assertArrayEquals(cancel, out.writes.last())
    }

    @Test
    fun cancelExactlyOnAMarkStopsWithoutAnotherChunk() {
        val out = RecordingStream()
        var asked = 0
        val cancelled = PrintWriteLoop.write(
            out,
            job(bytesOf(1024), intArrayOf(512, 1024), byteArrayOf(0x1b, 0x40)),
            { asked++ > 0 },
            { },
        ) { _, _ -> }
        assertTrue(cancelled)
        assertEquals(listOf(512, 2), out.writes.map { it.size })
    }

    @Test
    fun slowLinkSleepsPauseAfterEveryChunk() {
        val sleeps = mutableListOf<Long>()
        val j = job(bytesOf(1300), intArrayOf(1300), slow = true)
        PrintWriteLoop.write(RecordingStream(), j, { false }, { sleeps += it }) { _, _ -> }
        assertEquals(listOf(20L, 20L, 20L), sleeps)
    }

    @Test
    fun chunkBytesIsClampedToMinimum64() {
        val out = RecordingStream()
        PrintWriteLoop.write(out, job(bytesOf(130), intArrayOf(130), chunkBytes = 1), { false }, { }) { _, _ -> }
        assertEquals(listOf(64, 64, 2), out.writes.map { it.size })
    }

    @Test
    fun chunkBytesIsClampedToMaximum4096() {
        val out = RecordingStream()
        PrintWriteLoop.write(out, job(bytesOf(5000), intArrayOf(5000), chunkBytes = 65_535), { false }, { }) { _, _ -> }
        assertEquals(listOf(4096, 904), out.writes.map { it.size })
    }
}
