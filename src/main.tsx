import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import TransferDialog from "./components/TransferDialog";
import "./index.css";

document.addEventListener("contextmenu", (e) => e.preventDefault());

const isTransferWindow = window.location.search.includes("window=transfer");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isTransferWindow ? <TransferDialog standalone /> : <App />}
  </StrictMode>,
);
