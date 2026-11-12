import Foundation

/// 一段可带格式的文字，以及按字符偏移标出的高亮和强调。
/// 偏移以 Character 计，和主题无关，渲染时才决定颜色。
struct Inline: Hashable {
    var text: AttributedString
    /// 关键句：渲染成荧光笔底色。
    var highlights: [Range<Int>] = []
    /// 关键信息（时间、金额等）：渲染成强调色加粗。
    var emphases: [Range<Int>] = []

    init(_ text: AttributedString, highlights: [Range<Int>] = [], emphases: [Range<Int>] = []) {
        self.text = text
        self.highlights = highlights
        self.emphases = emphases
    }

    init(plain: String) {
        self.init(AttributedString(plain))
    }

    var plain: String { String(text.characters) }
    var count: Int { text.characters.count }

    func index(_ offset: Int) -> AttributedString.Index {
        text.characters.index(text.startIndex, offsetBy: offset)
    }

    /// 取出一段（按字符偏移），去掉首尾空白，并平移高亮范围。原文字符不做任何改动。
    func slice(_ range: Range<Int>) -> Inline? {
        let chars = Array(text.characters)
        var lo = max(0, range.lowerBound)
        var hi = min(chars.count, range.upperBound)
        while lo < hi, chars[lo].isWhitespace { lo += 1 }
        while hi > lo, chars[hi - 1].isWhitespace { hi -= 1 }
        guard lo < hi else { return nil }
        let sub = AttributedString(text[index(lo)..<index(hi)])
        func shift(_ rs: [Range<Int>]) -> [Range<Int>] {
            rs.compactMap { r in
                let a = max(r.lowerBound, lo), b = min(r.upperBound, hi)
                return a < b ? (a - lo)..<(b - lo) : nil
            }
        }
        return Inline(sub, highlights: shift(highlights), emphases: shift(emphases))
    }
}

enum Block: Hashable {
    case heading(String)
    case paragraph(Inline)
    case listItem(marker: String, Inline, level: Int)
    case quote(Inline)
    case code(String)
    case table([[String]])

    var inline: Inline? {
        switch self {
        case .paragraph(let i), .listItem(_, let i, _), .quote(let i): return i
        default: return nil
        }
    }

    func replacingInline(_ new: Inline) -> Block {
        switch self {
        case .paragraph: return .paragraph(new)
        case .listItem(let m, _, let l): return .listItem(marker: m, new, level: l)
        case .quote: return .quote(new)
        default: return self
        }
    }

    var plainText: String {
        switch self {
        case .heading(let s), .code(let s): return s
        case .table(let rows): return rows.map { $0.joined(separator: " ") }.joined(separator: "\n")
        default: return inline?.plain ?? ""
        }
    }
}

/// 篇幅：原文（只整理结构）/ 精简 / 要点。
enum Length: String, CaseIterable, Identifiable, Codable {
    case original, concise, points
    var id: String { rawValue }
    var title: String {
        switch self {
        case .original: return "原文"
        case .concise: return "精简"
        case .points: return "要点"
        }
    }
}

struct ReadableDocument: Hashable {
    /// 顶部"一句话要点"。
    var summary: String?
    var blocks: [Block]
    /// 例如"AI 精简版 · 原文 1,234 字"。
    var badge: String?
    /// 精简时可附上的原文。
    var appendix: [Block] = []
}

/// 输入来源：粘贴的纯文字、网页 HTML、或带格式的富文本。
enum SourceInput {
    case text(String)
    case html(String)
    case attributed(NSAttributedString)
}

enum TextTools {
    private static let enders: Set<Character> = ["。", "！", "？", "!", "?", "；", ";", "…"]
    private static let closers: Set<Character> = ["”", "’", "」", "』", "）", ")", "\"", "'", "】", "…"]

    /// 按句子切分，返回每句的字符偏移。所有句子拼起来等于原文，一个字都不丢。
    static func sentenceRanges(_ s: String) -> [Range<Int>] {
        let chars = Array(s)
        var result: [Range<Int>] = []
        var start = 0
        var i = 0
        while i < chars.count {
            let c = chars[i]
            var isEnd = enders.contains(c)
            if c == "." { isEnd = i + 1 == chars.count || chars[i + 1] == " " }
            if isEnd {
                var j = i + 1
                while j < chars.count, enders.contains(chars[j]) || closers.contains(chars[j]) { j += 1 }
                while j < chars.count, chars[j] == " " { j += 1 }
                result.append(start..<j)
                start = j
                i = j
                continue
            }
            i += 1
        }
        if start < chars.count {
            let tail = String(chars[start...])
            if tail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let last = result.popLast() {
                result.append(last.lowerBound..<chars.count)
            } else {
                result.append(start..<chars.count)
            }
        }
        return result
    }

    static func charRanges(of regex: NSRegularExpression, in s: String) -> [Range<Int>] {
        regex.matches(in: s, range: NSRange(s.startIndex..., in: s)).compactMap { m in
            guard let r = Range(m.range, in: s) else { return nil }
            let lo = s.distance(from: s.startIndex, to: r.lowerBound)
            return lo..<(lo + s[r].count)
        }
    }

    /// 时间、日期、金额等关键信息。
    static let keyInfo = try! NSRegularExpression(pattern: [
        #"(\d{4}年)?\d{1,2}月\d{1,2}[日号]([（(]?(周|星期)[一二三四五六日天][）)]?)?"#,
        #"(下周|本周|这周|下个周|周|星期)[一二三四五六日天](上午|下午|晚上|早上|中午)?"#,
        #"(上午|下午|晚上|早上|中午|凌晨|傍晚)?\d{1,2}[:：]\d{2}"#,
        #"(上午|下午|晚上|早上|中午|凌晨|傍晚)\d{1,2}点(半|\d{1,2}分)?"#,
        #"\d{1,2}点(半|\d{1,2}分)?(之前|以前|前|以后|后)"#,
        #"[¥￥]\s?\d+(\.\d+)?"#,
        #"\d+(\.\d+)?\s?(元|块钱)"#,
    ].joined(separator: "|"))

    /// 没有 AI 时，含这些词的句子会被标成关键句。
    static let keyWords = ["务必", "一定要", "千万", "请勿", "不要忘", "别忘", "截止", "注意", "必须"]
}
