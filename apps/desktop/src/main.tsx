import { createRoot } from "react-dom/client";
import { App } from "./App";
import { syncTheme } from "./lib/theme";
import "./style.css";

syncTheme();

createRoot(document.getElementById("root")!).render(<App />);
