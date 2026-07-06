import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/tokens.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import ReactDOM from "react-dom/client";

const isLinux = navigator.userAgent.includes("Linux");
if (isLinux) {
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
