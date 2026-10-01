import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";

export default function WindowControls({
  onError,
}: {
  onError: (error: unknown) => void;
}) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const unsubscribe =
      window.workspace.windowControls.onMaximized(setMaximized);
    void window.workspace.windowControls
      .isMaximized()
      .then(setMaximized)
      .catch(onError);
    return unsubscribe;
  }, [onError]);

  return (
    <div className="window-controls" aria-label="Window controls">
      <button
        className="window-control"
        title="Minimize"
        aria-label="Minimize window"
        onClick={() =>
          void window.workspace.windowControls.minimize().catch(onError)
        }
      >
        <Minus size={15} />
      </button>
      <button
        className="window-control"
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore window" : "Maximize window"}
        onClick={() =>
          void window.workspace.windowControls.toggleMaximize().catch(onError)
        }
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        className="window-control window-close"
        title="Close"
        aria-label="Close window"
        onClick={() =>
          void window.workspace.windowControls.close().catch(onError)
        }
      >
        <X size={16} />
      </button>
    </div>
  );
}
