// Senha única do painel (HTTP Basic). O usuário pode ser qualquer um; vale só a senha em DASHBOARD_PASSWORD.
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s) => createHash('sha256').update(String(s)).digest();

export function passwordOk(authorizationHeader, password) {
  if (!password) return false; // sem senha configurada, nada é liberado
  const m = /^Basic (.+)$/i.exec(authorizationHeader ?? '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const given = decoded.slice(decoded.indexOf(':') + 1);
  return timingSafeEqual(digest(given), digest(password));
}

export const CHALLENGE = { 'WWW-Authenticate': 'Basic realm="Painel Lion", charset="UTF-8"' };

// Acesso liberado quando não há senha configurada; com DASHBOARD_PASSWORD definida, exige a senha.
export const accessOk = (authorizationHeader, password) => !password || passwordOk(authorizationHeader, password);
