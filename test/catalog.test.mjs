import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalog } from '../netlify/lib/catalog.mjs';

const NOW = Date.parse('2026-10-11T12:00:00Z');

function movie(i, t, extra = {}) {
  return { i, t, y: '2020', d: '2020-05-05', p: `/p${i}.jpg`, b: `/b${i}.jpg`, r: 7, n: 100, v: 10, o: 'Sinopse', rt: 100, ...extra };
}

const data = {
  generatedAt: '2026-10-01T00:00:00Z',
  genres: { 28: 'Ação', 18: 'Drama', 35: 'Comédia', 99: 'Documentário' },
  movies: [
    movie(1, 'Ação Máxima', { v: 50, n: 9000, r: 6.1, d: '2026-01-01', g: [28] }),
    movie(2, 'O Último Voo', { v: 90, n: 600, r: 8.9, d: '2026-09-30', ot: 'The Last Flight', g: [28, 18] }),
    movie(3, 'Futuro Distante', { v: 70, n: 50, r: 9.9, d: '2027-03-01', g: [18] }),
    movie(4, 'Coração Valente', { v: 5, n: 4000, r: 8.0, d: '1995-05-24', g: [35, 28] }),
    movie(5, 'Sem Nota', { v: 1, r: undefined, n: undefined, d: undefined, p: undefined, b: undefined, o: undefined, rt: undefined }),
  ],
  series: [
    { i: 10, t: 'Série Boa', y: '2019', p: '/s10.jpg', v: 80, n: 2000, r: 8.4, g: [18, 10759], s: [[1, 8], [2, 10], [3, 5]] },
    { i: 11, t: 'Outra Série', y: '2021', v: 20, n: 300, g: [35], s: [[1, 3]] },
    { i: 12, t: 'Voo da Série', y: '2022', v: 30, n: 10, g: [10765], s: [] },
  ],
};

const catalog = createCatalog({ data, now: () => NOW });
const ids = (result) => result.items.map((item) => item.id);

test('listas ordenam por popularidade, votos, nota e data', async () => {
  assert.deepEqual(ids(await catalog.list('trending-movies', 1)), ['2', '3', '1', '4', '5']);
  assert.deepEqual(ids(await catalog.list('library-movies', 1)), ['1', '4', '2', '3', '5']);
  assert.deepEqual(ids(await catalog.list('trending-shows', 1)), ['10', '12', '11']);
  assert.deepEqual(ids(await catalog.list('library-shows', 1)), ['10', '11', '12']);
});

test('mais avaliados exige mínimo de votos; lançamentos não inclui estreia futura', async () => {
  assert.deepEqual(ids(await catalog.list('top-movies', 1)), ['2', '4', '1'], 'o filme 3 tem nota 9.9 mas só 50 votos');
  assert.deepEqual(ids(await catalog.list('recent-movies', 1)), ['2', '1', '4'], 'sem o filme de 2027 e sem o que não tem data');
});

test('item sai com o formato que o front espera e sem dados internos', async () => {
  const [first] = (await catalog.list('trending-movies', 1)).items;
  assert.deepEqual(first, { id: '2', type: 'movie', title: 'O Último Voo', year: '2020', poster: '/p2.jpg', backdrop: '/b2.jpg', overview: 'Sinopse', rating: 8.9, runtime: 100 });
  const bare = (await catalog.list('trending-movies', 1)).items.at(-1);
  assert.equal(bare.poster, null);
  assert.equal(bare.backdrop, null);
  assert.equal(bare.rating, null);
});

test('paginação: 30 por página, teto nas listas "em alta" e página fora do intervalo vazia', async () => {
  const many = Array.from({ length: 100 }, (_, k) => movie(k + 1, `Filme ${k + 1}`, { v: k, n: k }));
  const big = createCatalog({ data: { movies: many, series: [] }, now: () => NOW });
  const trending = await big.list('trending-movies', 1);
  assert.equal(trending.items.length, 30);
  assert.equal(trending.totalPages, 2, 'em alta tem no máximo 60 itens');
  assert.equal((await big.list('trending-movies', 2)).items.length, 30);
  assert.equal((await big.list('trending-movies', 3)).items.length, 0);

  const library = await big.list('library-movies', 1);
  assert.equal(library.totalPages, 4);
  assert.equal((await big.list('library-movies', 4)).items.length, 10);
});

test('busca por começo de palavra, sem acento e maiúscula; prioriza começo do título', async () => {
  assert.deepEqual(ids(await catalog.search('acao')), ['1']);
  assert.deepEqual(ids(await catalog.search('CORAÇÃO valente')), ['4']);
  assert.deepEqual(ids(await catalog.search('last flight')), ['2'], 'acha pelo título original');
  assert.deepEqual(ids(await catalog.search('voo')), ['12', '2'], 'título que começa com a palavra vem antes');
  assert.deepEqual((await catalog.search('zzzz')).items, []);
  assert.deepEqual((await catalog.search('!!!')).items, []);
  const typed = (await catalog.search('serie')).items.map((i) => `${i.type}:${i.id}`);
  assert.deepEqual(typed.sort(), ['tv:10', 'tv:11', 'tv:12']);
});

test('temporadas e episódios vêm da contagem do catálogo', async () => {
  assert.deepEqual(await catalog.seasons('10'), { seasons: [1, 2, 3] });
  assert.deepEqual(await catalog.episodes('10', 2), { season: 2, episodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  assert.deepEqual(await catalog.episodes('10', 9), { season: 9, episodes: [] });
  assert.deepEqual(await catalog.seasons('999'), { seasons: [] });
  assert.deepEqual(await catalog.seasons('12'), { seasons: [] });
});

test('lookup devolve o metadado oficial por tipo e id', () => {
  assert.equal(catalog.lookup('movie', '4').title, 'Coração Valente');
  assert.equal(catalog.lookup('tv', '10').title, 'Série Boa');
  assert.equal(catalog.lookup('movie', '10'), null, 'id de série não vale como filme');
  assert.equal(catalog.lookup('tv', '999'), null);
});

test('lista desconhecida é 404; catálogo vazio é 503 catalog_empty (nunca 403/404)', async () => {
  await assert.rejects(catalog.list('nao-existe', 1), { status: 404 });
  const empty = createCatalog({ data: { generatedAt: null, movies: [], series: [] }, now: () => NOW });
  await assert.rejects(empty.list('trending-movies', 1), { status: 503, code: 'catalog_empty' });
  await assert.rejects(empty.search('qualquer coisa'), { status: 503, code: 'catalog_empty' });
});

test('gêneros: lista só os que têm filme, em ordem alfabética pt-BR, e devolve cópias', () => {
  assert.deepEqual(catalog.genres(), [
    { id: 28, name: 'Ação' },
    { id: 35, name: 'Comédia' },
    { id: 18, name: 'Drama' },
  ]);
  catalog.genres()[0].name = 'alterado';
  assert.equal(catalog.genres()[0].name, 'Ação', 'mexer no retorno não altera o catálogo');
});

test('catálogo sem gêneros: genres() vazio e recommend sem resultado', () => {
  const old = createCatalog({ data: { generatedAt: 'x', movies: data.movies.map(({ g, ...rest }) => rest), series: [] }, now: () => NOW });
  assert.deepEqual(old.genres(), []);
  assert.deepEqual(old.recommend([28, 18]), { first: [], second: [], both: [] });
});

const keys = (items) => items.map((item) => `${item.type}:${item.id}`);

test('recomendação: só do gênero 1, só do gênero 2 e os que têm os dois, misturando filme e série, sem repetir', () => {
  // Ação (28) = filme com 28 / série com Action & Adventure (10759); Drama (18) = filme e série com 18
  const { first, second, both } = catalog.recommend([28, 18]);
  assert.deepEqual(keys(first), ['movie:1', 'movie:4'], 'só Ação: filmes 1 e 4 (a série 10 é Ação E Drama)');
  assert.deepEqual(keys(second), ['movie:3'], 'só Drama');
  assert.deepEqual(keys(both), ['movie:2', 'tv:10'], 'os dois gêneros: um filme e uma série, intercalados');
  const all = [...keys(first), ...keys(second), ...keys(both)];
  assert.equal(new Set(all).size, all.length, 'nenhum título aparece em duas listas');
  assert.equal(both[1].type, 'tv');
});

test('recomendação: série pelos equivalentes do TMDB, e gênero sem equivalente (Terror) só recomenda filme', () => {
  // Fantasia (14) -> Sci-Fi & Fantasy (série 12); Comédia (35) -> filme 4 e série 11
  const { first, second, both } = catalog.recommend([35, 14]);
  assert.deepEqual(keys(first), ['tv:11', 'movie:4'], 'série mais popular primeiro, depois o filme');
  assert.deepEqual(keys(second), ['tv:12']);
  assert.deepEqual(both, []);

  const horror = createCatalog({
    data: {
      generatedAt: 'x',
      genres: { 27: 'Terror', 28: 'Ação' },
      movies: [movie(100, 'Susto', { g: [27] }), movie(101, 'Susto de Ação', { g: [27, 28] })],
      series: [{ i: 200, t: 'Série de Ação', v: 10, g: [10759], s: [[1, 1]] }],
    },
    now: () => NOW,
  });
  const result = horror.recommend([27, 28]);
  assert.deepEqual(keys(result.first), ['movie:100'], 'Terror não tem equivalente em série: só filme');
  assert.deepEqual(keys(result.second), ['tv:200']);
  assert.deepEqual(keys(result.both), ['movie:101']);
});

test('recomendação: não sugere o que o usuário já abriu', () => {
  const { first, second, both } = catalog.recommend([28, 18], new Set(['movie:1', 'tv:10']));
  assert.deepEqual(keys(first), ['movie:4']);
  assert.deepEqual(keys(second), ['movie:3']);
  assert.deepEqual(keys(both), ['movie:2']);
});

test('recomendação: intercala filme e série pela popularidade e respeita o limite', () => {
  const movies = Array.from({ length: 50 }, (_, k) => movie(1000 + k, `Filme ${k}`, { g: [28], v: 1000 - k }));
  const series = Array.from({ length: 50 }, (_, k) => ({ i: 2000 + k, t: `Série ${k}`, v: 500 - k, g: [10759], s: [[1, 1]] }));
  const big = createCatalog({ data: { generatedAt: 'x', genres: { 28: 'Ação', 99: 'Documentário' }, movies, series }, now: () => NOW });
  const { first } = big.recommend([28, 99]);
  assert.equal(first.length, 30);
  assert.deepEqual(first.slice(0, 6).map((item) => item.type), ['movie', 'tv', 'movie', 'tv', 'movie', 'tv'], 'alterna filme e série');
  assert.equal(first[0].id, '1000', 'começa pelo mais popular (filme)');
  assert.equal(big.recommend([28, 99], new Set(), 5).first.length, 5);
});

test('recomendação: poucos títulos nos dois gêneros completa a lista mistura com os próximos de cada gênero', () => {
  const a = Array.from({ length: 40 }, (_, k) => movie(3000 + k, `A${k}`, { g: [28], v: 900 - k }));
  const b = Array.from({ length: 40 }, (_, k) => movie(4000 + k, `B${k}`, { g: [18], v: 800 - k }));
  const ab = [movie(5000, 'Os dois 1', { g: [28, 18], v: 10 }), movie(5001, 'Os dois 2', { g: [28, 18], v: 9 })];
  const pad = createCatalog({ data: { generatedAt: 'x', genres: { 28: 'Ação', 18: 'Drama' }, movies: [...a, ...b, ...ab], series: [] }, now: () => NOW });
  const { first, second, both } = pad.recommend([28, 18]);
  assert.deepEqual(keys(both).slice(0, 2), ['movie:5000', 'movie:5001'], 'os que têm os dois vêm primeiro');
  assert.equal(both.length, 22, '2 dos dois gêneros + 10 extras de cada lado');
  const shown = new Set([...keys(first), ...keys(second)]);
  assert.ok(keys(both).every((key) => !shown.has(key) || key.startsWith('movie:50')), 'o preenchimento não repete o que já está nas outras listas');
});

test('recomendação: sem nenhum título do gênero devolve listas vazias', () => {
  assert.deepEqual(catalog.recommend([99, 37]), { first: [], second: [], both: [] });
});

