/**
 * A top-level navigation to another site: the billing provider's hosted checkout and portal (phase 4
 * §17.7.6), and Supabase's verify link from an email once the person continues (P4-23). The CSP doesn't
 * restrict top-level navigations, so no connect-src change is needed. Its own module so component tests
 * can stub it (jsdom doesn't navigate).
 */
export function navigateTo(url: string): void {
  window.location.assign(url);
}
