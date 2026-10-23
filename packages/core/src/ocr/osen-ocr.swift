import Foundation
import Vision
import ImageIO
import PDFKit

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
      let mode = req["mode"] as? String, mode == "image" || mode == "pdf",
      let ms = (req["ms"] as? NSNumber)?.doubleValue,
      let rssBytes = (req["rssBytes"] as? NSNumber)?.uint64Value
else { fail("bad_request") }

// pdf mode: start of the page being recognized (nanoseconds); 0 while no page is in progress
var pageStartedNs: UInt64 = 0
let pageMs = (req["pageMs"] as? NSNumber)?.doubleValue ?? 0

let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
timer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
timer.setEventHandler {
  if residentBytes() > rssBytes { fail("memory") }
  let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000
  if elapsedMs > ms { fail("timeout") }
  let ps = pageStartedNs
  if mode == "pdf" && ps > 0 && Double(DispatchTime.now().uptimeNanoseconds - ps) / 1_000_000 > pageMs { fail("page_timeout") }
}
timer.resume()

let data = FileHandle.standardInput.readDataToEndOfFile()

func recognize(_ img: CGImage) -> [[String: Any]] {
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
  return lines
}

if mode == "pdf" {
  guard let numbers = (req["pages"] as? [NSNumber])?.map({ $0.intValue }),
        let doc = PDFDocument(data: data)
  else { fail("damaged") }
  // only a password to open blocks reading: an owner password (permissions only) still lets pages render
  if doc.isLocked { fail("encrypted") }
  var pages: [[String: Any]] = []
  for n in numbers {
    guard n >= 1, n <= doc.pageCount, let page = doc.page(at: n - 1) else { fail("damaged") }
    pageStartedNs = DispatchTime.now().uptimeNanoseconds
    let box = page.bounds(for: .mediaBox)
    var scale = 2.0
    let side = Double(max(box.width, box.height)) * scale
    if side > 4096 { scale *= 4096 / side }
    let w = max(1, Int((Double(box.width) * scale).rounded())), h = max(1, Int((Double(box.height) * scale).rounded()))
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { fail("damaged") }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.scaleBy(x: CGFloat(w) / box.width, y: CGFloat(h) / box.height)
    ctx.translateBy(x: -box.origin.x, y: -box.origin.y)
    page.draw(with: .mediaBox, to: ctx)
    guard let img = ctx.makeImage() else { fail("damaged") }
    pages.append(["n": n, "lines": recognize(img)])
    pageStartedNs = 0
  }
  reply(["ok": true, "pages": pages])
}

guard let src = CGImageSourceCreateWithData(data as CFData, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
else { fail("damaged") }

let lines = recognize(img)
if lines.isEmpty { fail("no_text") }
reply(["ok": true, "lines": lines])
