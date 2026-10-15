import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalog } from '../netlify/lib/catalog.mjs';

const NOW = Date.parse('2026-10-14T12:00:00Z');

function movie(i, t, extra = {}) {
  return { i, t, y: '2020', d: '2020-05-05', p: `/p${i}.jpg`, b: `/b${i}.jpg`, r: 7, n: 800, v: 10, o: `Sinopse ${i}`, rt: 100, g: [28], ...extra };
}
function show(i, t, extra = {}) {
  return { i, t, y: '2020', p: `/s${i}.jpg`, r: 7, n: 800, v: 10, g: [18], s: [[1, 10]], ...extra };
}

const data = {
  generatedAt: '2026-10-12T09:00:00Z',
  genres: { 28: 'Ação', 18: 'Drama', 35: 'Comédia', 27: 'Terror' },
  tvGenres: { 18: 'Drama', 10759: 'Action & Adventure', 10764: 'Reality' },
  movies: [
    movie(1, 'Ação Velha', { y: '1985', d: '1985-01-01', v: 5, n: 5000, r: 8.1, g: [28] }),
    movie(2, 'Drama Recente', { y: '2024', d: '2024-03-03', v: 90, n: 600, r: 8.5, g: [18], rt: 85 }),
    movie(3, 'Comédia Curta', { y: '2010', v: 40, n: 900, r: 6.2, g: [35], rt: 75 }),
    movie(4, 'Ação e Drama', { y: '2015', v: 60, n: 4000, r: 7.4, g: [28, 18], rt: 130 }),
    movie(5, 'Terror Obscuro', { y: '2001', v: 1, n: 3, r: 9.9, g: [27], rt: 50 }),
    movie(6, 'Sem Ano', { y: undefined, d: undefined, v: 2, g: [28] }),
    movie(7, 'Sem Gênero', { g: undefined, v: 3 }),
  ],
  series: [
    show(10, 'Série Longa', { v: 80, g: [18, 10759], s: [[1, 10], [2, 10], [3, 10]], a: '2026-10-12' }),
    show(11, 'Minissérie', { v: 70, n: 400, g: [18], s: [[1, 6]], a: '2026-10-05' }),
    show(12, 'Reality Show', { v: 20, g: [10764], s: [[1, 8]], n: 100, y: '2022' }),
    show(13, 'Antiga Novidade', { v: 15, g: [18], s: [[1, 4]], a: '2026-09-01' }),
  ],
};
const catalog = createCatalog({ data, now: () => NOW });
const ids = (result) => result.items.map((item) => `${item.type}:${item.id}`);

test('info e detail: gêneros por nome, contagem de temporadas/episódios e título fora do catálogo = null', () => {
  assert.deepEqual(catalog.info('movie', '2'), { overview: 'Sinopse 2', rating: 8.5, votes: 600, runtime: 85, originalTitle: null, genres: ['Drama'], seasons: null, episodes: null });
  assert.deepEqual(catalog.info('tv', '10').genres, ['Drama', 'Action & Adventure'], 'série usa os nomes de gênero de série');
  assert.equal(catalog.info('tv', '10').seasons, 3);
  assert.equal(catalog.info('tv', '10').episodes, 30);
  assert.equal(catalog.info('movie', '999'), null);
  assert.equal(catalog.detail('movie', '999'), null);

  const detail = catalog.detail('movie', '4');
  assert.equal(detail.title, 'Ação e Drama');
  assert.equal(detail.backdrop, '/b4.jpg');
  assert.deepEqual(detail.genres, ['Ação', 'Drama']);
  assert.ok(Array.isArray(detail.similar));
});

test('parecidos: mesmo tipo, mais gêneros em comum primeiro, sem o próprio título nem os de poucos votos', () => {
  // Filme 4 = Ação + Drama. Os filmes 1 (Ação), 2 (Drama) e 6 (Ação) dividem 1 gênero cada; o 3 e o 7 não dividem nenhum.
  const list = catalog.similar('movie', '4');
  assert.ok(!list.some((item) => item.id === '4'), 'não inclui o próprio título');
  assert.ok(!list.some((item) => item.type === 'tv'), 'só o mesmo tipo');
  assert.ok(!list.some((item) => item.id === '5'), 'poucos votos fica de fora');
  assert.deepEqual(list.map((item) => item.id), ['2', '1', '6'], 'mesmo número de gêneros em comum: desempata pela popularidade');

  const both = createCatalog({
    data: { generatedAt: 'x', genres: { 28: 'a', 18: 'b' }, movies: [movie(1, 'Base', { g: [28, 18] }), movie(2, 'Um só', { g: [28], v: 99 }), movie(3, 'Os dois', { g: [28, 18], v: 1 })], series: [] },
    now: () => NOW,
  });
  assert.deepEqual(both.similar('movie', '1').map((item) => item.id), ['3', '2'], 'quem divide mais gêneros vem antes, mesmo menos popular');
  assert.deepEqual(both.similar('movie', '1', { exclude: new Set(['movie:3']) }).map((item) => item.id), ['2']);
  assert.deepEqual(both.similar('movie', '1', { limit: 1 }).map((item) => item.id), ['3']);
  assert.deepEqual(catalog.similar('movie', '7'), [], 'título sem gênero não tem parecidos');
  assert.deepEqual(catalog.similar('movie', '999'), []);
});

test('explorar: filtra por tipo, gênero, ano e nota, sempre por popularidade', async () => {
  assert.deepEqual(ids(await catalog.browse({})), ['movie:2', 'tv:10', 'tv:11', 'movie:4', 'movie:3', 'tv:12', 'tv:13', 'movie:1', 'movie:7', 'movie:6', 'movie:5']);
  assert.deepEqual(ids(await catalog.browse({ type: 'tv' })), ['tv:10', 'tv:11', 'tv:12', 'tv:13']);
  assert.deepEqual(ids(await catalog.browse({ type: 'movie', genre: 28 })), ['movie:4', 'movie:1', 'movie:6']);

  // "Todos" + Ação: filmes com Ação e séries com Action & Adventure (mesmo mapeamento da recomendação)
  assert.deepEqual(ids(await catalog.browse({ type: 'all', genre: 28 })), ['tv:10', 'movie:4', 'movie:1', 'movie:6']);
  // só séries: o id de gênero é o da série (10759 = Action & Adventure), sem equivalência
  assert.deepEqual(ids(await catalog.browse({ type: 'tv', genre: 10759 })), ['tv:10']);
  assert.deepEqual(ids(await catalog.browse({ type: 'tv', genre: 28 })), [], 'em séries o id é o de série: 28 não existe lá');
  // Terror não tem equivalente em série: "Todos" só traz filme
  assert.deepEqual(ids(await catalog.browse({ type: 'all', genre: 27 })), ['movie:5']);

  assert.deepEqual(ids(await catalog.browse({ type: 'movie', from: 2010, to: 2019 })), ['movie:4', 'movie:3']);
  assert.deepEqual(ids(await catalog.browse({ type: 'movie', from: 2020 })), ['movie:2', 'movie:7'], 'só o limite inferior');
  assert.ok(!ids(await catalog.browse({ from: 1900, to: 2100 })).includes('movie:6'), 'título sem ano sai quando há filtro de ano');

  const rated = await catalog.browse({ type: 'movie', minRating: 8 });
  assert.deepEqual(ids(rated), ['movie:2', 'movie:1'], 'nota 9.9 com 3 votos não conta: poucos votos');
});

test('explorar: paginação de 30 em 30 e total', async () => {
  const many = Array.from({ length: 65 }, (_, k) => movie(100 + k, `F${k}`, { v: 1000 - k }));
  const big = createCatalog({ data: { generatedAt: 'x', genres: { 28: 'Ação' }, movies: many, series: [] }, now: () => NOW });
  const first = await big.browse({ page: 1 });
  assert.equal(first.items.length, 30);
  assert.equal(first.totalPages, 3);
  assert.equal(first.total, 65);
  assert.equal((await big.browse({ page: 3 })).items.length, 5);
  assert.equal((await big.browse({ page: 4 })).items.length, 0);
  await assert.rejects(createCatalog({ data: { movies: [], series: [] } }).browse({}), { status: 503, code: 'catalog_empty' });
});

test('opções do explorar: por tipo, só gêneros que têm título, em ordem alfabética', () => {
  const options = catalog.browseGenres();
  assert.deepEqual(options.movie.map((g) => g.name), ['Ação', 'Comédia', 'Drama', 'Terror']);
  assert.deepEqual(options.all, options.movie, '"Todos" usa os gêneros de filme');
  assert.deepEqual(options.tv.map((g) => g.name), ['Action & Adventure', 'Drama', 'Reality']);
  options.movie[0].name = 'x';
  assert.equal(catalog.browseGenres().movie[0].name, 'Ação', 'devolve cópias');
});

test('busca com filtros de tipo e ano, aplicados antes do corte de resultados', async () => {
  assert.deepEqual(ids(await catalog.search('ação')), ['movie:4', 'movie:1']);
  assert.deepEqual(ids(await catalog.search('s', { type: 'tv' })), ['tv:10', 'tv:12'], 'só séries, com a palavra começando por "s"');
  assert.deepEqual(ids(await catalog.search('ação', { from: 1980, to: 1989 })), ['movie:1']);
  assert.deepEqual(ids(await catalog.search('ação', { type: 'tv' })), []);

  // filtrar DEPOIS do corte esconderia o filme antigo: 50 filmes recentes populares ocupariam as 40 vagas
  const crowd = Array.from({ length: 50 }, (_, k) => movie(500 + k, `Mundo ${k}`, { v: 100 + k, y: '2024' }));
  const wide = createCatalog({ data: { generatedAt: 'x', movies: [...crowd, movie(900, 'Mundo Antigo', { y: '1960', v: 1 })], series: [] }, now: () => NOW });
  assert.equal((await wide.search('mundo')).items.length, 40);
  assert.deepEqual(ids(await wide.search('mundo', { from: 1950, to: 1969 })), ['movie:900']);
});

test('novidades da semana: só o que entrou na janela terminada na data da foto, e vazia sem nenhum `a`', async () => {
  // foto de 12/10: janela de 7 dias = 06/10 a 12/10. A série 11 (05/10) e a 13 (01/09) ficam de fora.
  assert.deepEqual(ids(await catalog.list('new-this-week', 1)), ['tv:10']);

  const wide = createCatalog({ data: { ...data, series: data.series.map((s) => (s.i === 11 ? { ...s, a: '2026-10-06' } : s)) }, now: () => NOW });
  assert.deepEqual(ids(await wide.list('new-this-week', 1)), ['tv:10', 'tv:11'], 'mais recente primeiro; a borda inclui o dia 06');

  const never = createCatalog({ data: { generatedAt: '2026-10-12T09:00:00Z', movies: data.movies, series: [] }, now: () => NOW });
  assert.deepEqual((await never.list('new-this-week', 1)).items, [], 'foto sem nenhum `a`: fileira vazia, não "tudo é novo"');

  const later = createCatalog({ data, now: () => NOW + 60 * 24 * 60 * 60 * 1000 });
  assert.deepEqual(ids(await later.list('new-this-week', 1)), ['tv:10'], 'a janela vem da data da foto, não do relógio');
});

test('listas por critério: clássicos, filmes até 90 min e séries curtas', async () => {
  assert.deepEqual(ids(await catalog.list('classics', 1)), ['movie:1'], 'antes de 1990, bem votado e bem avaliado');
  assert.deepEqual(ids(await catalog.list('short-movies', 1)), ['movie:2', 'movie:3'], '60 a 90 min com votos suficientes (o de 50 min é curta-metragem)');
  assert.deepEqual(ids(await catalog.list('short-shows', 1)), ['tv:11', 'tv:13'], 'até 12 episódios e votos suficientes (a de 30 episódios e a de 100 votos ficam de fora)');
});

test('próximo episódio: segue na temporada, vira para a próxima e acaba no último', () => {
  const tv = createCatalog({ data: { generatedAt: 'x', movies: [], series: [show(1, 'S', { s: [[1, 2], [3, 1]] })] }, now: () => NOW });
  assert.deepEqual(tv.nextEpisode('1', 1, 1), { season: 1, episode: 2 });
  assert.deepEqual(tv.nextEpisode('1', 1, 2), { season: 3, episode: 1 }, 'pula para a próxima temporada que existe');
  assert.equal(tv.nextEpisode('1', 3, 1), null, 'último episódio da última temporada');
  assert.deepEqual(tv.nextEpisode('1', 1, 9), { season: 3, episode: 1 }, 'episódio além da contagem conta como fim da temporada');
  assert.equal(tv.nextEpisode('1', 2, 1), null, 'temporada que não existe');
  assert.equal(tv.nextEpisode('999', 1, 1), null, 'série fora do catálogo');
});

test('recomendação pondera pelo que a pessoa já assistiu e continua igual sem histórico', () => {
  const movies = [
    movie(1, 'Ação Pop', { g: [28], v: 100 }),
    movie(2, 'Ação Comédia', { g: [28, 35], v: 60 }),
    movie(3, 'Ação Drama', { g: [28, 18], v: 70 }),
  ];
  const seen = [movie(50, 'Visto 1', { g: [35] }), movie(51, 'Visto 2', { g: [35, 18] })];
  const mixed = createCatalog({ data: { generatedAt: 'x', genres: { 28: 'Ação', 35: 'Comédia', 18: 'Drama', 99: 'Doc' }, movies: [...movies, ...seen], series: [] }, now: () => NOW });

  const plain = mixed.recommend([28, 99]).first.map((item) => item.id);
  assert.deepEqual(plain.slice(0, 3), ['1', '3', '2'], 'sem histórico: só popularidade');

  const weighted = mixed.recommend([28, 99], new Set(['movie:50', 'movie:51']), undefined, { watched: [{ type: 'movie', id: '50' }, { type: 'movie', id: '51' }] }).first.map((item) => item.id);
  // afinidade: Comédia 100% dos assistidos, Drama 50%. 2 (60×2.0=120) > 3 (70×1.5=105) > 1 (100×1.0=100)
  assert.deepEqual(weighted, ['2', '3', '1'], 'quem tem os gêneros do que ela já viu sobe');

  assert.deepEqual(mixed.recommend([28, 99], new Set(), undefined, { watched: [{ type: 'movie', id: '404' }] }).first.map((item) => item.id), plain, 'assistido fora do catálogo não pesa');
});

test('recomendação: série assistida pesa pelos gêneros de filme equivalentes', () => {
  const movies = [movie(1, 'Ação Comum', { g: [28], v: 100 }), movie(2, 'Ação e Comédia', { g: [28, 35], v: 90 })];
  const watchedShow = show(9, 'Série de Comédia', { g: [35] });
  const c = createCatalog({ data: { generatedAt: 'x', genres: { 28: 'Ação', 35: 'Comédia', 99: 'Doc' }, tvGenres: { 35: 'Comédia' }, movies, series: [watchedShow] }, now: () => NOW });
  const result = c.recommend([28, 99], new Set(), undefined, { watched: [{ type: 'tv', id: '9' }] }).first.filter((item) => item.type === 'movie');
  assert.deepEqual(result.map((item) => item.id), ['2', '1'], 'comédia de série assistida puxa o filme de comédia');
});
