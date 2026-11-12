import Foundation

/// AI 或本地规则给出的"排版方案"。只引用句子编号，不带改写后的文字，
/// 所以原文模式下正文一个字都不会被改。
struct StructurePlan: Equatable {
    var summary: String?
    var headings: [Int: String] = [:]
    var paragraphStarts: Set<Int> = []
    var keySentences: Set<Int> = []

    func merged(with other: StructurePlan) -> StructurePlan {
        StructurePlan(
            summary: other.summary ?? summary,
            headings: headings.merging(other.headings) { _, new in new },
            paragraphStarts: paragraphStarts.union(other.paragraphStarts),
            keySentences: keySentences.union(other.keySentences)
        )
    }
}

/// AI 缩写的结果。
struct Shortened: Equatable {
    var summary: String?
    var text: String
}

enum Structurer {
    /// 每个正文块里的句子，按全文顺序编号。
    static func sentences(_ blocks: [Block]) -> [String] {
        blocks.flatMap { block -> [String] in
            guard let inline = block.inline else { return [] }
            let chars = Array(inline.plain)
            return TextTools.sentenceRanges(inline.plain).map { String(chars[$0]).trimmingCharacters(in: .whitespaces) }
        }
    }

    /// 没有 AI 时的规则：太长的段落按句子拆成 2～3 句一段；含「务必、截止」等词的句子标为关键句。
    static func localPlan(_ blocks: [Block]) -> StructurePlan {
        var plan = StructurePlan()
        var id = 0
        for block in blocks {
            guard let inline = block.inline else { continue }
            let plain = inline.plain
            let chars = Array(plain)
            let ranges = TextTools.sentenceRanges(plain)
            var run = 0
            for (k, r) in ranges.enumerated() {
                let sentence = String(chars[r])
                if TextTools.keyWords.contains(where: sentence.contains) { plan.keySentences.insert(id + k) }
                if case .paragraph = block, k > 0, run >= 60, chars.count - r.lowerBound >= 30 {
                    plan.paragraphStarts.insert(id + k)
                    run = 0
                }
                run += r.count
            }
            id += ranges.count
        }
        return plan
    }

    /// 按方案拆段、加小标题、标关键句，并标出时间金额等关键信息。
    static func apply(_ plan: StructurePlan, to blocks: [Block]) -> [Block] {
        var out: [Block] = []
        var id = 0
        for block in blocks {
            guard var inline = block.inline else { out.append(block); continue }
            let chars = Array(inline.plain)
            let ranges = TextTools.sentenceRanges(inline.plain)
            var cuts = [0]
            var titles: [Int: String] = [:]
            let splittable: Bool
            if case .paragraph = block { splittable = true } else { splittable = false }
            for (k, r) in ranges.enumerated() {
                let sid = id + k
                if plan.keySentences.contains(sid) {
                    var hi = r.upperBound
                    while hi > r.lowerBound, chars[hi - 1].isWhitespace { hi -= 1 }
                    inline.highlights.append(r.lowerBound..<hi)
                }
                let title = plan.headings[sid]
                if k > 0, splittable, title != nil || plan.paragraphStarts.contains(sid) {
                    cuts.append(r.lowerBound)
                }
                // 小标题只加在正文段落前，不插进列表和引用中间。
                if let title, splittable { titles[k == 0 ? 0 : r.lowerBound] = title }
            }
            id += ranges.count
            cuts.append(chars.count)
            for j in 0..<(cuts.count - 1) {
                // 原文已有标题的地方不再叠一个 AI 小标题。
                if let t = titles[cuts[j]] {
                    if case .heading? = out.last {} else { out.append(.heading(t)) }
                }
                if let piece = inline.slice(cuts[j]..<cuts[j + 1]) { out.append(block.replacingInline(piece)) }
            }
        }
        return emphasizeKeyInfo(out)
    }

    static func emphasizeKeyInfo(_ blocks: [Block]) -> [Block] {
        blocks.map { block in
            guard var inline = block.inline else { return block }
            inline.emphases = TextTools.charRanges(of: TextTools.keyInfo, in: inline.plain)
            return block.replacingInline(inline)
        }
    }

    static func charCount(_ blocks: [Block]) -> Int {
        blocks.reduce(0) { $0 + $1.plainText.filter { !$0.isWhitespace }.count }
    }

    /// 给 AI 的编号原文，超过 limit 个字的部分不发（本地规则仍会处理）。
    static func numberedPrompt(_ blocks: [Block], limit: Int) -> String {
        var lines: [String] = []
        var used = 0
        for (i, s) in sentences(blocks).enumerated() {
            used += s.count
            if used > limit, !lines.isEmpty { break }
            lines.append("[\(i)] \(s)")
        }
        return lines.joined(separator: "\n")
    }

    /// 生成要发出去的文档。原文模式不改字；精简和要点模式需要 AI。
    static func build(source: [Block], length: Length, ai: AIProvider?, attachOriginal: Bool) async throws -> ReadableDocument {
        let local = localPlan(source)
        if length == .original {
            var plan = local
            if let ai {
                var aiPlan = try await ai.plan(for: source)
                // 小模型常把称呼、整段都标成重点；只留最多 3 句像样的句子。
                let s = sentences(source)
                aiPlan.keySentences = Set(aiPlan.keySentences.filter { $0 < s.count && s[$0].count >= 10 }.sorted().prefix(3))
                plan = local.merged(with: aiPlan)
            }
            return ReadableDocument(summary: plan.summary, blocks: apply(plan, to: source))
        }
        guard let ai else { throw AIError.unavailable }
        let text = source.map(\.plainText).joined(separator: "\n")
        let short = try await ai.shorten(text, to: length)
        let blocks = PlainImporter.blocks(short.text)
        let original = charCount(source)
        let after = charCount(blocks)
        return ReadableDocument(
            summary: short.summary,
            blocks: apply(localPlan(blocks), to: blocks),
            badge: "AI \(length.title)版 · 原文 \(original) 字 → \(after) 字",
            appendix: attachOriginal ? apply(local, to: source) : []
        )
    }
}
