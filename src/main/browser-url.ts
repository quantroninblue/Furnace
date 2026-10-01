export function browserURL(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8192) throw new Error("Enter a website or search query.");
  const input = value.trim();
  const host = /^(?:localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(input);
  const scheme = /^[a-z][a-z0-9+.-]*:/i.test(input);
  if (!scheme && (!host || /\s/.test(input))) return `https://duckduckgo.com/?q=${encodeURIComponent(input)}`;
  const url = new URL(host ? `http${/^(?:localhost|127\.[0-9.]+|\[::1\])(?::|[/?#]|$)/i.test(input) ? "" : "s"}://${input}` : input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only HTTP and HTTPS websites without embedded credentials are allowed.");
  return url.href;
}
