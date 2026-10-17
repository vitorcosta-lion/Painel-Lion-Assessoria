// Senha opcional: se DASHBOARD_PASSWORD estiver configurada no Netlify, pede a senha em qualquer acesso.
// Sem a variável, o painel abre direto pelo link.
const enc = new TextEncoder();
const sha = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));

export default async (request, context) => {
  const password = Netlify.env.get('DASHBOARD_PASSWORD');
  if (!password) return context.next();
  const m = /^Basic (.+)$/i.exec(request.headers.get('authorization') ?? '');
  if (m) {
    let decoded = '';
    try { decoded = new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))); } catch { /* cabeçalho inválido */ }
    const [a, b] = await Promise.all([sha(decoded.slice(decoded.indexOf(':') + 1)), sha(password)]);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    if (diff === 0) return context.next();
  }
  return new Response('Acesso restrito.', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Painel Lion", charset="UTF-8"' } });
};

export const config = { path: '/*' };
