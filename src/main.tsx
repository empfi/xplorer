import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import TransferDialog from "./components/TransferDialog";
import "./index.css";

document.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "F3" || (e.ctrlKey && (e.key === "f" || e.key === "F"))) {
      e.preventDefault();
      e.stopPropagation();
      const input = document.querySelector<HTMLInputElement>("[data-fast-search]");
      input?.focus();
      input?.select();
    }
  },
  true,
);

const isTransferWindow = window.location.search.includes("window=transfer");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isTransferWindow ? <TransferDialog standalone /> : <App />}
  </StrictMode>,
);
