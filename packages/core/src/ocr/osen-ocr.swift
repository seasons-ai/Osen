import Foundation
import Vision
import ImageIO

// osen-ocr: reads image bytes from stdin, prints exactly one JSON line. Protocol version 1.

let protocolVersion = 1
let startedAt = DispatchTime.now()
let replyLock = NSLock()
var replied = false

func reply(_ obj: [String: Any]) -> Never {
  replyLock.lock()
  if !replied {
    replied = true
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{\"ok\":false,\"code\":\"vision\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
  replyLock.unlock()
  exit(0)
}

func fail(_ code: String) -> Never { reply(["ok": false, "code": code]) }

func residentBytes() -> UInt64 {
  var info = mach_task_basic_info()
  var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
  let kr = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
    }
  }
  return kr == KERN_SUCCESS ? UInt64(info.resident_size) : 0
}

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "--version" {
  print("osen-ocr \(protocolVersion)")
  exit(0)
}

guard args.count >= 2,
      let req = (try? JSONSerialization.jsonObject(with: Data(args[1].utf8))) as? [String: Any],
      req["mode"] as? String == "image",
      let ms = (req["ms"] as? NSNumber)?.doubleValue,
      let rssBytes = (req["rssBytes"] as? NSNumber)?.uint64Value
else { fail("bad_request") }

let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
timer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
timer.setEventHandler {
  if residentBytes() > rssBytes { fail("memory") }
  let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000
  if elapsedMs > ms { fail("timeout") }
}
timer.resume()

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let src = CGImageSourceCreateWithData(data as CFData, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
else { fail("damaged") }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["ru-RU", "en-US"]
request.usesLanguageCorrection = true
do { try VNImageRequestHandler(cgImage: img, options: [:]).perform([request]) } catch { fail("vision") }

var lines: [[String: Any]] = []
for o in request.results ?? [] {
  guard let t = o.topCandidates(1).first?.string, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
  let bb = o.boundingBox
  lines.append(["t": t, "x": Double(bb.origin.x), "y": Double(1 - (bb.origin.y + bb.height)), "w": Double(bb.width), "h": Double(bb.height)])
}
if lines.isEmpty { fail("no_text") }
reply(["ok": true, "lines": lines])
