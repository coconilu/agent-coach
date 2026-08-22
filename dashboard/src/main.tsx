import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const currentUrl = new URL(window.location.href);
if (currentUrl.searchParams.has("csrf")) {
  window.history.replaceState(null, "", `${currentUrl.pathname}${currentUrl.hash}`);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
