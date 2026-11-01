package net.fieldsa.twa.print

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * العقد مع الويب: print_payload_vectors.json (متجهاتٌ ذهبية يولّدها مُرمِّز الويب ويختبرها bridgeVectors.test.ts بالملف نفسه)
 * — كل متجه OK يُفكّ بكل حقوله، وكل متجه رفضٍ يُرفض بالرمز نفسه حرفياً
 */
class PrintPayloadTest {

    private val fixture: JSONObject by lazy {
        val stream = javaClass.classLoader!!.getResourceAsStream("print_payload_vectors.json")
            ?: error("print_payload_vectors.json missing from test resources")
        JSONObject(stream.use { it.readBytes().toString(Charsets.UTF_8) })
    }

    @Test
    fun crc32MatchesIeeeCheckValue() {
        assertEquals(0xCBF43926L, PrintPayload.crc32("123456789".toByteArray(Charsets.US_ASCII)))
    }

    @Test
    fun fixtureConstantsEqualBridgeContract() {
        assertEquals("fieldsa-print-payload-vectors", fixture.getString("format"))
        assertEquals(1, fixture.getInt("version"))
        val c = fixture.getJSONObject("constants")
        assertEquals(BridgeContract.FORMAT_VERSION, c.getInt("FORMAT_VERSION"))
        assertEquals(BridgeContract.HEADER_BYTES, c.getInt("HEADER_BYTES"))
        assertEquals(BridgeContract.MAX_PAYLOAD_CHARS, c.getInt("MAX_PAYLOAD_CHARS"))
        assertEquals(BridgeContract.MAX_INNER_BYTES, c.getInt("MAX_INNER_BYTES"))
        assertEquals(BridgeContract.MAX_JOB_BYTES, c.getInt("MAX_JOB_BYTES"))
        assertEquals(BridgeContract.MAX_MARKS, c.getInt("MAX_MARKS"))
        assertEquals(BridgeContract.MAX_LABEL_BYTES, c.getInt("MAX_LABEL_BYTES"))
        assertEquals(BridgeContract.MAX_CANCEL_BYTES, c.getInt("MAX_CANCEL_BYTES"))
        assertEquals(8, c.length())
    }

    @Test
    fun everyVectorDecodesOrIsRejectedWithItsCode() {
        val vectors = fixture.getJSONArray("vectors")
        assertEquals(42, vectors.length())
        val seenCodes = mutableSetOf<String>()
        var ok = 0
        for (i in 0 until vectors.length()) {
            val v = vectors.getJSONObject(i)
            val name = v.getString("name")
            val expect = v.getString("expect")
            val payload = payloadOf(v.get("payload"))
            if (expect == "OK") {
                val got = try {
                    PrintPayload.decode(payload)
                } catch (e: PayloadException) {
                    fail("$name: expected OK, got ${e.error}")
                    return
                }
                assertJob(name, v.getJSONObject("job"), got)
                ok++
            } else {
                val error = try {
                    PrintPayload.decode(payload)
                    null
                } catch (e: PayloadException) {
                    e.error.name
                }
                assertEquals(name, expect, error)
                seenCodes += expect
            }
        }
        assertEquals(10, ok)
        // كل رمز رفضٍ في العقد مغطّى بمتجهٍ واحد على الأقل
        assertEquals(PayloadError.entries.map { it.name }.toSet(), seenCodes)
    }

    @Test
    fun rejectsPayloadAboveCapBeforeLookingAtCharacters() {
        val s = "!".repeat(BridgeContract.MAX_PAYLOAD_CHARS + 1)
        val error = try {
            PrintPayload.decode(s)
            null
        } catch (e: PayloadException) {
            e.error
        }
        assertEquals(PayloadError.TOO_LONG, error)
    }

    private fun payloadOf(p: Any): String = when (p) {
        is String -> p
        is JSONObject -> p.getString("prefix") + p.getString("repeat").repeat(p.getInt("count"))
        else -> error("bad payload shape: $p")
    }

    private fun assertJob(name: String, j: JSONObject, got: PrintJob) {
        assertEquals("$name kind", j.getString("kind"), got.kind.name.lowercase())
        assertEquals("$name slow", j.getBoolean("slow"), got.slow)
        assertEquals("$name chunkBytes", j.getInt("chunkBytes"), got.chunkBytes)
        assertEquals("$name pauseMs", j.getInt("pauseMs"), got.pauseMs)
        assertEquals("$name closeGraceMs", j.getInt("closeGraceMs"), got.closeGraceMs)
        assertEquals("$name cancel", j.getString("cancelHex"), hex(got.cancel))
        assertEquals("$name label", j.getString("label"), got.label)
        assertArrayEquals("$name marks", ints(j.getJSONArray("marks")), got.marks)
        val b = j.getJSONObject("bytes")
        if (b.has("hex")) {
            assertEquals("$name bytes", b.getString("hex"), hex(got.bytes))
        } else {
            assertEquals("$name length", b.getInt("zeros"), got.bytes.size)
            assertTrue("$name zeros", got.bytes.all { it.toInt() == 0 })
        }
    }

    private fun ints(a: JSONArray): IntArray = IntArray(a.length()) { a.getInt(it) }

    private fun hex(b: ByteArray): String = b.joinToString("") { String.format("%02x", it.toInt() and 0xFF) }
}
