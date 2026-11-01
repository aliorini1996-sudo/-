import Foundation

// FSP v1 — the print payload the web sends over the `fsPrint` bridge.
// Byte-compatible counterpart of web-admin/src/lib/print/transport/bridgePayload.ts (decode) and
// android-rep/.../print/PrintPayload.kt. The check order and the error codes are the contract: the
// 42 golden vectors in ci/print_payload_vectors.json are decoded by ci/fsp-check on every Codemagic
// build, before xcodebuild. Pure Foundation (no UIKit, no CoreBluetooth) so the CI harness compiles
// this file on its own for macOS.
//
// Inflate (encodings 1 and 2) is a small RFC 1951 decoder written here instead of Apple's
// Compression framework: the contract needs exact end-of-stream accounting (trailing bytes after
// the stream, a truncated zlib trailer), which compression_stream does not document. Production
// iOS traffic is raw (encoding 0) anyway; the decoder exists so the golden vectors pass unchanged.

/// Rejection codes, spelled exactly as in bridgePayload.ts / PrintPayload.kt.
enum FSPError: String, Error {
    case TOO_LONG
    case BAD_BASE64
    case BAD_HEADER
    case BAD_VERSION
    case BAD_ENCODING
    case BAD_LENGTH
    case INFLATE_FAILED
    case LENGTH_MISMATCH
    case BAD_CRC
    case BAD_LAYOUT
    case BAD_MARKS
}

/// Printer command language as encoded by the web (encodeForProfile → kind); first byte of INNER.
enum PrinterKind: UInt8 {
    case escpos = 1
    case escp24 = 2
    case tspl = 3

    var name: String {
        switch self {
        case .escpos: return "escpos"
        case .escp24: return "escp24"
        case .tspl: return "tspl"
        }
    }
}

/// A decoded print job: the exact bytes Web Serial would have written, plus the safe cancel marks.
struct PrintJob {
    let kind: PrinterKind
    let slow: Bool
    let chunkBytes: Int
    let pauseMs: Int
    let closeGraceMs: Int
    let cancel: [UInt8]
    let label: String
    let marks: [Int]
    let bytes: [UInt8]
}

enum FSP {
    static let formatVersion: UInt8 = 1
    static let headerBytes = 14
    static let maxPayloadChars = 196_608
    static let maxInnerBytes = 5_242_880
    static let maxJobBytes = 4_194_304
    static let maxMarks = 65_535
    static let maxLabelBytes = 160
    static let maxCancelBytes = 16
    /// iOS bridge caps (spec C.1): WKWebView IPC has no Binder limit, BLE speed is the real limit.
    static let iosMaxPayloadChars = 1_572_864
    static let iosMaxJobBytes = 1_048_576
    static let bridgeVersion = 1
    static let handlerName = "fsPrint"

    /// Decodes an FSP v1 payload. Untrusted input: every bound is checked before anything is allocated
    /// for it, and inflate is capped by the declared length. Order of checks = PrintPayload.kt.
    static func decode(_ s: String, maxChars: Int = FSP.maxPayloadChars) throws -> PrintJob {
        // 1. length in UTF-16 units (= JS / Kotlin String.length), before looking at the characters
        if s.utf16.count > maxChars { throw FSPError.TOO_LONG }
        // 2. base64url without padding
        let f = try base64Url(s)
        // 3–6. header
        guard f.count >= headerBytes, f[0] == 0x46, f[1] == 0x53, f[2] == 0x50 else { throw FSPError.BAD_HEADER }
        guard f[3] == formatVersion else { throw FSPError.BAD_VERSION }
        let enc = f[4]
        guard enc <= 2 else { throw FSPError.BAD_ENCODING }
        guard f[5] == 0 else { throw FSPError.BAD_HEADER }
        // 7. declared inner length
        let innerLength = Int(u32(f, 6))
        let crc = u32(f, 10)
        guard innerLength != 0, innerLength <= maxInnerBytes else { throw FSPError.BAD_LENGTH }
        // 8. body
        let body = Array(f[headerBytes...])
        let inner: [UInt8]
        switch enc {
        case 0:
            guard body.count == innerLength else { throw FSPError.BAD_LENGTH }
            inner = body
        case 1:
            inner = try inflateRaw(body, expected: innerLength)
        default:
            inner = try inflateZlib(body, expected: innerLength)
        }
        // 9. checksum
        guard crc32(inner) == crc else { throw FSPError.BAD_CRC }
        // 10–11. INNER
        return try parseInner(inner)
    }

    // MARK: - base64url

    private static let base64Table: [Int16] = {
        var t = [Int16](repeating: -1, count: 256)
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)
        for (i, c) in alphabet.enumerated() {
            t[Int(c)] = Int16(i)
        }
        return t
    }()

    /// Own decoder (Data(base64Encoded:) does not take the url alphabet and its strictness is undocumented).
    /// Unused trailing bits are ignored, like atob and java.util.Base64.
    static func base64Url(_ s: String) throws -> [UInt8] {
        let u = Array(s.utf8)
        let table = base64Table
        var v = [UInt8](repeating: 0, count: u.count)
        for i in 0..<u.count {
            let x = table[Int(u[i])]
            if x < 0 { throw FSPError.BAD_BASE64 }
            v[i] = UInt8(x)
        }
        if u.isEmpty || u.count % 4 == 1 { throw FSPError.BAD_BASE64 }
        var out = [UInt8]()
        out.reserveCapacity(u.count / 4 * 3 + 2)
        let full = u.count - u.count % 4
        var i = 0
        while i < full {
            let a = UInt32(v[i]) << 18
            let b = UInt32(v[i + 1]) << 12
            let c = UInt32(v[i + 2]) << 6
            let d = UInt32(v[i + 3])
            let n = a | b | c | d
            out.append(UInt8(truncatingIfNeeded: n >> 16))
            out.append(UInt8(truncatingIfNeeded: n >> 8))
            out.append(UInt8(truncatingIfNeeded: n))
            i += 4
        }
        let rem = u.count - full
        if rem >= 2 {
            var n = (UInt32(v[i]) << 18) | (UInt32(v[i + 1]) << 12)
            if rem == 3 { n |= UInt32(v[i + 2]) << 6 }
            out.append(UInt8(truncatingIfNeeded: n >> 16))
            if rem == 3 { out.append(UInt8(truncatingIfNeeded: n >> 8)) }
        }
        return out
    }

    // MARK: - checksums

    private static let crcTable: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 {
            c = (c & 1) != 0 ? (0xEDB8_8320 ^ (c >> 1)) : (c >> 1)
        }
        return c
    }

    /// CRC-32 (IEEE 802.3), same table as the TS CRC_TABLE. crc32("123456789") == 0xCBF43926.
    static func crc32(_ b: [UInt8]) -> UInt32 {
        let table = crcTable
        var c: UInt32 = 0xFFFF_FFFF
        for x in b {
            c = table[Int((c ^ UInt32(x)) & 0xFF)] ^ (c >> 8)
        }
        return c ^ 0xFFFF_FFFF
    }

    static func adler32(_ b: [UInt8]) -> UInt32 {
        var a: UInt32 = 1
        var s: UInt32 = 0
        for x in b {
            a = (a + UInt32(x)) % 65_521
            s = (s + a) % 65_521
        }
        return (s << 16) | a
    }

    /// Little-endian u32 at i (caller guarantees i + 4 <= b.count).
    static func u32(_ b: [UInt8], _ i: Int) -> UInt32 {
        let b0 = UInt32(b[i])
        let b1 = UInt32(b[i + 1]) << 8
        let b2 = UInt32(b[i + 2]) << 16
        let b3 = UInt32(b[i + 3]) << 24
        return b0 | b1 | b2 | b3
    }

    // MARK: - inflate

    /// Raw DEFLATE (RFC 1951). Exactly `expected` bytes out: more ⇒ LENGTH_MISMATCH (found while
    /// inflating), corrupt or truncated ⇒ INFLATE_FAILED, fewer ⇒ LENGTH_MISMATCH, bytes after the end
    /// of the stream ⇒ INFLATE_FAILED — the order of PrintPayload.kt inflate().
    static func inflateRaw(_ b: [UInt8], expected: Int) throws -> [UInt8] {
        if b.isEmpty { throw FSPError.INFLATE_FAILED }
        var z = Inflater(b, limit: expected)
        try z.run()
        if z.out.count != expected { throw FSPError.LENGTH_MISMATCH }
        if z.pos < b.count { throw FSPError.INFLATE_FAILED }
        return z.out
    }

    /// zlib (RFC 1950): 2-byte header, raw DEFLATE, big-endian Adler-32 trailer. The trailer is verified
    /// before the length, like java.util.zip.Inflater (which checks Adler-32 as part of "finished").
    static func inflateZlib(_ b: [UInt8], expected: Int) throws -> [UInt8] {
        guard b.count >= 2 else { throw FSPError.INFLATE_FAILED }
        let cmf = b[0]
        let flg = b[1]
        let check = (UInt16(cmf) << 8) | UInt16(flg)
        guard cmf & 0x0F == 8, cmf >> 4 <= 7, check % 31 == 0, flg & 0x20 == 0 else { throw FSPError.INFLATE_FAILED }
        let src = Array(b[2...])
        if src.isEmpty { throw FSPError.INFLATE_FAILED }
        var z = Inflater(src, limit: expected)
        try z.run()
        let rest = src.count - z.pos
        if rest < 4 { throw FSPError.INFLATE_FAILED }
        let t = z.pos
        let w0 = UInt32(src[t]) << 24
        let w1 = UInt32(src[t + 1]) << 16
        let w2 = UInt32(src[t + 2]) << 8
        let w3 = UInt32(src[t + 3])
        if adler32(z.out) != (w0 | w1 | w2 | w3) { throw FSPError.INFLATE_FAILED }
        if z.out.count != expected { throw FSPError.LENGTH_MISMATCH }
        if rest > 4 { throw FSPError.INFLATE_FAILED }
        return z.out
    }

    // MARK: - INNER

    static func parseInner(_ b: [UInt8]) throws -> PrintJob {
        var r = FSPReader(b)
        let kindCode = try r.u8()
        guard let kind = PrinterKind(rawValue: UInt8(kindCode)) else { throw FSPError.BAD_LAYOUT }
        let flags = try r.u8()
        if (flags & 0xFE) != 0 { throw FSPError.BAD_LAYOUT }
        let chunkBytes = try r.u16()
        let pauseMs = try r.u16()
        let closeGraceMs = try r.u16()
        if chunkBytes == 0 { throw FSPError.BAD_LAYOUT }
        let cancelLen = try r.u8()
        if cancelLen > maxCancelBytes { throw FSPError.BAD_LAYOUT }
        let cancel = try r.bytes(cancelLen)
        let labelLen = try r.u8()
        if labelLen > maxLabelBytes { throw FSPError.BAD_LAYOUT }
        let label = try r.utf8(labelLen)
        let marksCount = try r.u32()
        if marksCount == 0 || marksCount > maxMarks { throw FSPError.BAD_LAYOUT }
        var deltas = [Int]()
        deltas.reserveCapacity(marksCount)
        for _ in 0..<marksCount {
            let d = try r.varint()
            deltas.append(d)
        }
        let jobLength = try r.u32()
        if jobLength == 0 || jobLength > maxJobBytes { throw FSPError.BAD_LAYOUT }
        let bytes = try r.bytes(jobLength)
        if !r.atEnd { throw FSPError.BAD_LAYOUT }

        // Marks after the layout is complete: the first is absolute (may be 0), the rest are deltas ≥ 1,
        // and the last one is the end of the job.
        var marks = [Int](repeating: 0, count: deltas.count)
        var acc = 0
        for (i, d) in deltas.enumerated() {
            if i > 0 && d == 0 { throw FSPError.BAD_MARKS }
            acc += d
            if acc > jobLength { throw FSPError.BAD_MARKS }
            marks[i] = acc
        }
        if acc != jobLength { throw FSPError.BAD_MARKS }
        return PrintJob(kind: kind, slow: (flags & 1) == 1, chunkBytes: chunkBytes, pauseMs: pauseMs,
                        closeGraceMs: closeGraceMs, cancel: cancel, label: label, marks: marks, bytes: bytes)
    }

    /// Strict UTF-8 (Unicode Table 3-7): no overlongs, no surrogates D800–DFFF, nothing above U+10FFFF,
    /// no truncated sequence — what CharsetDecoder(REPORT) and TextDecoder({fatal:true}) accept.
    static func validUTF8(_ s: ArraySlice<UInt8>) -> Bool {
        var i = s.startIndex
        let end = s.endIndex
        while i < end {
            let c = s[i]
            if c < 0x80 {
                i += 1
                continue
            }
            var need = 0
            var lo: UInt8 = 0x80
            var hi: UInt8 = 0xBF
            switch c {
            case 0xC2...0xDF: need = 1
            case 0xE0: need = 2; lo = 0xA0
            case 0xE1...0xEC, 0xEE...0xEF: need = 2
            case 0xED: need = 2; hi = 0x9F
            case 0xF0: need = 3; lo = 0x90
            case 0xF1...0xF3: need = 3
            case 0xF4: need = 3; hi = 0x8F
            default: return false
            }
            if end - i <= need { return false }
            for k in 1...need {
                let x = s[i + k]
                let l: UInt8 = k == 1 ? lo : 0x80
                let h: UInt8 = k == 1 ? hi : 0xBF
                if x < l || x > h { return false }
            }
            i += need + 1
        }
        return true
    }
}

/// Sequential little-endian reader over INNER: any read past the end ⇒ BAD_LAYOUT.
struct FSPReader {
    private let b: [UInt8]
    private var p = 0

    init(_ b: [UInt8]) {
        self.b = b
    }

    var atEnd: Bool { return p == b.count }

    private func need(_ n: Int) throws {
        if n < 0 || n > b.count - p { throw FSPError.BAD_LAYOUT }
    }

    mutating func u8() throws -> Int {
        try need(1)
        let v = Int(b[p])
        p += 1
        return v
    }

    mutating func u16() throws -> Int {
        try need(2)
        let v = Int(b[p]) | (Int(b[p + 1]) << 8)
        p += 2
        return v
    }

    mutating func u32() throws -> Int {
        try need(4)
        let v = Int(FSP.u32(b, p))
        p += 4
        return v
    }

    mutating func bytes(_ n: Int) throws -> [UInt8] {
        try need(n)
        let out = Array(b[p..<(p + n)])
        p += n
        return out
    }

    mutating func utf8(_ n: Int) throws -> String {
        try need(n)
        let slice = b[p..<(p + n)]
        guard FSP.validUTF8(slice) else { throw FSPError.BAD_LAYOUT }
        p += n
        return String(decoding: slice, as: UTF8.self)
    }

    /// Unsigned LEB128: at most 5 bytes, and the 5th must be ≤ 0x0F (value ≤ 2³²−1, no continuation).
    mutating func varint() throws -> Int {
        var v = 0
        var shift = 0
        for k in 0..<5 {
            let byte = try u8()
            if k == 4 && (byte & 0xF0) != 0 { throw FSPError.BAD_LAYOUT }
            v |= (byte & 0x7F) << shift
            shift += 7
            if (byte & 0x80) == 0 { return v }
        }
        throw FSPError.BAD_LAYOUT
    }
}

/// Canonical Huffman table (count of codes per length, symbols ordered by code).
struct FSPHuffman {
    var count: [Int]
    var symbol: [Int]
}

/// Minimal RFC 1951 inflater (the structure of zlib's puff.c). `pos` is the number of input bytes
/// consumed, counting the partly used last byte, so the caller can see trailing data.
struct Inflater {
    let src: [UInt8]
    let limit: Int
    private(set) var pos = 0
    private(set) var out: [UInt8] = []
    private var bitBuf: UInt32 = 0
    private var bitCnt = 0

    private static let lbase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
                                35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
    private static let lext = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
                               3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
    private static let dbase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
                                257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
                                8193, 12289, 16385, 24577]
    private static let dext = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
                               7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
    private static let order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

    private static let fixedLength: FSPHuffman = {
        var l = [Int](repeating: 8, count: 288)
        for i in 144..<256 { l[i] = 9 }
        for i in 256..<280 { l[i] = 7 }
        return Inflater.build(l).table
    }()
    private static let fixedDistance: FSPHuffman = Inflater.build([Int](repeating: 5, count: 30)).table

    init(_ src: [UInt8], limit: Int) {
        self.src = src
        self.limit = limit
        out.reserveCapacity(limit)
    }

    /// Builds a canonical table. left == 0: complete; left > 0: incomplete; left < 0: over-subscribed.
    static func build(_ lengths: [Int]) -> (table: FSPHuffman, left: Int) {
        var h = FSPHuffman(count: [Int](repeating: 0, count: 16), symbol: [Int](repeating: 0, count: lengths.count))
        for l in lengths { h.count[l] += 1 }
        if h.count[0] == lengths.count { return (h, 0) }
        var left = 1
        for len in 1..<16 {
            left <<= 1
            left -= h.count[len]
            if left < 0 { return (h, left) }
        }
        var offs = [Int](repeating: 0, count: 16)
        for len in 1..<15 { offs[len + 1] = offs[len] + h.count[len] }
        for (sym, l) in lengths.enumerated() where l != 0 {
            h.symbol[offs[l]] = sym
            offs[l] += 1
        }
        return (h, left)
    }

    mutating func run() throws {
        var last = 0
        repeat {
            last = try bits(1)
            let type = try bits(2)
            switch type {
            case 0: try stored()
            case 1: try codes(Inflater.fixedLength, Inflater.fixedDistance)
            case 2: try dynamicBlock()
            default: throw FSPError.INFLATE_FAILED
            }
        } while last == 0
    }

    private mutating func bits(_ need: Int) throws -> Int {
        var val = bitBuf
        while bitCnt < need {
            guard pos < src.count else { throw FSPError.INFLATE_FAILED }
            val |= UInt32(src[pos]) << UInt32(bitCnt)
            pos += 1
            bitCnt += 8
        }
        bitBuf = val >> UInt32(need)
        bitCnt -= need
        let mask = (UInt32(1) << UInt32(need)) - 1
        return Int(val & mask)
    }

    private mutating func put(_ x: UInt8) throws {
        if out.count >= limit { throw FSPError.LENGTH_MISMATCH }
        out.append(x)
    }

    private mutating func stored() throws {
        bitBuf = 0
        bitCnt = 0
        guard src.count - pos >= 4 else { throw FSPError.INFLATE_FAILED }
        let len = Int(src[pos]) | (Int(src[pos + 1]) << 8)
        let nlen = Int(src[pos + 2]) | (Int(src[pos + 3]) << 8)
        pos += 4
        guard len == (~nlen & 0xFFFF) else { throw FSPError.INFLATE_FAILED }
        for _ in 0..<len {
            guard pos < src.count else { throw FSPError.INFLATE_FAILED }
            let x = src[pos]
            try put(x)
            pos += 1
        }
    }

    private mutating func decode(_ h: FSPHuffman) throws -> Int {
        var code = 0
        var first = 0
        var index = 0
        for len in 1..<16 {
            let bit = try bits(1)
            code |= bit
            let count = h.count[len]
            if code - count < first { return h.symbol[index + (code - first)] }
            index += count
            first += count
            first <<= 1
            code <<= 1
        }
        throw FSPError.INFLATE_FAILED
    }

    private mutating func codes(_ lencode: FSPHuffman, _ distcode: FSPHuffman) throws {
        while true {
            var sym = try decode(lencode)
            if sym < 256 {
                try put(UInt8(sym))
            } else if sym == 256 {
                return
            } else {
                sym -= 257
                guard sym < 29 else { throw FSPError.INFLATE_FAILED }
                let le = try bits(Inflater.lext[sym])
                let len = Inflater.lbase[sym] + le
                let ds = try decode(distcode)
                guard ds < 30 else { throw FSPError.INFLATE_FAILED }
                let de = try bits(Inflater.dext[ds])
                let dist = Inflater.dbase[ds] + de
                guard dist <= out.count else { throw FSPError.INFLATE_FAILED }
                for _ in 0..<len {
                    let x = out[out.count - dist]
                    try put(x)
                }
            }
        }
    }

    private mutating func dynamicBlock() throws {
        let nlen = try bits(5) + 257
        let ndist = try bits(5) + 1
        let ncode = try bits(4) + 4
        guard nlen <= 286, ndist <= 30 else { throw FSPError.INFLATE_FAILED }
        var codeLengths = [Int](repeating: 0, count: 19)
        for i in 0..<ncode {
            codeLengths[Inflater.order[i]] = try bits(3)
        }
        let lencodeBuilt = Inflater.build(codeLengths)
        guard lencodeBuilt.left == 0 else { throw FSPError.INFLATE_FAILED }
        let total = nlen + ndist
        var lengths = [Int](repeating: 0, count: total)
        var index = 0
        while index < total {
            let sym = try decode(lencodeBuilt.table)
            if sym < 16 {
                lengths[index] = sym
                index += 1
            } else {
                var len = 0
                var rep = 0
                if sym == 16 {
                    guard index > 0 else { throw FSPError.INFLATE_FAILED }
                    len = lengths[index - 1]
                    let e = try bits(2)
                    rep = 3 + e
                } else if sym == 17 {
                    let e = try bits(3)
                    rep = 3 + e
                } else {
                    let e = try bits(7)
                    rep = 11 + e
                }
                guard index + rep <= total else { throw FSPError.INFLATE_FAILED }
                for _ in 0..<rep {
                    lengths[index] = len
                    index += 1
                }
            }
        }
        guard lengths[256] != 0 else { throw FSPError.INFLATE_FAILED }
        // An incomplete code is accepted only when every used length is 1 (a single 1-bit code) — zlib's
        // inflate_table rule (`left > 0 && max != 1` ⇒ error) that java.util.zip.Inflater on Android applies.
        let lit = Inflater.build(Array(lengths[0..<nlen]))
        guard lit.left >= 0, lit.left == 0 || nlen == lit.table.count[0] + lit.table.count[1] else { throw FSPError.INFLATE_FAILED }
        let dst = Inflater.build(Array(lengths[nlen..<total]))
        guard dst.left >= 0, dst.left == 0 || ndist == dst.table.count[0] + dst.table.count[1] else { throw FSPError.INFLATE_FAILED }
        try codes(lit.table, dst.table)
    }
}

/// Write schedule of one job — the semantics of PrintWriteLoop.kt / btSerial.ts sendJob: slices in order,
/// a cancel finishes to the nearest mark ≥ sent (or the end), then the caller sends the cancel bytes.
/// Pure; exercised by ci/fsp-check.
struct WritePlan {
    static let minChunk = 64
    static let maxChunk = 4096
    static let maxPauseMs = 200
    static let maxGraceMs = 5000

    let total: Int
    let marks: [Int]
    private(set) var sent = 0
    private(set) var stopAt: Int
    private(set) var cancelled = false

    init(total: Int, marks: [Int]) {
        self.total = total
        self.marks = marks
        self.stopAt = total
    }

    var finished: Bool { return sent >= stopAt }

    /// First cancel request only.
    mutating func requestCancel() {
        guard !cancelled else { return }
        cancelled = true
        let at = sent
        stopAt = marks.first(where: { $0 >= at }) ?? total
    }

    /// Next slice of at most `max` bytes (at least 1), or nil when finished.
    mutating func next(max limit: Int) -> Range<Int>? {
        guard sent < stopAt else { return nil }
        let n = limit < 1 ? 1 : limit
        let r = sent..<Swift.min(sent + n, stopAt)
        sent = r.upperBound
        return r
    }

    static func dose(_ chunkBytes: Int) -> Int { return Swift.min(Swift.max(chunkBytes, minChunk), maxChunk) }
    static func pause(_ ms: Int) -> Int { return Swift.min(Swift.max(ms, 0), maxPauseMs) }
    /// Close grace plus 1 s: BLE writes without response have no delivery acknowledgement.
    static func grace(_ ms: Int) -> Int { return Swift.min(Swift.max(ms, 0), maxGraceMs) + 1000 }
}
