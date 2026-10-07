import { createRoot } from "react-dom/client";
import { ConversationPanel } from "./conversation/panel";
import { ready } from "./store";

createRoot(document.getElementById("root")!).render(<ConversationPanel />);
ready();
