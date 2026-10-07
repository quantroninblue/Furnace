import { createRoot } from "react-dom/client";
import { HomePage } from "./home/page";
import { ready } from "./store";

createRoot(document.getElementById("root")!).render(<HomePage />);
ready();
