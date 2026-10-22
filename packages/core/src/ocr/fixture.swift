import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

// osen-ocr-fixture <png|jpeg|tiff|gif|bmp|heic> [--width W] [--height H] [line ...]: test image generator, writes the encoded image to stdout.

var args = Array(CommandLine.arguments.dropFirst())
func die(_ m: String) -> Never { FileHandle.standardError.write(Data((m + "\n").utf8)); exit(2) }
guard !args.isEmpty else { die("usage: osen-ocr-fixture <format> [--width W] [--height H] [line ...]") }
let format = args.removeFirst()
var width: Int? = nil
var height: Int? = nil
var lines: [String] = []
var i = 0
while i < args.count {
  if args[i] == "--width", i + 1 < args.count, let v = Int(args[i + 1]) { width = v; i += 2 }
  else if args[i] == "--height", i + 1 < args.count, let v = Int(args[i + 1]) { height = v; i += 2 }
  else { lines.append(args[i]); i += 1 }
}
let types: [String: UTType] = ["png": .png, "jpeg": .jpeg, "tiff": .tiff, "gif": .gif, "bmp": .bmp, "heic": .heic]
guard let type = types[format] else { die("unknown format \(format)") }
let w = width ?? 1200
let h = height ?? (160 + 120 * lines.count)
guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { die("canvas") }
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
let font = CTFontCreateWithName("Helvetica" as CFString, 64, nil)
for (n, l) in lines.enumerated() {
  let s = NSAttributedString(string: l, attributes: [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0, green: 0, blue: 0, alpha: 1),
  ])
  ctx.textPosition = CGPoint(x: 40, y: h - 120 - n * 120)
  CTLineDraw(CTLineCreateWithAttributedString(s), ctx)
}
guard let img = ctx.makeImage() else { die("image") }
let out = CFDataCreateMutable(nil, 0)!
guard let dest = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else { die("encoder") }
CGImageDestinationAddImage(dest, img, nil)
guard CGImageDestinationFinalize(dest) else { die("encode") }
FileHandle.standardOutput.write(out as Data)
