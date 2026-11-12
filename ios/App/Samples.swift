import Foundation

/// 内置示例，方便第一次打开时试效果。
struct Sample: Identifiable {
    let id: String
    let title: String
    let input: SourceInput

    static let all: [Sample] = [notice, article]

    static let notice = Sample(id: "notice", title: "家长群通知（纯文字）", input: .text("""
    各位家长：
    大家好！本学期的秋季研学活动定在11月21日（周五）举行，地点是市科技馆和植物园，全天活动，孩子们早上7:40在学校东门集合，统一乘大巴出发，下午4点半左右返回学校，请家长准时到东门接孩子。这次活动费用是每人85元，包含门票、车费和午餐，请在11月18日之前通过班级小程序缴费，逾期视为不参加。活动当天请给孩子穿校服和运动鞋，带好水杯、雨具和少量零食，不要带贵重物品和电子产品。有过敏史或身体不适的孩子，请家长务必提前私信告诉班主任，我们会做好安排。另外提醒一下，活动当天学校不提供早餐，请孩子在家吃完早饭再来。科技馆里有很多互动展品，孩子们会分成小组活动，每组有一位老师和一位家长志愿者带队，目前还缺3位家长志愿者，有空的家长请在群里接龙报名。最后，活动结束后每个孩子要写一篇不少于300字的研学小记，下周一交给语文老师。感谢各位家长的支持和配合！
    """))

    static let article = Sample(id: "article", title: "网页文章（带格式）", input: .html("""
    <article>
    <h1>为什么长消息没人看完</h1>
    <p>在微信里发一大段文字，对方往往只看了开头就<strong>划走了</strong>。这不是因为内容不重要，而是因为手机屏幕上的大段文字<em>没有停顿</em>，读起来很累。</p>
    <h2>三个常见问题</h2>
    <ul>
    <li><strong>没有分段：</strong>几百个字挤在一起，找不到重点。</li>
    <li><strong>重点藏在中间：</strong>时间、地点、要做的事被埋在长句里。</li>
    <li><strong>格式丢失：</strong>从网页复制过来，标题和列表都变成了纯文字。</li>
    </ul>
    <h2>怎么改善</h2>
    <ol>
    <li>先写结论，再写细节。</li>
    <li>每段只讲一件事，三四行就换段。</li>
    <li>把日期、金额和要求单独标出来。</li>
    </ol>
    <blockquote>好的消息，是让对方用最少的力气知道该做什么。</blockquote>
    <table><tr><th>做法</th><th>对方的感受</th></tr><tr><td>原样粘贴</td><td>一眼看不到重点</td></tr><tr><td>分段加小标题</td><td>扫一眼就知道要做什么</td></tr></table>
    </article>
    """))
}
