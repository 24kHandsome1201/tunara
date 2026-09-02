/* 界面中等宽元素大量使用 500/600/650 字重（徽章、快捷键、面板标题），
   只打包 400/700 会让浏览器合成加粗；500/600 补齐中间档。 */
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/tokens.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";
import "./styles/files.css";

import ReactDOM from "react-dom/client";

const isLinuxTauri = navigator.userAgent.includes("Linux") && "__TAURI_INTERNALS__" in window;
if (isLinuxTauri) {
  document.documentElement.dataset.chrome = "borderless";
}

function renderBootError(error: unknown) {
  const root = document.getElementById("root");
  if (!root) return;
  const message = error instanceof Error ? error.stack || error.message : String(error);
  root.innerHTML = "";
  const pre = document.createElement("pre");
  pre.textContent = `Tunara failed to start\n\n${message}`;
  pre.style.cssText = [
    "margin:0",
    "padding:24px",
    "white-space:pre-wrap",
    "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace",
    "color:#b03a46",
    "background:#fff7f7",
    "height:100vh",
    "overflow:auto",
  ].join(";");
  root.appendChild(pre);
}

import("./app/App")
  .then(({ default: App }) => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
  })
  .catch(renderBootError);
