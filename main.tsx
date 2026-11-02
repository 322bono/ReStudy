import React from "react";
import { createRoot } from "react-dom/client";
import RestudyApp from "./src/App";
import AppErrorBoundary from './src/components/AppErrorBoundary';
import "./app/globals.css";
import "./frontend.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary><RestudyApp /></AppErrorBoundary>
  </React.StrictMode>,
);
