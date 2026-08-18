const configuredServer = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, "");
const localServer = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

export const serverOrigin = configuredServer || (localServer ? window.location.origin : "https://voxi-dzfe.onrender.com");
export const serverHttpUrl = (path: string): string => `${serverOrigin}${path.startsWith("/") ? path : `/${path}`}`;
export const serverWebSocketUrl = (path: string): string => {
  const url = new URL(serverHttpUrl(path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};
