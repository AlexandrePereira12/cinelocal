# Proteção contra anúncios na tela do filme

Código em `public/app.js` (seções "proteção contra anúncios" e "trava do voltar"); testes em `test/ad-protection.test.mjs`.

## O problema e o limite técnico

O player é um iframe de outro domínio (`embedplayapi.top`, que por sua vez abre outros). O site não enxerga o conteúdo
dele nem intercepta o clique que abre um anúncio. O único freio do navegador é o atributo `sandbox` do iframe.
Anúncio dentro do vídeo (pré-roll) não dá para remover de fora.

## O que existe

### 1. Guarda contra sequestro da página (sempre ligada)

Na tela do filme, um `beforeunload` faz o navegador perguntar antes de sair se o player (ou um anúncio) mandar a
página inteira para outro site. Não depende de o provedor aceitar `sandbox`.

- Só vale na tela do filme (`watchGuard`, que `route()` zera a cada troca de tela).
- Limites: o navegador só pergunta se a pessoa já interagiu com a página (clique no player conta); a pergunta também
  aparece ao fechar a aba ou recarregar, porque não há como distinguir isso de um redirecionamento; o Safari do iOS
  ignora `beforeunload`.
- Se a pessoa confirmar "Sair do player?" na trava do voltar, `watchGuard.leaving` evita perguntar uma segunda vez.
- Efeito colateral: se a entrada da guarda do voltar foi pulada pelo Chrome (página sem interação prévia), o voltar
  que sai do site agora passa por esta pergunta, em vez de sair direto.

### 2. Sandbox do iframe, escolhido por aparelho (padrão: desligado)

Na tela do filme, numa barra "Proteção contra anúncios" logo abaixo do player (sempre visível, com o escudo verde quando o sandbox está ligado), a pessoa escolhe o modo; a escolha fica em
`localStorage` (`cine.sandbox`) e o player recarrega.

| Modo | `sandbox` | Efeito |
|---|---|---|
| `off` (padrão) | nenhum | Como o player vem |
| `block` | `allow-scripts allow-same-origin allow-presentation` | Sem abas e sem redirecionamento |
| `block-forms` | `block` + `allow-forms` | O que foi tentado em 12/10 |
| `redirect-only` | `block` + `allow-popups` | As abas **abrem** (isoladas); só o redirecionamento é bloqueado |

**Por que o padrão é desligado:** o provedor já se recusou a tocar sob sandbox ("remova o Sandbox"; o primeiro commit
tinha `sandbox="allow-scripts allow-same-origin allow-forms"` e foi removido em `c928eb5`). Todo push na `master`
publica no Netlify, então ligar por padrão sem teste quebraria o player de todo mundo. O site não consegue ler de dentro
do iframe se ele foi aceito; quem decide é a pessoa, vendo o vídeo tocar.

**Nunca** entram `allow-top-navigation*` nem `allow-popups-to-escape-sandbox`: seriam o oposto da proteção (o teste
trava isso). `redirect-only` não atende o critério "sem abas": ela existe só para o caso de `block` ser recusado e
mesmo assim valer impedir o redirecionamento.

## Como validar quando o player estiver no ar

1. Abra um filme no site publicado (o provedor só toca em domínio real, não em `localhost`).
2. Na barra "Proteção contra anúncios", teste os modos na ordem `block`, `block-forms`, `redirect-only`.
3. Para cada um, anote: o vídeo toca? aparece "remova o Sandbox"? abre aba ao clicar? tela cheia funciona?
4. Se um modo passar nos quatro, troque `DEFAULT_SANDBOX` em `public/app.js` por ele (e ajuste o teste "vem desligado por
   padrão"). Se nenhum passar, o sandbox não é viável com este provedor; ficam a guarda (item 1) e, se quiser,
   outro provedor de embed testado com o mesmo procedimento.

## O que não foi feito, e por quê

- **TV e Chromecast** (`tv-player.js`, `receiver.js`) continuam sem sandbox: na TV ninguém clica no player, então não
  há popup, e o `tv-player.js` é ES5 validado por teste e só abre o endereço do provedor.
- **Camada "toque para iniciar"** sobre o player: sem o player no ar não dá para medir se reduz popups, piora a
  experiência e fica perto do que se quer evitar (interferir em cliques).
- **Player próprio com URL direta de vídeo:** o provedor esconde o vídeo atrás de captcha e desafio anti-robô.
