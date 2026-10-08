// The Furnace wordmark in block characters (also printed by scripts/start.mjs; keep in sync).
export const wordmark = [
  "███████╗██╗   ██╗██████╗ ███╗   ██╗ █████╗  ██████╗███████╗",
  "██╔════╝██║   ██║██╔══██╗████╗  ██║██╔══██╗██╔════╝██╔════╝",
  "█████╗  ██║   ██║██████╔╝██╔██╗ ██║███████║██║     █████╗  ",
  "██╔══╝  ██║   ██║██╔══██╗██║╚██╗██║██╔══██║██║     ██╔══╝  ",
  "██║     ╚██████╔╝██║  ██║██║ ╚████║██║  ██║╚██████╗███████╗",
  "╚═╝      ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝ ╚═════╝╚══════╝",
].join("\n");
export const smallWordmark = [
  "┏━╸╻ ╻┏━┓┏┓╻┏━┓┏━╸┏━╸",
  "┣╸ ┃ ┃┣┳┛┃┗┫┣━┫┃  ┣╸ ",
  "╹  ┗━┛╹┗╸╹ ╹╹ ╹┗━╸┗━╸",
].join("\n");

export function Logo({ small = false }: { small?: boolean }) {
  return <pre className={small ? "logo small" : "logo"} role="img" aria-label="Furnace">{small ? smallWordmark : wordmark}</pre>;
}
