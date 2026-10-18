import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalog } from '../netlify/lib/catalog.mjs';

const NOW = Date.parse('2026-10-14T12:00:00Z');

function movie(i, t, extra = {}) {
  return { i, t, y: '2020', d: '2020-05-05', p: `/p${i}.jpg`, r: 7, n: 800, v: 10, g: [28], ...extra };
}

// Diretor 1 (Ana): 5 filmes, com armadilhas de ordenação. Diretor 2 (Bruno): 3 filmes. Diretor 3 (Caio): só 2 filmes (fora da lista).
// Diretor 4 (Dani): 3 filmes mas sem foto (fora da lista). Diretor 5 (Edu): codirige o filme 1 com a Ana.
const data = {
  generatedAt: '2026-10-12T09:00:00Z',
  genres: { 28: 'Ação' },
  directors: {
    1: { n: 'Ana Álvares', p: '/ana.jpg' },
    2: { n: 'Bruno Braga', p: '/bruno.jpg' },
    3: { n: 'Caio Costa', p: '/caio.jpg' },
    4: { n: 'Dani Dias' },
    5: { n: 'Edu Esteves', p: '/edu.jpg' },
  },
  movies: [
    movie(1, 'Nota 8,5 mil votos', { r: 8.5, n: 5000, dr: [1, 5] }),
    movie(2, 'Nota 9 poucos votos', { r: 9, n: 3, dr: [1] }),
    movie(3, 'Nota 7', { r: 7, n: 900, dr: [1] }),
    movie(4, 'Sem nota', { r: undefined, n: undefined, dr: [1] }),
    movie(5, 'Nota 8,5 menos votos', { r: 8.5, n: 100, dr: [1] }),
    movie(6, 'B1', { r: 6, n: 100, dr: [2] }),
    movie(7, 'B2', { r: 8, n: 100, dr: [2] }),
    movie(8, 'B3', { r: 7, n: 100, dr: [2] }),
    movie(9, 'C1', { dr: [3] }),
    movie(10, 'C2', { dr: [3] }),
    movie(11, 'D1', { dr: [4] }),
    movie(12, 'D2', { dr: [4] }),
    movie(13, 'D3', { dr: [4] }),
    movie(14, 'Sem diretor'),
    movie(15, 'Diretor desconhecido nos dados', { dr: [999] }),
  ],
  series: [{ i: 50, t: 'Série', y: '2020', g: [18], s: [[1, 4]] }],
};
const catalog = createCatalog({ data, now: () => NOW });
const titles = (result) => result.items.map((item) => item.title);

test('página do diretor: do melhor avaliado para o pior, com nota de poucos votos e sem nota por último', async () => {
  const result = await catalog.director('1');
  assert.deepEqual(result.director, { id: '1', name: 'Ana Álvares', photo: '/ana.jpg', count: 5 });
  assert.deepEqual(titles(result), ['Nota 8,5 mil votos', 'Nota 8,5 menos votos', 'Nota 7', 'Nota 9 poucos votos', 'Sem nota']);
  assert.ok(result.items.every((item) => item.type === 'movie'));
  assert.equal(result.totalPages, 1);
});

test('página do diretor: codireção aparece nos dois, diretor sem foto ou com poucos filmes também tem página', async () => {
  assert.ok(titles(await catalog.director('5')).includes('Nota 8,5 mil votos'));
  assert.equal((await catalog.director('4')).director.photo, null);
  assert.equal((await catalog.director('3')).director.count, 2);
});

test('página do diretor: id sem filme, sem cadastro ou inexistente = null', async () => {
  assert.equal(await catalog.director('777'), null);
  assert.equal(await catalog.director('999'), null, 'id citado por um filme, mas sem nome nos dados');
  assert.equal(await catalog.director('__proto__'), null);
  assert.equal(await catalog.director('constructor'), null);
});

test('página do diretor: pagina de 30 em 30 sem perder nem repetir filme', async () => {
  const many = createCatalog({
    data: { directors: { 1: { n: 'Prolífico', p: '/x.jpg' } }, movies: Array.from({ length: 65 }, (_, k) => movie(k + 1, `F${k + 1}`, { r: 5 + k / 100, n: 100, dr: [1] })), series: [] },
    now: () => NOW,
  });
  const pages = [await many.director('1', 1), await many.director('1', 2), await many.director('1', 3)];
  assert.deepEqual(pages.map((p) => p.items.length), [30, 30, 5]);
  assert.equal(pages[0].totalPages, 3);
  const all = pages.flatMap((p) => p.items.map((item) => item.id));
  assert.equal(new Set(all).size, 65);
  assert.equal(all[0], '65', 'maior nota primeiro');
  assert.deepEqual((await many.director('1', 9)).items, [], 'página além do fim vem vazia');
});

test('lista de diretores: só com foto e ao menos 3 filmes, dos mais conhecidos (soma de votos) para os menos', async () => {
  const result = await catalog.directors();
  assert.deepEqual(result.items.map((d) => d.name), ['Ana Álvares', 'Bruno Braga']);
  assert.deepEqual(result.items[0], { id: '1', name: 'Ana Álvares', photo: '/ana.jpg', count: 5 });
  assert.equal(result.total, 2);
});

test('lista de diretores: busca sem acento e sem diferenciar maiúsculas, cada palavra é começo de uma palavra do nome', async () => {
  assert.deepEqual((await catalog.directors({ term: 'alvares' })).items.map((d) => d.id), ['1']);
  assert.deepEqual((await catalog.directors({ term: 'ANA al' })).items.map((d) => d.id), ['1']);
  assert.deepEqual((await catalog.directors({ term: 'braga bru' })).items.map((d) => d.id), ['2']);
  assert.deepEqual((await catalog.directors({ term: 'lvares' })).items, [], 'meio da palavra não casa');
  assert.deepEqual((await catalog.directors({ term: 'caio' })).items, [], 'quem não entra na lista também não aparece na busca');
  assert.equal((await catalog.directors({ term: '   ' })).total, 2, 'busca em branco = sem filtro');
});

test('detalhe do filme: traz os diretores com link; filme sem diretor e série vêm com lista vazia', () => {
  assert.deepEqual(catalog.detail('movie', '1').directors, [
    { id: '1', name: 'Ana Álvares', photo: '/ana.jpg', count: 5 },
    { id: '5', name: 'Edu Esteves', photo: '/edu.jpg', count: 1 },
  ]);
  assert.deepEqual(catalog.detail('movie', '14').directors, []);
  assert.deepEqual(catalog.detail('movie', '15').directors, [], 'diretor sem cadastro nos dados é ignorado');
  assert.deepEqual(catalog.detail('tv', '50').directors, []);
});

test('catálogo sem diretores (foto antiga): lista vazia e página do diretor = null, sem quebrar', async () => {
  const old = createCatalog({ data: { movies: [movie(1, 'Velho')], series: [] }, now: () => NOW });
  assert.deepEqual((await old.directors()).items, []);
  assert.equal(await old.director('1'), null);
  assert.deepEqual(old.detail('movie', '1').directors, []);
});

test('catálogo vazio responde 503 catalog_empty também nas rotas de diretores', async () => {
  const empty = createCatalog({ data: { movies: [], series: [] }, now: () => NOW });
  await assert.rejects(empty.directors(), { status: 503, code: 'catalog_empty' });
  await assert.rejects(empty.director('1'), { status: 503, code: 'catalog_empty' });
});
