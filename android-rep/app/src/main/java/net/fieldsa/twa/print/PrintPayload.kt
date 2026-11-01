package net.fieldsa.twa.print

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Base64
import java.util.zip.CRC32
import java.util.zip.DataFormatException
import java.util.zip.Inflater

/** لغة الطابعة كما يرسلها الويب (encodeForProfile ← kind) — الرمز هو البايت الأول من INNER */
enum class PrinterKind(val code: Int) { ESCPOS(1), ESCP24(2), TSPL(3) }

/** رموز الرفض بأسمائها حرفياً كما في bridgePayload.ts — الترتيب في decode هو الحَكَم (§A.3.6 من المواصفة) */
enum class PayloadError {
    TOO_LONG,
    BAD_BASE64,
    BAD_HEADER,
    BAD_VERSION,
    BAD_ENCODING,
    BAD_LENGTH,
    INFLATE_FAILED,
    LENGTH_MISMATCH,
    BAD_CRC,
    BAD_LAYOUT,
    BAD_MARKS,
}

class PayloadException(val error: PayloadError) : Exception(error.name)

/** أمر طباعة مفكوك: البايتات نفسها التي كان Web Serial سيرسلها، وعلامات نهايات الأوامر للإلغاء الآمن */
class PrintJob(
    val kind: PrinterKind,
    val slow: Boolean,
    val chunkBytes: Int,
    val pauseMs: Int,
    val closeGraceMs: Int,
    val cancel: ByteArray,
    val label: String,
    val marks: IntArray,
    val bytes: ByteArray,
)

/**
 * فكّ حمولة الجسر v1 (base64url ← إطار FSP ← INNER). مدخلٌ غير موثوق: أي موقعٍ يطلق fieldsaprint://print، فكل حدٍّ يُفحص
 * قبل أن يُحجز له شيء، والفكّ مقيّد بالطول المعلن (≤ MAX_INNER_BYTES) فلا قنبلة ضغط. Kotlin/JVM خالص بلا android.* —
 * تختبره PrintPayloadTest على المتجهات الذهبية نفسها التي يختبر بها الويب مُرمِّزه.
 */
object PrintPayload {
    private const val ENC_RAW = 0
    private const val ENC_DEFLATE_RAW = 1
    private const val ENC_ZLIB = 2
    private const val MAX_STALLS = 2

    fun decode(payload: String): PrintJob {
        // ١. الطول قبل النظر في الأحرف
        if (payload.length > BridgeContract.MAX_PAYLOAD_CHARS) fail(PayloadError.TOO_LONG)
        // ٢. base64url بلا حشو
        val f = base64Url(payload)
        // ٣–٦. الترويسة
        if (f.size < BridgeContract.HEADER_BYTES ||
            u8(f, 0) != 0x46 || u8(f, 1) != 0x53 || u8(f, 2) != 0x50
        ) {
            fail(PayloadError.BAD_HEADER)
        }
        if (u8(f, 3) != BridgeContract.FORMAT_VERSION) fail(PayloadError.BAD_VERSION)
        val encoding = u8(f, 4)
        if (encoding != ENC_RAW && encoding != ENC_DEFLATE_RAW && encoding != ENC_ZLIB) fail(PayloadError.BAD_ENCODING)
        if (u8(f, 5) != 0) fail(PayloadError.BAD_HEADER)
        // ٧. الطول المعلن
        val innerLength = u32(f, 6)
        val crc = u32(f, 10)
        if (innerLength == 0L || innerLength > BridgeContract.MAX_INNER_BYTES) fail(PayloadError.BAD_LENGTH)
        val expected = innerLength.toInt()
        val bodyOffset = BridgeContract.HEADER_BYTES
        // ٨. الجسم
        val inner = if (encoding == ENC_RAW) {
            if (f.size - bodyOffset != expected) fail(PayloadError.BAD_LENGTH)
            f.copyOfRange(bodyOffset, f.size)
        } else {
            inflate(f, bodyOffset, nowrap = encoding == ENC_DEFLATE_RAW, expected = expected)
        }
        // ٩. المجموع
        if (CRC32().apply { update(inner) }.value != crc) fail(PayloadError.BAD_CRC)
        // ١٠–١١. INNER
        return parseInner(inner)
    }

    /** CRC-32 (IEEE 802.3) — للاختبار: crc32("123456789") = 0xCBF43926 */
    fun crc32(b: ByteArray): Long = CRC32().apply { update(b) }.value

    private fun base64Url(s: String): ByteArray {
        if (s.isEmpty() || s.length % 4 == 1) fail(PayloadError.BAD_BASE64)
        for (c in s) {
            val ok = (c in 'A'..'Z') || (c in 'a'..'z') || (c in '0'..'9') || c == '-' || c == '_'
            if (!ok) fail(PayloadError.BAD_BASE64)
        }
        return try {
            // getUrlDecoder يقبل غياب الحشو، ولا يفحص البتّات الزائدة في آخر حرف (كـatob وNode) — API 26 = minSdk
            Base64.getUrlDecoder().decode(s)
        } catch (e: IllegalArgumentException) {
            fail(PayloadError.BAD_BASE64)
        }
    }

    /**
     * يفكّ دفقاً واحداً كاملاً يخرج منه expected بايتاً بالضبط: أكثر ⇒ LENGTH_MISMATCH، تالف أو مبتور ⇒ INFLATE_FAILED،
     * أقصر ⇒ LENGTH_MISMATCH، وبايتات بعد نهاية الدفق ⇒ INFLATE_FAILED — الترتيب نفسه في bridgePayload.ts
     */
    private fun inflate(f: ByteArray, off: Int, nowrap: Boolean, expected: Int): ByteArray {
        val inf = Inflater(nowrap)
        try {
            inf.setInput(f, off, f.size - off)
            val out = ByteArray(expected)
            var n = 0
            var stalls = 0
            while (!inf.finished()) {
                if (n == expected) {
                    // كل ما أُعلن خرج والدفق لم ينتهِ: بايتٌ زائد ⇒ أطول مما أُعلن، ولا شيء ⇒ دفقٌ مبتور
                    val k = step(inf, ByteArray(1), 0, 1)
                    if (k > 0) fail(PayloadError.LENGTH_MISMATCH)
                    if (inf.finished()) break
                    fail(PayloadError.INFLATE_FAILED)
                }
                val k = step(inf, out, n, expected - n)
                n += k
                if (k == 0 && !inf.finished()) {
                    if (inf.needsInput() || inf.needsDictionary() || ++stalls > MAX_STALLS) fail(PayloadError.INFLATE_FAILED)
                } else {
                    stalls = 0
                }
            }
            if (n != expected) fail(PayloadError.LENGTH_MISMATCH)
            if (inf.remaining > 0) fail(PayloadError.INFLATE_FAILED)
            return out
        } finally {
            inf.end()
        }
    }

    private fun step(inf: Inflater, buf: ByteArray, off: Int, len: Int): Int = try {
        inf.inflate(buf, off, len)
    } catch (e: DataFormatException) {
        fail(PayloadError.INFLATE_FAILED)
    }

    private fun parseInner(b: ByteArray): PrintJob {
        val r = Reader(b)
        val kindCode = r.u8()
        val kind = PrinterKind.entries.firstOrNull { it.code == kindCode } ?: fail(PayloadError.BAD_LAYOUT)
        val flags = r.u8()
        if (flags and 0xFE != 0) fail(PayloadError.BAD_LAYOUT)
        val chunkBytes = r.u16()
        val pauseMs = r.u16()
        val closeGraceMs = r.u16()
        if (chunkBytes == 0) fail(PayloadError.BAD_LAYOUT)
        val cancelLen = r.u8()
        if (cancelLen > BridgeContract.MAX_CANCEL_BYTES) fail(PayloadError.BAD_LAYOUT)
        val cancel = r.bytes(cancelLen)
        val labelLen = r.u8()
        if (labelLen > BridgeContract.MAX_LABEL_BYTES) fail(PayloadError.BAD_LAYOUT)
        val label = r.utf8(labelLen)
        val marksCount = r.u32()
        if (marksCount == 0L || marksCount > BridgeContract.MAX_MARKS) fail(PayloadError.BAD_LAYOUT)
        val deltas = LongArray(marksCount.toInt()) { r.varint() }
        val jobLength = r.u32()
        if (jobLength == 0L || jobLength > BridgeContract.MAX_JOB_BYTES) fail(PayloadError.BAD_LAYOUT)
        val bytes = r.bytes(jobLength.toInt())
        if (!r.atEnd()) fail(PayloadError.BAD_LAYOUT)

        // العلامات بعد اكتمال البنية: الأولى مطلقة (قد تكون 0) وما بعدها فروق ≥ 1، والأخيرة نهاية الأمر
        val marks = IntArray(deltas.size)
        var acc = 0L
        for (i in deltas.indices) {
            if (i > 0 && deltas[i] == 0L) fail(PayloadError.BAD_MARKS)
            acc += deltas[i]
            if (acc > jobLength) fail(PayloadError.BAD_MARKS)
            marks[i] = acc.toInt()
        }
        if (acc != jobLength) fail(PayloadError.BAD_MARKS)
        return PrintJob(
            kind = kind,
            slow = flags and 1 == 1,
            chunkBytes = chunkBytes,
            pauseMs = pauseMs,
            closeGraceMs = closeGraceMs,
            cancel = cancel,
            label = label,
            marks = marks,
            bytes = bytes,
        )
    }

    /** قارئ متتابع little-endian: أي قراءةٍ تتجاوز النهاية ⇒ BAD_LAYOUT */
    private class Reader(private val b: ByteArray) {
        private var p = 0

        private fun need(n: Int) {
            if (n < 0 || n > b.size - p) fail(PayloadError.BAD_LAYOUT)
        }

        fun atEnd(): Boolean = p == b.size

        fun u8(): Int {
            need(1)
            return b[p++].toInt() and 0xFF
        }

        fun u16(): Int {
            need(2)
            val v = (b[p].toInt() and 0xFF) or ((b[p + 1].toInt() and 0xFF) shl 8)
            p += 2
            return v
        }

        fun u32(): Long {
            need(4)
            val v = u32(b, p)
            p += 4
            return v
        }

        fun bytes(n: Int): ByteArray {
            need(n)
            val out = b.copyOfRange(p, p + n)
            p += n
            return out
        }

        fun utf8(n: Int): String {
            need(n)
            val s = try {
                Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(b, p, n))
                    .toString()
            } catch (e: CharacterCodingException) {
                fail(PayloadError.BAD_LAYOUT)
            }
            p += n
            return s
        }

        /** LEB128 بلا إشارة: ≤ ٥ بايتات، والخامس ≤ 0x0F (القيمة ≤ 2³²−1 ولا استمرار بعده) */
        fun varint(): Long {
            var v = 0L
            var shift = 0
            for (k in 0 until 5) {
                val byte = u8()
                if (k == 4 && byte and 0xF0 != 0) fail(PayloadError.BAD_LAYOUT)
                v = v or ((byte and 0x7F).toLong() shl shift)
                shift += 7
                if (byte and 0x80 == 0) return v
            }
            fail(PayloadError.BAD_LAYOUT)
        }
    }

    private fun u8(b: ByteArray, i: Int): Int = b[i].toInt() and 0xFF

    private fun u32(b: ByteArray, i: Int): Long =
        (u8(b, i).toLong()) or (u8(b, i + 1).toLong() shl 8) or (u8(b, i + 2).toLong() shl 16) or (u8(b, i + 3).toLong() shl 24)

    private fun fail(error: PayloadError): Nothing = throw PayloadException(error)
}
