# Recursos de descoberta, pedidos e modo família

Código em `netlify/lib/handler.mjs` e `netlify/lib/catalog.mjs` (servidor), `public/app.js` (telas) e
`scripts/atualizar-catalogo.mjs` (coleta da classificação). Testes: `test/descobrir.test.mjs`, `test/pedidos.test.mjs`,
`test/modo-familia.test.mjs`, `test/library.test.mjs`, `test/catalog.test.mjs`, `test/snapshot.test.mjs`, `test/front.test.mjs`.

## Próximo episódio (sem auto-avanço)

O player é um iframe de outra origem (`embedplayapi.top`) e não emite evento de fim de episódio (a página dele não usa
`postMessage`). Auto-avanço por timer seria heurística: dispararia com o vídeo pausado. Por isso a tela de série tem um
cartão "Terminou? Próximo episódio" (e a tecla **N**) que marca o episódio como assistido e abre o seguinte, em um clique.

## Selo "Novo episódio"

Cada série da biblioteca guarda `seenTotal`, o total de episódios do catálogo na última vez que a pessoa abriu ou marcou
algo. Se o catálogo hoje tem mais, `GET /api/me/library` devolve `fresh: true`. Série **concluída** com episódio novo volta
para "Continuar assistindo" apontando o episódio novo; isso é só leitura, nada é gravado.

- Item antigo, sem `seenTotal`, nunca ganha selo (não dá para saber o que a pessoa já tinha visto).
- Só abrir o episódio imediatamente seguinte ao último concluído reabre a série. Rever um episódio antigo não mexe no registro,
  senão o episódio novo perderia o selo sem ter sido aberto. O player toca o episódio pedido de qualquer forma.
- O detalhe do título usa a mesma leitura (`progress.fresh`), para home e detalhe não discordarem.
- O selo só aparece depois que o TMDB marca o episódio como exibido (`last_episode_to_air`): o catálogo é gerado a partir dele.

## Sorteio ("Não sei o que ver")

`GET /api/me/surprise`: sorteia entre os 200 mais populares de nota >= 6,5 com >= 300 votos, fora do que a pessoa já abriu
(a watchlist continua elegível). Usa os gêneros favoritos como preferência, não como obrigação: sem candidato no gênero,
sorteia sem ele. Duração máxima só vale para filmes (série não tem duração no catálogo). `skip` evita repetir o já mostrado.
O `random` é injetado no handler para os testes serem deterministas.

## Pedido de título

Registro por usuário na store `requests`, com escrita condicional por etag, teto de 30 e 5 pedidos novos por dia.

- Título que o catálogo já tem responde 409 `already_in_catalog` com o item (evita pedido inútil). A comparação é por igualdade
  do título normalizado, não "começa com".
- Pedido repetido é idempotente (200, sem novo e-mail).
- O e-mail ao admin é melhor esforço, com teto diário de 20: falhar não desfaz o pedido, que já está gravado.
- Título e observação são texto livre e vão para a caixa do admin: o servidor remove caracteres de controle e de direção
  invisíveis, e o e-mail escapa o HTML.
- O estado "já está no catálogo" é calculado na leitura, então o pedido se atende sozinho quando o título entra.

## Modo família

Cada título pode ter `c` (classificação indicativa do Brasil: 0, 10, 12, 14, 16, 18), coletada pelo script nas mesmas
chamadas ao TMDB (`release_dates` e `content_ratings`). Vale a do Brasil (a mais alta se houver mais de uma); sem ela, converte
a dos EUA pela tabela mais restrita (PG-13 vira 14, R vira 16). A foto só é aceita se ao menos 30% dos títulos trouxerem `c`.
Na coleta de 18/10/2026, 77% (11.364 de 14.766) tinham.

- `maxRating` fica no usuário. O servidor usa `catalog.forRating(max)`, um catálogo filtrado em todas as rotas, e título fora
  da visão responde 410 (play, TV, detalhe, temporadas, episódios, marcar como visto, watchlist).
- **Título sem classificação fica escondido** no modo família: na dúvida, esconde.
- Ligar ou apertar o limite é livre; **afrouxar exige a senha da conta**, usando o mesmo limitador de tentativas da troca de
  senha. O modo é pensado para uma criança usar o aparelho, então só quem sabe a senha desliga.
- Limite: é por conta, não por perfil. Quem usa a conta da criança com a conta dos pais precisa de perfis (não implementado).
