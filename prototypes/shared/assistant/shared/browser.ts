export type BrowserState = { url: string; title: string; loading: boolean; back: boolean; forward: boolean; error: string; maximized: boolean; docked: boolean; opened: boolean };
export interface BrowserAPI {
  state(): Promise<BrowserState>;
  navigate(value: string): Promise<void>;
  action(value: "back" | "forward" | "reload" | "stop" | "minimize" | "maximize" | "close" | "dock" | "popout"): Promise<void>;
  onState(callback: (state: BrowserState) => void): () => void;
  onFocusAddress(callback: () => void): () => void;
}

export type BrowserBounds = { x: number; y: number; width: number; height: number };
