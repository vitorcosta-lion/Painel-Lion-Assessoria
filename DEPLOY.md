# Publicar o painel no Netlify

Rode no Terminal, dentro da pasta `lion-dashboard`.

1. Entrar na conta Netlify (abre o navegador):
   `npx netlify-cli login`
2. Criar o site (o nome vira o endereço `nome.netlify.app`; se estiver ocupado, escolha outro):
   `npx netlify-cli sites:create --name lion-painel`
3. Enviar as chaves do `.env` para o Netlify (elas não vão no código):
   `npx netlify-cli env:import .env`
4. (Opcional) Pedir senha para abrir o painel. Sem isso, o link abre direto:
   `npx netlify-cli env:set DASHBOARD_PASSWORD "escolha-uma-senha"`
5. Publicar:
   `npx netlify-cli deploy --prod`

Para atualizar depois de qualquer mudança, repita só o passo 5.

## Endereço fixo
No Netlify: Domain management → Add a domain → `painel.lionassessoria.com.br`.
Depois crie no DNS do domínio um CNAME `painel` apontando para `nome.netlify.app`. O HTTPS é automático.

## Como funciona
- `public/` é a única pasta servida. `.env`, `server.mjs` e `sync.mjs` nunca ficam acessíveis pelo link.
- `netlify/edge-functions/auth.js` só pede senha se `DASHBOARD_PASSWORD` estiver configurada.
- `netlify/functions/data.mjs` entrega os números; `sync-background.mjs` roda o botão "Atualizar dados" em segundo plano (cerca de 1 minuto).
- Modo local continua igual: `npm start` e abra http://localhost:3000.
