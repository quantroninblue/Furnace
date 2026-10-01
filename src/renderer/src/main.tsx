import React from "react";
import { createRoot } from "react-dom/client";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/rust/register.js";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/cpp/register.js";
import "monaco-editor/language/json/monaco.contribution.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import App from "./App";
import "./styles.css";
import type { WorkspaceAPI } from "../../shared/types";

declare global {
  interface Window {
    workspace: WorkspaceAPI;
  }
}
(self as any).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });
monaco.editor.defineTheme("workspace", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#00000000",
    "editorLineNumber.foreground": "#4c4c4c",
    "editorLineNumber.activeForeground": "#b5b5b5",
    "editor.selectionBackground": "#62626244",
    "editorCursor.foreground": "#ababab",
    "editor.lineHighlightBackground": "#1b1b1b",
    "editorWidget.background": "#1d1d1d",
    "editorGutter.background": "#131313",
    "diffEditor.insertedTextBackground": "#94ad7a20",
    "diffEditor.removedTextBackground": "#bf8e8620",
    "diffEditor.insertedLineBackground": "#94ad7a0c",
    "diffEditor.removedLineBackground": "#bf8e860c",
  },
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
