/**
 * Server-rendered HTML for the OAuth login flow (docs/06 §4) — deliberately
 * template-free: two small pages, inline styles, zero client-side script.
 */

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; display: flex; justify-content: center;
         align-items: center; min-height: 100vh; margin: 0; background: Canvas; color: CanvasText; }
  main { width: min(22rem, 90vw); padding: 2rem; border: 1px solid color-mix(in srgb, CanvasText 20%, Canvas);
         border-radius: 8px; }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  p.sub { margin: 0 0 1.25rem; font-size: .85rem; opacity: .75; }
  label { display: block; font-size: .85rem; margin-bottom: .25rem; }
  input { width: 100%; box-sizing: border-box; padding: .5rem; margin-bottom: 1rem;
          border: 1px solid color-mix(in srgb, CanvasText 30%, Canvas); border-radius: 4px;
          background: inherit; color: inherit; }
  button { width: 100%; padding: .6rem; border: 0; border-radius: 4px; cursor: pointer;
           background: #4054b2; color: white; font-size: .95rem; }
  .error { color: #c0392b; font-size: .85rem; margin: 0 0 1rem; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export interface LoginPageOptions {
  txnId: string;
  csrf: string;
  /** RFC 7591 client_name of the MCP client asking for access, if it sent one. */
  clientName?: string;
  error?: string;
}

export function renderLoginPage(opts: LoginPageOptions): string {
  const client = opts.clientName ? escapeHtml(opts.clientName) : 'an MCP client';
  return page(
    'untacit — sign in',
    `<h1>Sign in to untacit</h1>
<p class="sub">${client} is asking for read access to your organization's business graph.</p>
${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ''}
<form method="post" action="/login" autocomplete="off">
<input type="hidden" name="txn" value="${escapeHtml(opts.txnId)}">
<input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">
<label for="username">Username</label>
<input id="username" name="username" autocapitalize="none" autocorrect="off" required autofocus>
<label for="password">Password</label>
<input id="password" name="password" type="password" required>
<button type="submit">Sign in</button>
</form>`,
  );
}

export function renderErrorPage(title: string, message: string): string {
  return page(`untacit — ${title}`, `<h1>${escapeHtml(title)}</h1>\n<p class="sub">${escapeHtml(message)}</p>`);
}
