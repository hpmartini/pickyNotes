import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";

// Atomic Editor is dark by default and switches to light only via data-theme="light"; follow the OS like style.css does.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.setAttribute("data-theme", dark.matches ? "dark" : "light");
applyTheme();
dark.addEventListener("change", applyTheme);

createRoot(document.getElementById("root")!).render(<App />);
