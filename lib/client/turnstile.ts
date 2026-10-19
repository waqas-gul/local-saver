/**
 * Cloudflare Turnstile token for anonymous sign-in (03 §8; Supabase Auth verifies it).
 * The script is added by our own nonce-carrying code, so the CSP's 'strict-dynamic' allows
 * it; challenges.cloudflare.com is in script-src and frame-src when a site key is set.
 */

type Turnstile = {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptLoaded: Promise<void> | undefined;

function loadScript(): Promise<void> {
  scriptLoaded ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Turnstile failed to load"));
    document.head.appendChild(script);
  });
  return scriptLoaded;
}

export async function getTurnstileToken(siteKey: string): Promise<string> {
  await loadScript();
  const turnstile = window.turnstile;
  if (!turnstile) throw new Error("Turnstile is unavailable");
  return new Promise<string>((resolve, reject) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const widgetId = turnstile.render(container, {
      sitekey: siteKey,
      appearance: "interaction-only",
      callback: (token: string) => {
        resolve(token);
        setTimeout(() => {
          turnstile.remove(widgetId);
          container.remove();
        }, 0);
      },
      "error-callback": () => reject(new Error("The bot check failed")),
    });
  });
}
