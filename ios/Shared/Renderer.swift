import SwiftUI
import UIKit

/// 把文档画成发微信用的图片。
///
/// 每张图 1080 像素宽（360pt × 3）。微信不勾"原图"时，宽高比大于 2 的长图会保留宽度，
/// 所以单张最高 4320 像素（1:4），更长的内容平均拆成几张，每张都清楚。
enum PageRenderer {
    static let width: CGFloat = 360
    static let scale: CGFloat = 3
    static let maxPageHeight: CGFloat = 1440

    @MainActor
    static func render(_ doc: ReadableDocument, theme: Theme, size: TextSize, split: Bool) -> [UIImage] {
        let style = BlockStyle(theme: theme, size: size.points)
        var pieces: [(image: UIImage, keepWithNext: Bool)] = []
        func add<V: View>(_ view: V, keepWithNext: Bool = false) {
            if let img = snapshot(view, theme: theme) { pieces.append((img, keepWithNext)) }
        }

        if doc.summary != nil || doc.badge != nil { add(HeaderView(doc: doc, style: style)) }
        for block in doc.blocks {
            if case .heading = block { add(BlockView(block: block, style: style), keepWithNext: true) } else { add(BlockView(block: block, style: style)) }
        }
        if !doc.appendix.isEmpty {
            add(DividerLabel(text: "以下是原文", style: style), keepWithNext: true)
            for block in doc.appendix { add(BlockView(block: block, style: style, muted: true)) }
        }

        let total = pieces.reduce(0) { $0 + $1.image.size.height }
        let count = split ? max(1, Int((total / maxPageHeight).rounded(.up))) : 1
        let target = total / CGFloat(count)

        var pages: [[UIImage]] = [[]]
        var height: CGFloat = 0
        for (i, piece) in pieces.enumerated() {
            let h = piece.image.size.height
            let pagesLeft = count - pages.count
            if split, !pages[pages.count - 1].isEmpty, pagesLeft > 0, height + h > maxPageHeight || height + h / 2 > target {
                pages.append([])
                height = 0
            }
            pages[pages.count - 1].append(piece.image)
            height += h
            // 小标题不单独留在一页末尾。
            if piece.keepWithNext, i + 1 < pieces.count, split, pagesLeft > 0, height + pieces[i + 1].image.size.height / 2 > target {
                pages[pages.count - 1].removeLast()
                pages.append([piece.image])
                height = h
            }
        }

        return pages.enumerated().map { index, images in
            let footer = snapshot(FooterView(index: index, count: pages.count, style: style), theme: theme)
            return stitch(images + [footer].compactMap { $0 }, theme: theme)
        }
    }

    @MainActor
    private static func snapshot<V: View>(_ view: V, theme: Theme) -> UIImage? {
        let renderer = ImageRenderer(content: view
            .frame(width: width, alignment: .leading)
            .background(theme.background)
            .environment(\.colorScheme, .light))
        renderer.scale = scale
        renderer.proposedSize = ProposedViewSize(width: width, height: nil)
        return renderer.uiImage
    }

    private static func stitch(_ images: [UIImage], theme: Theme) -> UIImage {
        let top: CGFloat = 28
        let height = top + images.reduce(0) { $0 + $1.size.height }
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { ctx in
            UIColor(theme.background).setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
            var y = top
            for img in images {
                img.draw(at: CGPoint(x: 0, y: y))
                y += img.size.height
            }
        }
    }
}

struct BlockStyle {
    let theme: Theme
    let size: CGFloat
    var lineSpacing: CGFloat { size * 0.55 }
    let margin: CGFloat = 24

    func styled(_ inline: Inline, muted: Bool = false) -> AttributedString {
        var a = inline.text
        func range(_ r: Range<Int>) -> Range<AttributedString.Index> {
            a.characters.index(a.startIndex, offsetBy: r.lowerBound)..<a.characters.index(a.startIndex, offsetBy: r.upperBound)
        }
        let runs = a.runs.compactMap { run -> (Range<Int>, InlinePresentationIntent)? in
            guard let intent = run.inlinePresentationIntent else { return nil }
            let lo = a.characters.distance(from: a.startIndex, to: run.range.lowerBound)
            return (lo..<(lo + a[run.range].characters.count), intent)
        }
        for (r, intent) in runs {
            var font = Font.system(size: size, weight: intent.contains(.stronglyEmphasized) ? .bold : .regular)
            if intent.contains(.code) { font = .system(size: size * 0.9, design: .monospaced) }
            if intent.contains(.emphasized) { font = font.italic() }
            a[range(r)].font = font
        }
        for r in inline.highlights where r.upperBound <= a.characters.count {
            a[range(r)].backgroundColor = theme.highlight
        }
        for r in inline.emphases where r.upperBound <= a.characters.count {
            a[range(r)].foregroundColor = theme.accent
            a[range(r)].font = .system(size: size, weight: .bold)
        }
        if muted { a.foregroundColor = theme.secondary }
        return a
    }
}

private struct BlockView: View {
    let block: Block
    let style: BlockStyle
    var muted = false

    var body: some View {
        content
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, style.margin)
    }

    @ViewBuilder private var content: some View {
        let t = style.theme
        switch block {
        case .heading(let title):
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 2).fill(t.accent).frame(width: 4, height: style.size * 1.15)
                Text(title).font(.system(size: style.size * 1.2, weight: .bold)).foregroundStyle(muted ? t.secondary : t.text)
            }
            .padding(.top, style.size * 0.9)
            .padding(.bottom, style.size * 0.6)
        case .paragraph(let inline):
            paragraph(inline)
                .padding(.bottom, style.size * 0.95)
        case .listItem(let marker, let inline, let level):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(marker).font(.system(size: style.size, weight: .bold)).foregroundStyle(t.accent)
                    .frame(minWidth: style.size * 0.9, alignment: .leading)
                paragraph(inline)
            }
            .padding(.leading, CGFloat(level) * style.size * 1.2)
            .padding(.bottom, style.size * 0.55)
        case .quote(let inline):
            HStack(spacing: 12) {
                Rectangle().fill(t.secondary.opacity(0.4)).frame(width: 3)
                Text(style.styled(inline, muted: true)).font(.system(size: style.size)).foregroundStyle(t.secondary).lineSpacing(style.lineSpacing)
            }
            .padding(.bottom, style.size * 0.95)
        case .code(let code):
            Text(code).font(.system(size: style.size * 0.78, design: .monospaced)).foregroundStyle(t.text)
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(t.card, in: RoundedRectangle(cornerRadius: 8))
                .padding(.bottom, style.size * 0.95)
        case .table(let rows):
            TableView(rows: rows, style: style).padding(.bottom, style.size * 0.95)
        }
    }

    private func paragraph(_ inline: Inline) -> some View {
        Text(style.styled(inline, muted: muted))
            .font(.system(size: style.size))
            .foregroundStyle(muted ? style.theme.secondary : style.theme.text)
            .lineSpacing(style.lineSpacing)
    }
}

private struct TableView: View {
    let rows: [[String]]
    let style: BlockStyle

    var body: some View {
        let columns = rows.map(\.count).max() ?? 0
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                GridRow {
                    ForEach(0..<columns, id: \.self) { j in
                        Text(j < row.count ? row[j] : "")
                            .font(.system(size: style.size * 0.85, weight: i == 0 ? .bold : .regular))
                            .foregroundStyle(style.theme.text)
                            .padding(.horizontal, 8).padding(.vertical, 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(i == 0 ? style.theme.card : Color.clear)
                            .border(style.theme.secondary.opacity(0.25), width: 0.5)
                    }
                }
            }
        }
    }
}

private struct HeaderView: View {
    let doc: ReadableDocument
    let style: BlockStyle

    var body: some View {
        let t = style.theme
        VStack(alignment: .leading, spacing: 10) {
            if let badge = doc.badge {
                Text(badge).font(.system(size: style.size * 0.7, weight: .medium)).foregroundStyle(t.secondary)
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(t.secondary.opacity(0.12), in: Capsule())
            }
            if let summary = doc.summary {
                VStack(alignment: .leading, spacing: 6) {
                    Text("一句话要点").font(.system(size: style.size * 0.72, weight: .bold)).foregroundStyle(t.accent)
                    Text(summary).font(.system(size: style.size * 1.06, weight: .semibold)).foregroundStyle(t.text)
                        .lineSpacing(style.lineSpacing * 0.8)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(t.card, in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .padding(.horizontal, style.margin)
        .padding(.bottom, style.size * 1.1)
    }
}

private struct DividerLabel: View {
    let text: String
    let style: BlockStyle

    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(style.theme.secondary.opacity(0.3)).frame(height: 1)
            Text(text).font(.system(size: style.size * 0.75)).foregroundStyle(style.theme.secondary).fixedSize()
            Rectangle().fill(style.theme.secondary.opacity(0.3)).frame(height: 1)
        }
        .padding(.horizontal, style.margin)
        .padding(.vertical, style.size)
    }
}

private struct FooterView: View {
    let index: Int
    let count: Int
    let style: BlockStyle

    var body: some View {
        Group {
            if count > 1 {
                Text(index + 1 < count ? "\(index + 1) / \(count)  下一张继续" : "\(index + 1) / \(count)  完")
                    .font(.system(size: style.size * 0.7))
                    .foregroundStyle(style.theme.secondary)
            } else {
                Color.clear.frame(height: 1)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
        .padding(.bottom, 24)
    }
}
