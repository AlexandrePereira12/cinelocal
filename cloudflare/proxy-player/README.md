# Proxy do player na Cloudflare (reserva)

Código pronto e **não ativo**. Existe para o caso de a rede de alguns usuários voltar a não alcançar o player do
provedor de vídeos. Enquanto o site toca normalmente, nada aqui precisa ser publicado nem mudado no site.

## Por que existe (decisão)

Em 2026-10-22 o filme parou de tocar. Foram dois problemas diferentes, e só um deles pede este proxy:

1. **Queda do provedor (522).** `embedplayapi.top` respondeu 522 por algumas horas e voltou sozinho. Não tem
   solução no nosso código. Proxy não ajuda.
2. **DNS do provedor de internet do usuário (Brisanet/Fortaleza).** O apex `embedplay.one`, que o player usava como 2º
   iframe, dava NXDOMAIN nessa rede (1.1.1.1 e 8.8.8.8 resolviam). O navegador não troca de DNS, então só a pessoa
   (DNS 1.1.1.1 ou VPN) ou um proxy resolvem. O provedor passou a usar `embedplay.vip`, que resolve na mesma rede, e o
   filme voltou a tocar. **Ou seja, o domínio do 2º player muda sozinho e pode cair de novo num domínio bloqueado.**

Teste que prova que o proxy é viável (`diagnostico.js`, rodado na Cloudflare, ponto JDO): o embed, o
`ajax/get_stream_link` e a página do 2º player responderam 200 saindo da rede da Cloudflare.

Alternativas descartadas:
- **Proxy na Netlify (função/redirect):** o provedor recusa o IP de datacenter da função (ver
  `scripts/atualizar-catalogo.mjs` e `netlify/lib/catalog.mjs`).
- **Trocar o DNS pelo navegador / DNS-over-HTTPS:** o iframe resolve pelo DNS do sistema; a página não controla isso.
- **Orientar o usuário (DNS/VPN):** funciona, mas o objetivo era ninguém precisar mexer em nada.

## O que tem aqui

| Arquivo | Para quê |
| --- | --- |
| `diagnostico.js` | Worker descartável que refaz a cadeia embed → `get_stream_link` → 2º player e lista status e domínios de cada passo. Use para provar o acesso e para descobrir um host novo. |
| `worker.js` | O proxy. Atende `https://<worker>/<host>/<caminho>`, só para hosts da lista `ALLOWED_HOSTS`. |
| `wrangler.toml` | Configuração de deploy (nome e `SITE_ORIGIN`). |
| `../../test/proxy-player.test.mjs` | Testes do proxy com o `fetch` simulado (porteiro, lista de hosts, reescrita, redirecionamento, vídeo). |

O que o proxy faz: busca o player pela Cloudflare, reescreve para o próprio endereço as URLs absolutas e os
caminhos `/…` dos hosts permitidos (para o 2º iframe e os scripts também passarem por ele), remove `X-Frame-Options`/CSP/
cookies do provedor e deixa só o nosso site e o próprio proxy embutirem (`frame-ancestors`; o proxy entra porque é o pai imediato do 2º iframe). Corpo que não é texto (vídeo) passa direto, sem timeout depois dos cabeçalhos. Redirecionamento para host fora da lista (CDN de mídia) o navegador segue direto.

## Como ativar (só se voltar a acontecer)

1. **Confirmar o sintoma.** Falha só em algumas redes, com `ERR_NAME_NOT_RESOLVED` no domínio do 2º player. Se for 522
   em todo lugar, é o provedor fora do ar: não ative nada.
2. **Descobrir os hosts atuais.** Publique `diagnostico.js` num Worker temporário, abra `/?tmdb=550` e anote os
   domínios dos passos 2 e 3. Acrescente os que faltarem em `ALLOWED_HOSTS` (`worker.js`). A lista é fechada de
   propósito: aceitar host arbitrário transformaria o Worker em proxy aberto.
3. **Publicar o proxy.** Em `wrangler.toml` troque `SITE_ORIGIN` pelo endereço real do site; depois
   `npx wrangler deploy` dentro desta pasta (conta Cloudflare do projeto). Anote o endereço `https://….workers.dev`.
4. **Apontar o site para o proxy** (mudança ainda não feita, por ser especulativa):
   - `netlify/lib/catalog.mjs`: `EMBED_BASE` hoje é `https://embedplayapi.top/embed`; passaria a
     `https://<worker>/embedplayapi.top/embed`.
   - `netlify.toml`: incluir o endereço do Worker em `frame-src` da CSP.
   - Ajustar o teste da CSP em `test/tv-pages.test.mjs`.
5. **Validar no site publicado** (no `localhost` o provedor recusa o player): tocar um filme e uma série, em uma rede
   afetada, e pelo Chromecast. Isso ainda **não foi validado de ponta a ponta**: só a cadeia de requisições foi
   provada. Pontos de risco: scripts do player que montam URLs em runtime (a reescrita só vê texto literal; o player atual usa `BASE_URL` absoluto, que é reescrito),
   verificação anti-bot do provedor, e o Chromecast (o receptor precisa abrir o mesmo endereço).

## Limites e custos

- **Cota:** plano gratuito = 100 mil requisições/dia. Se o vídeo (segmentos HLS) passar pelo Worker, a cota acaba
  rápido; se o vídeo vier direto de CDNs alcançáveis, o proxy só carrega o HTML do player. Meça no passo 5.
- **Termos do provedor:** servir o player por outro domínio pode ser visto como abuso. Se o provedor reclamar,
  desligue o proxy (volte `EMBED_BASE`) e fale com ele.
- O porteiro por `Referer` só barra uso casual (é falsificável fora do navegador); a barreira real é a lista de hosts.
- Anúncios do player continuam valendo o que já está em `docs/protecao-anuncios.md`; o `sandbox` do iframe não muda.

## Desativar

Voltar `EMBED_BASE` e a CSP ao original e apagar o Worker (`npx wrangler delete`).

## Revisão

O `worker.js` passou por revisão independente (segurança sem achados; correção com 9 achados, todos tratados: CSP do 2º iframe, barras escapadas de JSON, caminhos `/` em CSS/HLS, timeout só nos cabeçalhos, status sem corpo, charset, 206, tipos de conteúdo, redirecionamento para CDN). O caminho `/x` montado em JavaScript em runtime segue como limite conhecido.
