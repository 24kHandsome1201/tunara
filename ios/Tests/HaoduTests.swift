import XCTest
@testable import Haodu

final class HaoduTests: XCTestCase {
    private func joinedText(_ blocks: [Block]) -> String {
        blocks.compactMap { $0.inline?.plain }.joined()
    }

    /// 原文模式的核心承诺：排版方案只拆段、加标题、标重点，正文一个字都不变。
    func testOriginalModeKeepsEveryCharacter() {
        let text = "第一句话。第二句话！“第三句，带引号。”第四句? Fifth sentence. 最后一句没有句号"
        let source = PlainImporter.blocks(text)
        var plan = StructurePlan(summary: "要点")
        plan.headings = [2: "中间", 4: "后面"]
        plan.paragraphStarts = [1, 3]
        plan.keySentences = [2, 5]
        let out = Structurer.apply(plan, to: source)

        XCTAssertEqual(joinedText(out).filter { !$0.isWhitespace }, text.filter { !$0.isWhitespace })
        XCTAssertEqual(out.filter { if case .heading = $0 { return true } else { return false } }, [.heading("中间"), .heading("后面")])
        let highlighted = out.compactMap { b -> [String]? in
            guard let i = b.inline else { return nil }
            let chars = Array(i.plain)
            return i.highlights.map { String(chars[$0]) }
        }.flatMap { $0 }
        XCTAssertEqual(highlighted, ["“第三句，带引号。”", "最后一句没有句号"])
    }

    func testLocalPlanSplitsLongParagraphAndFindsKeyInfo() {
        let text = Array(repeating: "这是一句比较长的普通说明文字，用来凑出足够的长度。", count: 8).joined() + "请务必在11月18日之前缴费85元。"
        let out = Structurer.apply(Structurer.localPlan(PlainImporter.blocks(text)), to: PlainImporter.blocks(text))
        XCTAssertGreaterThan(out.count, 2, "长段落应该被拆开")
        let last = out.last!.inline!
        let chars = Array(last.plain)
        XCTAssertEqual(last.highlights.map { String(chars[$0]) }, ["请务必在11月18日之前缴费85元。"])
        XCTAssertEqual(last.emphases.map { String(chars[$0]) }, ["11月18日", "85元"])
    }

    func testHTMLKeepsStructureAndBold() {
        let html = "<h2>标题</h2><p>普通<b>加粗</b>&amp;结尾</p><ul><li>一</li><li>二</li></ul><ol><li>甲</li></ol><script>x()</script>"
        let blocks = HTMLImporter.blocks(html)
        XCTAssertEqual(blocks.count, 5)
        XCTAssertEqual(blocks[0], .heading("标题"))
        guard case .paragraph(let p) = blocks[1] else { return XCTFail() }
        XCTAssertEqual(p.plain, "普通加粗&结尾")
        let bold = p.text.runs.filter { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }.map { String(p.text[$0.range].characters) }
        XCTAssertEqual(bold, ["加粗"])
        guard case .listItem(let m1, let i1, _) = blocks[2], case .listItem(let m3, _, _) = blocks[4] else { return XCTFail() }
        XCTAssertEqual([m1, i1.plain, m3], ["•", "一", "1."])

        // AI 想在原有标题下面、或列表中间加小标题时，都不加：原文结构已经够清楚。
        XCTAssertEqual(Structurer.apply(StructurePlan(headings: [0: "AI 标题", 2: "列表中间"]), to: blocks), blocks)
    }

    func testPlainTextListsAndGreetingIsNotHeading() {
        let blocks = PlainImporter.blocks("各位家长：\n大家好。\n1. 带水杯\n2、穿校服\n注意事项：\n- 不带手机")
        XCTAssertEqual(blocks.count, 6)
        if case .heading = blocks[0] { XCTFail("称呼不应该变成标题") }
        XCTAssertEqual(blocks[4], .heading("注意事项"))
        guard case .listItem(let m, let i, _) = blocks[3] else { return XCTFail() }
        XCTAssertEqual([m, i.plain], ["2.", "穿校服"])
    }

    func testAPIResponseWrappedInFence() throws {
        let obj = try OpenAICompatibleProvider.jsonObject(in: "好的：\n```json\n{\"summary\": \"周五研学\", \"keySentences\": [\"2\", 3]}\n```")
        XCTAssertEqual(obj["summary"] as? String, "周五研学")
    }

    /// 微信不勾原图时，宽高比大于 2 的长图才保留 1080 宽；长内容要拆成几张。
    @MainActor
    func testLongTextSplitsIntoWeChatFriendlyPages() {
        let para = Array(repeating: "这是一段用于测试分页的文字，长度适中，读起来很顺。", count: 6).joined()
        let doc = ReadableDocument(summary: "要点", blocks: Array(repeating: .paragraph(Inline(plain: para)), count: 30))
        let pages = PageRenderer.render(doc, theme: Theme.all[0], size: .standard, split: true)
        XCTAssertGreaterThan(pages.count, 1)
        for page in pages {
            XCTAssertEqual(page.size.width * page.scale, 1080)
            XCTAssertLessThanOrEqual(page.size.height * page.scale, 4320 * 1.2)
            XCTAssertGreaterThan(page.size.height / page.size.width, 2)
        }
        XCTAssertEqual(PageRenderer.render(doc, theme: Theme.all[0], size: .standard, split: false).count, 1)
    }
}
