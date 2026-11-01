// fsp-check — FSP v1 contract check for the iOS decoder, run by codemagic.yaml before xcodebuild:
//   xcrun --sdk macosx swiftc -O -o /tmp/fsp-check FieldSales/PrintPayload.swift ci/fsp-check/main.swift
//   /tmp/fsp-check ci/print_payload_vectors.json
// The fixture is a byte-identical copy of android-rep/app/src/test/resources/print_payload_vectors.json
// (sha256 afa7cbd5a15dd7383565b1efb86e43074114c5ab0bf5cd8ffb3afd09259d03ef), the same golden vectors the
// web encoder (bridgeVectors.test.ts) and the Android decoder (PrintPayloadTest.kt) are tested with.
// Prints every mismatch with the vector name, then exits 1 if there was any.

import Foundation

var failures = 0

func fail(_ message: String) {
    failures += 1
    print("✗ " + message)
}

func expectEqual<T: Equatable>(_ got: T, _ want: T, _ what: String) {
    if got != want { fail("\(what): got \(got), want \(want)") }
}

func hex(_ b: [UInt8]) -> String {
    return b.map { String(format: "%02x", $0) }.joined()
}

func intValue(_ value: Any?) -> Int? {
    return (value as? NSNumber)?.intValue
}

// MARK: - fixture

let args = CommandLine.arguments
guard args.count >= 2, let data = FileManager.default.contents(atPath: args[1]) else {
    print("✗ usage: fsp-check <print_payload_vectors.json> (file not readable)")
    exit(1)
}
guard let rootAny = try? JSONSerialization.jsonObject(with: data, options: []),
      let root = rootAny as? [String: Any] else {
    print("✗ fixture is not a JSON object")
    exit(1)
}

expectEqual(root["format"] as? String ?? "", "fieldsa-print-payload-vectors", "fixture format")
expectEqual(intValue(root["version"]) ?? -1, 1, "fixture version")

let constants = root["constants"] as? [String: Any] ?? [:]
let wantConstants: [(String, Int)] = [
    ("FORMAT_VERSION", Int(FSP.formatVersion)),
    ("HEADER_BYTES", FSP.headerBytes),
    ("MAX_PAYLOAD_CHARS", FSP.maxPayloadChars),
    ("MAX_INNER_BYTES", FSP.maxInnerBytes),
    ("MAX_JOB_BYTES", FSP.maxJobBytes),
    ("MAX_MARKS", FSP.maxMarks),
    ("MAX_LABEL_BYTES", FSP.maxLabelBytes),
    ("MAX_CANCEL_BYTES", FSP.maxCancelBytes),
]
expectEqual(constants.count, 8, "constants count")
for (key, value) in wantConstants {
    expectEqual(intValue(constants[key]) ?? -1, value, "constant \(key)")
}

// MARK: - vectors

let vectors = root["vectors"] as? [[String: Any]] ?? []
expectEqual(vectors.count, 42, "vector count")

func payloadOf(_ p: Any?) -> String? {
    if let s = p as? String { return s }
    if let d = p as? [String: Any], let prefix = d["prefix"] as? String, let rep = d["repeat"] as? String,
       let count = intValue(d["count"]) {
        return prefix + String(repeating: rep, count: count)
    }
    return nil
}

func checkJob(_ name: String, _ want: [String: Any], _ got: PrintJob) {
    expectEqual(got.kind.name, want["kind"] as? String ?? "?", "\(name) kind")
    expectEqual(got.slow, (want["slow"] as? NSNumber)?.boolValue ?? !got.slow, "\(name) slow")
    expectEqual(got.chunkBytes, intValue(want["chunkBytes"]) ?? -1, "\(name) chunkBytes")
    expectEqual(got.pauseMs, intValue(want["pauseMs"]) ?? -1, "\(name) pauseMs")
    expectEqual(got.closeGraceMs, intValue(want["closeGraceMs"]) ?? -1, "\(name) closeGraceMs")
    expectEqual(hex(got.cancel), want["cancelHex"] as? String ?? "?", "\(name) cancel")
    expectEqual(got.label, want["label"] as? String ?? "\u{FFFD}?", "\(name) label")
    let marks = (want["marks"] as? [Any] ?? []).map { intValue($0) ?? -1 }
    expectEqual(got.marks, marks, "\(name) marks")
    let bytes = want["bytes"] as? [String: Any] ?? [:]
    if let h = bytes["hex"] as? String {
        if hex(got.bytes) != h { fail("\(name) bytes differ (\(got.bytes.count) bytes)") }
    } else if let zeros = intValue(bytes["zeros"]) {
        expectEqual(got.bytes.count, zeros, "\(name) length")
        if got.bytes.contains(where: { $0 != 0 }) { fail("\(name) bytes are not all zero") }
    } else {
        fail("\(name) fixture has no bytes")
    }
}

var okCount = 0
var seenCodes = Set<String>()
for v in vectors {
    let name = v["name"] as? String ?? "?"
    let expect = v["expect"] as? String ?? "?"
    guard let payload = payloadOf(v["payload"]) else {
        fail("\(name): bad payload shape")
        continue
    }
    do {
        let job = try FSP.decode(payload)
        if expect == "OK" {
            okCount += 1
            if let want = v["job"] as? [String: Any] {
                checkJob(name, want, job)
            } else {
                fail("\(name): fixture has no job")
            }
        } else {
            fail("\(name): expected \(expect), got OK")
        }
    } catch let e as FSPError {
        if e.rawValue != expect { fail("\(name): expected \(expect), got \(e.rawValue)") }
        if expect != "OK" { seenCodes.insert(expect) }
    } catch {
        fail("\(name): unexpected error \(error)")
    }
}
expectEqual(okCount, 10, "OK vectors")
let allCodes: [FSPError] = [.TOO_LONG, .BAD_BASE64, .BAD_HEADER, .BAD_VERSION, .BAD_ENCODING, .BAD_LENGTH,
                            .INFLATE_FAILED, .LENGTH_MISMATCH, .BAD_CRC, .BAD_LAYOUT, .BAD_MARKS]
expectEqual(seenCodes, Set(allCodes.map { $0.rawValue }), "every rejection code covered")

// MARK: - crc32

expectEqual(FSP.crc32(Array("123456789".utf8)), UInt32(0xCBF4_3926), "crc32 check value")

// MARK: - inflate: zlib's incomplete-code rule (Android decodes with java.util.zip.Inflater = zlib)
// Hand-made raw DEFLATE dynamic blocks (literal 'A' then end of block). zlib accepts an incomplete
// literal or distance code only when it is a single 1-bit code.

func bytesOfHex(_ s: String) -> [UInt8] {
    var out = [UInt8]()
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        out.append(UInt8(s[i..<j], radix: 16) ?? 0)
        i = j
    }
    return out
}

func inflated(_ stream: String, _ expected: Int) -> String {
    do {
        let out = try FSP.inflateRaw(bytesOfHex(stream), expected: expected)
        return "OK:" + hex(out)
    } catch let e as FSPError {
        return e.rawValue
    } catch {
        return "?"
    }
}
expectEqual(inflated("05c081000000008020b6fca55a", 1), "INFLATE_FAILED", "inflate: single 2-bit distance code (zlib: invalid distances set)")
expectEqual(inflated("05c0810000000080207feb03", 1), "INFLATE_FAILED", "inflate: single 2-bit literal code (zlib: invalid literal/lengths set)")
expectEqual(inflated("05c081000000008020b6fca54a", 1), "OK:41", "inflate: single 1-bit distance code is allowed")

// MARK: - WritePlan (PrintWriteLoop.kt semantics)

do {
    var plan = WritePlan(total: 20, marks: [20])
    var covered = 0
    var slices = 0
    while let r = plan.next(max: 7) {
        if r.lowerBound != covered { fail("WritePlan (a): slice \(r) not contiguous at \(covered)") }
        covered = r.upperBound
        slices += 1
    }
    expectEqual(covered, 20, "WritePlan (a) covered")
    expectEqual(slices, 3, "WritePlan (a) slices")
    expectEqual(plan.cancelled, false, "WritePlan (a) not cancelled")
}
do {
    var plan = WritePlan(total: 20, marks: [0, 5, 20])
    plan.requestCancel()
    expectEqual(plan.stopAt, 0, "WritePlan (b) stopAt")
    expectEqual(plan.finished, true, "WritePlan (b) finished")
    expectEqual(plan.next(max: 7) == nil, true, "WritePlan (b) no slice")
}
do {
    var plan = WritePlan(total: 20, marks: [5, 12, 20])
    _ = plan.next(max: 6)
    plan.requestCancel()
    expectEqual(plan.stopAt, 12, "WritePlan (c) stopAt")
    var last = 0
    while let r = plan.next(max: 64) { last = r.upperBound }
    expectEqual(last, 12, "WritePlan (c) stops at mark")
    plan.requestCancel()
    expectEqual(plan.stopAt, 12, "WritePlan (c) second cancel ignored")
}
do {
    var plan = WritePlan(total: 20, marks: [5, 12, 20])
    _ = plan.next(max: 13)
    plan.requestCancel()
    expectEqual(plan.stopAt, 20, "WritePlan (d) stopAt")
}
expectEqual(WritePlan.dose(10), 64, "dose(10)")
expectEqual(WritePlan.dose(9000), 4096, "dose(9000)")
expectEqual(WritePlan.dose(512), 512, "dose(512)")
expectEqual(WritePlan.pause(999), 200, "pause(999)")
expectEqual(WritePlan.pause(-5), 0, "pause(-5)")
expectEqual(WritePlan.grace(9999), 6000, "grace(9999)")
expectEqual(WritePlan.grace(800), 1800, "grace(800)")

// MARK: - caps

func code(_ s: String, _ maxChars: Int) -> String {
    do {
        _ = try FSP.decode(s, maxChars: maxChars)
        return "OK"
    } catch let e as FSPError {
        return e.rawValue
    } catch {
        return "?"
    }
}
// 196 612 'A' (a multiple of 4, so it is valid base64): above the Android cap, under the iOS cap.
let overAndroid = String(repeating: "A", count: 196_612)
expectEqual(code(overAndroid, FSP.maxPayloadChars), "TOO_LONG", "Android cap")
expectEqual(code(overAndroid, FSP.iosMaxPayloadChars), "BAD_HEADER", "iOS cap passes length, fails header")
expectEqual(code(String(repeating: "!", count: FSP.maxPayloadChars + 1), FSP.maxPayloadChars), "TOO_LONG",
            "length checked before characters")
expectEqual(code(String(repeating: "A", count: FSP.iosMaxPayloadChars + 4), FSP.iosMaxPayloadChars), "TOO_LONG",
            "iOS cap enforced")
expectEqual(FSP.iosMaxPayloadChars >= (FSP.iosMaxJobBytes + 200 + FSP.headerBytes + 2) * 4 / 3, true,
            "iOS payload cap fits a full iOS job")
expectEqual(FSP.handlerName, "fsPrint", "handler name")
expectEqual(FSP.bridgeVersion, 1, "bridge version")

if failures > 0 {
    print("✗ fsp-check: \(failures) failure(s)")
    exit(1)
}
print("✓ fsp-check: \(vectors.count) vectors (\(okCount) OK, \(seenCodes.count) rejection codes), crc32, WritePlan, caps")
