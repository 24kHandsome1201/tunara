import Foundation
import UIKit

/// 把各种来源的文字变成 Block，保留原有的标题、列表、引用、表格和粗体。
enum Importer {
    static func blocks(from input: SourceInput) -> [Block] {
        switch input {
        case .text(let s): return PlainImporter.blocks(s)
        case .html(let h): return HTMLImporter.blocks(h)
        case .attributed(let a): return RichImporter.blocks(a)
        }
    }
}

private func regex(_ pattern: String) -> NSRegularExpression {
    try! NSRegularExpression(pattern: pattern)
}

private extension String {
    func match(_ re: NSRegularExpression) -> NSTextCheckingResult? {
        re.firstMatch(in: self, range: NSRange(startIndex..., in: self))
    }
    func group(_ m: NSTextCheckingResult, _ i: Int) -> String? {
        guard let r = Range(m.range(at: i), in: self) else { return nil }
        return String(self[r])
    }
}

// MARK: - 纯文字（也认 Markdown：AI 回答复制过来时常见）

enum PlainImporter {
    private static let mdHeading = regex(#"^#{1,6}\s+(.+)$"#)
    private static let cnHeading = regex(#"^([一二三四五六七八九十]+[、.．]|第[一二三四五六七八九十\d]+[章节部分条点]).{0,28}$"#)
    private static let bracketHeading = regex(#"^【([^】]{1,20})】$"#)
    private static let colonHeading = regex(#"^([^。！？!?，,；;]{1,16})[：:]$"#)
    private static let listItem = regex(#"^(\s*)([-*+]\s+|[•·●▪◦]\s*|\d{1,2}(?:[、)）]|\.(?!\d))\s*|[（(]\d{1,2}[)）]\s*|[①-⑳]\s*)(.+)$"#)

    static func blocks(_ text: String) -> [Block] {
        let lines = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
        var out: [Block] = []
        var i = 0
        while i < lines.count {
            let raw = lines[i]
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { i += 1; continue }

            if line.hasPrefix("```") {
                var code: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    code.append(lines[i]); i += 1
                }
                i += 1
                out.append(.code(code.joined(separator: "\n")))
                continue
            }
            if line.hasPrefix("|") {
                var rows: [[String]] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    let cells = l.trimmingCharacters(in: CharacterSet(charactersIn: "|"))
                        .components(separatedBy: "|")
                        .map { $0.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "**", with: "") }
                    let isRule = cells.allSatisfy { $0.allSatisfy { "-: ".contains($0) } }
                    if !isRule { rows.append(cells) }
                    i += 1
                }
                out.append(.table(rows))
                continue
            }
            if let h = heading(line, isFirst: out.isEmpty) {
                out.append(.heading(h)); i += 1; continue
            }
            if let m = raw.match(listItem), let lead = raw.group(m, 1), let marker = raw.group(m, 2), let rest = raw.group(m, 3) {
                out.append(.listItem(marker: normalize(marker), inline(rest), level: min(2, lead.count / 2)))
                i += 1; continue
            }
            if line.hasPrefix(">") {
                out.append(.quote(inline(String(line.dropFirst()).trimmingCharacters(in: .whitespaces))))
                i += 1; continue
            }
            out.append(.paragraph(inline(line)))
            i += 1
        }
        return out
    }

    static func heading(_ line: String, isFirst: Bool) -> String? {
        if let m = line.match(mdHeading) { return line.group(m, 1)?.replacingOccurrences(of: "**", with: "") }
        if let m = line.match(bracketHeading) { return line.group(m, 1) }
        if line.match(cnHeading) != nil, !line.hasSuffix("。") { return line }
        // "各位家长："这样的称呼不当成标题。
        if !isFirst, let m = line.match(colonHeading) { return line.group(m, 1) }
        return nil
    }

    /// 列表符号统一成 • 或 1.；（1）①这类保留原样。
    static func normalize(_ marker: String) -> String {
        let m = marker.trimmingCharacters(in: .whitespaces)
        if m.count == 1, "-*+•·●▪◦".contains(m) { return "•" }
        let digits = m.filter { $0.isASCII && $0.isNumber }
        if !digits.isEmpty, !m.hasPrefix("("), !m.hasPrefix("（") { return digits + "." }
        return m
    }

    /// 支持 **粗体**，其余字符原样保留。
    static func inline(_ s: String) -> Inline {
        guard s.contains("**") else { return Inline(plain: s) }
        var result = AttributedString()
        var bold = false
        var rest = Substring(s)
        while let r = rest.range(of: "**") {
            var seg = AttributedString(String(rest[..<r.lowerBound]))
            if bold { seg.inlinePresentationIntent = .stronglyEmphasized }
            result += seg
            bold.toggle()
            rest = rest[r.upperBound...]
        }
        result += AttributedString(String(rest))
        return Inline(result)
    }
}

// MARK: - 网页 HTML（Safari、公众号、飞书网页选区）

enum HTMLImporter {
    static func blocks(_ html: String) -> [Block] {
        var p = Parser()
        p.run(html)
        return p.out
    }

    private static let rawText: Set<String> = ["script", "style", "noscript", "template", "title", "textarea"]
    private static let skipped: Set<String> = ["svg", "head", "nav", "footer", "form", "button", "iframe", "select", "canvas", "video", "audio"]
    private static let blockTags: Set<String> = ["p", "div", "section", "article", "header", "main", "aside", "figure", "figcaption",
                                                 "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "blockquote", "pre",
                                                 "br", "hr", "tr", "table", "dd", "dt", "dl"]

    private struct Parser {
        var out: [Block] = []
        var cur = AttributedString()
        var marks: [Range<Int>] = []
        var markStart: Int?
        var bold = 0, italic = 0, code = 0
        var spans: [Bool] = []
        var skip: [String] = []
        var pre = 0, heading = 0, quote = 0
        var lists: [(ordered: Bool, n: Int)] = []
        var liMarker: String?
        var table: [[String]]?
        var row: [String]?
        var cell: String?

        mutating func run(_ html: String) {
            var i = html.startIndex
            while i < html.endIndex {
                if html[i] == "<" {
                    if html[i...].hasPrefix("<!--") {
                        guard let e = html.range(of: "-->", range: i..<html.endIndex) else { break }
                        i = e.upperBound
                        continue
                    }
                    guard let close = html[i...].firstIndex(of: ">") else { break }
                    let (name, closing) = tag(String(html[html.index(after: i)..<close]))
                    i = html.index(after: close)
                    if !closing, rawText.contains(name) {
                        guard let end = html.range(of: "</\(name)", options: .caseInsensitive, range: i..<html.endIndex),
                              let gt = html[end.upperBound...].firstIndex(of: ">") else { break }
                        i = html.index(after: gt)
                    }
                } else {
                    let next = html[i...].firstIndex(of: "<") ?? html.endIndex
                    text(String(html[i..<next]))
                    i = next
                }
            }
            flush()
            if let t = table, !t.isEmpty { out.append(.table(t)) }
        }

        mutating func tag(_ raw: String) -> (String, Bool) {
            var t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.hasPrefix("!") || t.hasPrefix("?") { return ("", false) }
            let closing = t.hasPrefix("/")
            if closing { t.removeFirst() }
            let name = String(t.prefix { $0.isLetter || $0.isNumber }).lowercased()
            let selfClosing = t.hasSuffix("/")

            if skipped.contains(name) {
                if closing { if skip.last == name { skip.removeLast() } } else if !selfClosing { skip.append(name) }
                return (name, closing)
            }
            if !skip.isEmpty { return (name, closing) }

            if blockTags.contains(name), !(closing && name == "br") { flush() }
            switch name {
            case "h1", "h2", "h3", "h4", "h5", "h6": heading = closing ? 0 : 1
            case "blockquote": quote += closing ? -1 : 1
            case "pre": pre += closing ? -1 : 1
            case "ul", "ol":
                if closing { _ = lists.popLast() } else { lists.append((name == "ol", 0)) }
            case "li":
                if closing { liMarker = nil } else if !lists.isEmpty {
                    lists[lists.count - 1].n += 1
                    liMarker = lists[lists.count - 1].ordered ? "\(lists[lists.count - 1].n)." : "•"
                } else {
                    liMarker = "•"
                }
            case "b", "strong": bold += closing ? -1 : 1
            case "i", "em": italic += closing ? -1 : 1
            case "code": if pre == 0 { code += closing ? -1 : 1 }
            case "mark":
                if closing, let s = markStart { marks.append(s..<cur.characters.count); markStart = nil }
                if !closing { markStart = cur.characters.count }
            case "span":
                if closing {
                    if spans.popLast() == true { bold -= 1 }
                } else if !selfClosing {
                    let lower = t.lowercased().replacingOccurrences(of: " ", with: "")
                    let isBold = lower.contains("font-weight:bold") || lower.contains("font-weight:700") || lower.contains("font-weight:600")
                    spans.append(isBold)
                    if isBold { bold += 1 }
                }
            case "table":
                if closing { if let t = table, !t.isEmpty { out.append(.table(t)) }; table = nil } else { table = [] }
            case "tr":
                if closing { if let r = row, !r.isEmpty { table?.append(r) }; row = nil } else { row = [] }
            case "td", "th":
                if closing { row?.append((cell ?? "").trimmingCharacters(in: .whitespaces)); cell = nil } else { cell = "" }
            default: break
            }
            bold = max(0, bold); italic = max(0, italic); code = max(0, code)
            quote = max(0, quote); pre = max(0, pre)
            return (name, closing)
        }

        mutating func text(_ raw: String) {
            guard skip.isEmpty else { return }
            let decoded = decodeEntities(raw)
            if cell != nil {
                cell! += collapse(decoded)
                return
            }
            var s = pre > 0 ? decoded : collapse(decoded)
            if s.isEmpty { return }
            if pre == 0, s.first == " ", cur.characters.last == " " || cur.characters.isEmpty { s.removeFirst() }
            if s.isEmpty { return }
            var seg = AttributedString(s)
            var intent: InlinePresentationIntent = []
            if bold > 0 { intent.insert(.stronglyEmphasized) }
            if italic > 0 { intent.insert(.emphasized) }
            if code > 0 { intent.insert(.code) }
            if !intent.isEmpty { seg.inlinePresentationIntent = intent }
            cur += seg
        }

        mutating func flush() {
            if let s = markStart { marks.append(s..<cur.characters.count); markStart = 0 }
            let inline = Inline(cur, highlights: marks).slice(0..<cur.characters.count)
            cur = AttributedString()
            marks = []
            guard let inline else { return }
            if pre > 0 {
                out.append(.code(inline.plain))
            } else if heading > 0 {
                out.append(.heading(inline.plain))
            } else if let m = liMarker {
                out.append(.listItem(marker: m, inline, level: max(0, lists.count - 1)))
            } else if quote > 0 {
                out.append(.quote(inline))
            } else {
                out.append(.paragraph(inline))
            }
        }
    }

    static func collapse(_ s: String) -> String {
        var r = ""
        var lastSpace = false
        for c in s {
            if c.isWhitespace {
                if !lastSpace { r.append(" ") }
                lastSpace = true
            } else {
                r.append(c)
                lastSpace = false
            }
        }
        return r
    }

    static func decodeEntities(_ s: String) -> String {
        guard s.contains("&") else { return s }
        var out = ""
        var i = s.startIndex
        while i < s.endIndex {
            if s[i] == "&", let semi = s[i...].prefix(12).firstIndex(of: ";"),
               let rep = entity(String(s[s.index(after: i)..<semi])) {
                out += rep
                i = s.index(after: semi)
                continue
            }
            out.append(s[i])
            i = s.index(after: i)
        }
        return out
    }

    private static func entity(_ n: String) -> String? {
        switch n {
        case "amp": return "&"
        case "lt": return "<"
        case "gt": return ">"
        case "quot": return "\""
        case "apos": return "'"
        case "nbsp", "ensp", "emsp": return " "
        case "ldquo": return "“"
        case "rdquo": return "”"
        case "lsquo": return "‘"
        case "rsquo": return "’"
        case "hellip": return "…"
        case "mdash": return "—"
        case "ndash": return "–"
        case "middot": return "·"
        case "yen": return "¥"
        default:
            var code: UInt32?
            if n.hasPrefix("#x") || n.hasPrefix("#X") { code = UInt32(n.dropFirst(2), radix: 16) }
            else if n.hasPrefix("#") { code = UInt32(n.dropFirst()) }
            guard let code, let scalar = Unicode.Scalar(code) else { return nil }
            return String(Character(scalar))
        }
    }
}

// MARK: - 富文本（备忘录、邮件、其他 App 分享出来的 RTF）

enum RichImporter {
    static func blocks(_ a: NSAttributedString) -> [Block] {
        let ns = a.string as NSString
        var ranges: [NSRange] = []
        ns.enumerateSubstrings(in: NSRange(location: 0, length: ns.length), options: [.byParagraphs, .substringNotRequired]) { _, r, _, _ in
            ranges.append(r)
        }
        let body = bodySize(a)
        var out: [Block] = []
        for r in ranges where r.length > 0 {
            let sub = a.attributedSubstring(from: r)
            let plain = sub.string.trimmingCharacters(in: .whitespaces)
            if plain.isEmpty { continue }
            let inline = convert(sub)
            var allBold = true
            var maxSize: CGFloat = 0
            sub.enumerateAttribute(.font, in: NSRange(location: 0, length: sub.length)) { v, _, _ in
                let f = v as? UIFont
                if f?.fontDescriptor.symbolicTraits.contains(.traitBold) != true { allBold = false }
                maxSize = max(maxSize, f?.pointSize ?? 0)
            }
            if plain.count <= 40, (maxSize >= body * 1.15 || (allBold && plain.count <= 20)), !plain.hasSuffix("。") {
                out.append(.heading(plain))
                continue
            }
            // 列表符号可能写在文字里，也可能只在段落样式里。
            let plainBlocks = PlainImporter.blocks(sub.string)
            if case .listItem(let marker, let item, let level)? = plainBlocks.first, plainBlocks.count == 1 {
                let offset = inline.count - item.count
                out.append(.listItem(marker: marker, inline.slice(offset..<inline.count) ?? item, level: level))
            } else if let style = sub.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle, !style.textLists.isEmpty {
                out.append(.listItem(marker: "•", inline, level: style.textLists.count - 1))
            } else {
                out.append(.paragraph(inline))
            }
        }
        return out
    }

    private static func bodySize(_ a: NSAttributedString) -> CGFloat {
        var weights: [CGFloat: Int] = [:]
        a.enumerateAttribute(.font, in: NSRange(location: 0, length: a.length)) { v, r, _ in
            if let f = v as? UIFont { weights[f.pointSize, default: 0] += r.length }
        }
        return weights.max { $0.value < $1.value }?.key ?? 17
    }

    private static func convert(_ a: NSAttributedString) -> Inline {
        var result = AttributedString()
        a.enumerateAttributes(in: NSRange(location: 0, length: a.length)) { attrs, r, _ in
            var seg = AttributedString(a.attributedSubstring(from: r).string)
            if let f = attrs[.font] as? UIFont {
                var intent: InlinePresentationIntent = []
                if f.fontDescriptor.symbolicTraits.contains(.traitBold) { intent.insert(.stronglyEmphasized) }
                if f.fontDescriptor.symbolicTraits.contains(.traitItalic) { intent.insert(.emphasized) }
                if !intent.isEmpty { seg.inlinePresentationIntent = intent }
            }
            result += seg
        }
        return Inline(result)
    }
}
