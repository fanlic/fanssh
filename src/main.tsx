import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// 注意：这里不使用 StrictMode，避免开发模式下的重复挂载导致 SSH 会话被连接两次。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
