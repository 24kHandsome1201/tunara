import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/tokens.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import ReactDOM from "react-dom/client";
import App from "./app/App";

const isLinux = navigator.userAgent.includes("Linux");
if (isLinux) {
  document.documentElement.dataset.chrome = "borderless";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
