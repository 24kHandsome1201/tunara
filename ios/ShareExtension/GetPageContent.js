// Safari 分享时先在网页里运行：拿到选中的部分（带格式），没选就拿正文。
var GetPageContent = function () {};

GetPageContent.prototype = {
  run: function (args) {
    var selectionHTML = "";
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      var div = document.createElement("div");
      for (var i = 0; i < sel.rangeCount; i++) div.appendChild(sel.getRangeAt(i).cloneContents());
      selectionHTML = div.innerHTML;
    }
    var main =
      document.querySelector("#js_content") || // 公众号文章
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.body;
    args.completionFunction({
      url: document.URL,
      title: document.title,
      selectionHTML: selectionHTML,
      pageHTML: main ? main.innerHTML : "",
    });
  },
  finalize: function (args) {},
};

var ExtensionPreprocessingJS = new GetPageContent();
