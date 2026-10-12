import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalog } from '../netlify/lib/catalog.mjs';

const NOW = Date.parse('2026-10-11T12:00:00Z');

function movie(i, t, extra = {}) {
  return { i, t, y: '2020', d: '2020-05-05', p: `/p${i}.jpg`, b: `/b${i}.jpg`, r: 7, n: 100, v: 10, o: 'Sinopse', rt: 100, ...extra };
}

const data = {
  generatedAt: '2026-10-01T00:00:00Z',
  movies: [
    movie(1, 'Ação Máxima', { v: 50, n: 9000, r: 6.1, d: '2026-01-01' }),
    movie(2, 'O Último Voo', { v: 90, n: 600, r: 8.9, d: '2026-09-30', ot: 'The Last Flight' }),
    movie(3, 'Futuro Distante', { v: 70, n: 50, r: 9.9, d: '2027-03-01' }),
    movie(4, 'Coração Valente', { v: 5, n: 4000, r: 8.0, d: '1995-05-24' }),
    movie(5, 'Sem Nota', { v: 1, r: undefined, n: undefined, d: undefined, p: undefined, b: undefined, o: undefined, rt: undefined }),
  ],
  series: [
    { i: 10, t: 'Série Boa', y: '2019', p: '/s10.jpg', v: 80, n: 2000, r: 8.4, s: [[1, 8], [2, 10], [3, 5]] },
    { i: 11, t: 'Outra Série', y: '2021', v: 20, n: 300, s: [[1, 3]] },
    { i: 12, t: 'Voo da Série', y: '2022', v: 30, n: 10, s: [] },
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
