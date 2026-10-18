# Filmes por diretor

Telas `#/diretores` (lista com rosto, busca por nome) e `#/diretor/<id>` (filmes do diretor). A tela de detalhe do filme
tem o link "Direção: …" e a home tem a fileira "Filmes por diretor".

## Decisões

- **Dado vem do catálogo, sem requisição extra.** O script `atualizar-catalogo` pede o filme com
  `append_to_response=credits` (mesma chamada de antes). Cada filme ganha `dr` (ids dos diretores) e o topo da foto ganha
  `directors: { id: { n: nome, p: foto } }`. Em runtime continua sem chamada externa (o provedor bloqueia o IP da função).
- **Diretor = `job: "Director"`**, até 3 por filme (codireção conta para todos; passar disso é lista de segunda equipe).
  Séries ficam de fora: não têm diretor único.
- **Gate no script:** se menos de 50% dos filmes trouxerem diretor, a foto é rejeitada e a anterior fica. Sem isso uma
  mudança de formato do TMDB esvaziaria a seção sem aviso.
- **Ordem dos filmes: do melhor avaliado ao pior, em 3 faixas** — nota com ao menos 50 votos, depois nota com poucos
  votos, depois sem nota. Só pela nota, um filme com 3 votos e nota 9 ficaria acima de um clássico 8,5 com milhares de
  votos. A régua de 50 votos é a mesma do filtro "nota mínima" do Explorar.
- **Lista de diretores:** só quem tem foto e ao menos 3 filmes no catálogo (senão vira milhares de rostos sem foto),
  ordenada pelos mais conhecidos (soma dos votos dos filmes). A página do diretor vale para qualquer um com filme, porque
  o link da tela de detalhe pode apontar para quem não entra na lista.
- **API:** `GET /api/directors?q=&page=` e `GET /api/director/<id>?page=`. Busca de 1 letra é 400; diretor desconhecido é
  410 (não 404: o `netlify dev` reenvia 404 para outro caminho).
- **Foto:** `image.tmdb.org`, já liberada na CSP e no cache do service worker. Sem foto, aparecem as iniciais.

## Publicar

O `catalogo.mjs` foi regenerado com diretores (7.468 pessoas, 671 na lista). Sem republicar o catálogo, o site responde
normal, só sem a seção (lista vazia, página do diretor 410).
