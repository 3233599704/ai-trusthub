import React from "react";
import { createRoot } from "react-dom/client";

import Home from "./app/page";
import "./app/globals.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing root element");
}

createRoot(rootElement).render(
  <React.StrictMode>
    <Home />
  </React.StrictMode>,
);
