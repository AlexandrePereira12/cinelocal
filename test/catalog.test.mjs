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


// --- sorteio, pedido de título, episódios e modo família ---

const RICH_NOW = Date.parse('2026-10-11T12:00:00Z');
const rich = {
  generatedAt: '2026-10-01T00:00:00Z',
  genres: { 28: 'Ação', 18: 'Drama', 35: 'Comédia', 27: 'Terror', 99: 'Documentário' },
  tvGenres: { 10759: 'Action & Adventure', 35: 'Comédia' },
  directors: { 900: { n: 'Diretora Rica', p: '/d900.jpg' } },
  movies: [
    movie(1, 'Aventura Alta', { v: 100, n: 1000, r: 8.0, rt: 90, g: [28], c: 12, a: '2026-09-30', dr: [900], d: '2026-10-15' }),
    movie(2, 'Comédia Leve', { v: 90, n: 500, r: 7.0, rt: 120, g: [35], c: 0, ot: 'Light Comedy', dr: [900] }),
    movie(3, 'Drama Longo', { v: 80, n: 2000, r: 7.5, rt: 180, g: [18], c: 16, dr: [900] }),
    movie(4, 'Terror Famoso', { v: 200, n: 5000, r: 6.4, rt: 100, g: [27], c: 18 }),
    movie(5, 'Poucos Votos', { v: 300, n: 299, r: 9.0, rt: 90, g: [28], c: 0 }),
    movie(6, 'Sem Duração', { v: 70, n: 400, r: 7.0, rt: undefined, g: [28] }),
    movie(7, 'Limite', { v: 60, n: 300, r: 6.5, rt: 60, g: [35], c: 10 }),
  ],
  series: [
    { i: 10, t: 'Série Boa', y: '2019', p: '/s10.jpg', v: 95, n: 900, r: 8, g: [10759], s: [[1, 3], [2, 2]], c: 14 },
    { i: 11, t: 'Série Fraca', y: '2020', v: 500, n: 1000, r: 6, g: [35], s: [[1, 4]], c: 0 },
    { i: 12, t: 'Série Comédia', y: '2021', v: 50, n: 400, r: 7, g: [35], s: [[1, 5]], c: 10 },
    { i: 13, t: 'Série Vazia', y: '2021', v: 1, n: 1, g: [35], s: [] },
  ],
};
const richCatalog = createCatalog({ data: rich, now: () => RICH_NOW });
const key = (item) => `${item.type}:${item.id}`;
// Candidatos do sorteio por popularidade: movie 1 (100), tv 10 (95), movie 2 (90), movie 3 (80), movie 6 (70), movie 7 (60), tv 12 (50).
const POOL_ORDER = ['movie:1', 'tv:10', 'movie:2', 'movie:3', 'movie:6', 'movie:7', 'tv:12'];

test('episodeCount: soma as temporadas; fora do catálogo = null; sem episódios = 0', () => {
  assert.equal(richCatalog.episodeCount('10'), 5);
  assert.equal(richCatalog.episodeCount('13'), 0);
  assert.equal(richCatalog.episodeCount('9999'), null);
  assert.equal(richCatalog.episodeCount('1'), null, 'filme não é série');
});

test('sorteio: só nota >= 6.5 com >= 300 votos, escolhe pela posição sorteada entre os mais populares', () => {
  const picked = (random, options = {}) => richCatalog.pick({ random: () => random, ...options });
  assert.equal(key(picked(0)), 'movie:1', 'random 0 = o mais popular');
  assert.equal(key(picked(0.5)), 'movie:3', 'floor(0.5 * 7) = 3');
  assert.equal(key(picked(0.999999)), 'tv:12', 'random perto de 1 = o último candidato');
  const everyone = POOL_ORDER.map((_, k) => key(picked(k / POOL_ORDER.length)));
  assert.deepEqual(everyone, POOL_ORDER, 'terror (nota 6.4), poucos votos (299), série fraca e série vazia nunca entram; 6.5 e 300 votos entram');

  const first = picked(0);
  assert.deepEqual(first, { id: '1', type: 'movie', title: 'Aventura Alta', year: '2020', poster: '/p1.jpg', backdrop: '/b1.jpg', overview: 'Sinopse', rating: 8, runtime: 90, genres: ['Ação'], certification: 12 });
  assert.deepEqual(picked(0.2).genres, ['Action & Adventure'], 'série usa os nomes de gênero de série');
});

test('sorteio: exclude (já abertos) e skip (já sugeridos) tiram o título; sem candidato = null', () => {
  assert.equal(key(richCatalog.pick({ random: () => 0, exclude: new Set(['movie:1']) })), 'tv:10');
  assert.equal(key(richCatalog.pick({ random: () => 0, skip: new Set(['movie:1', 'tv:10']) })), 'movie:2');
  assert.equal(richCatalog.pick({ exclude: new Set(POOL_ORDER) }), null);
  assert.equal(richCatalog.pick({ skip: new Set(POOL_ORDER) }), null);
  const seen = new Set();
  for (let i = 0; i < POOL_ORDER.length; i++) seen.add(key(richCatalog.pick({ skip: seen })));
  assert.equal(seen.size, POOL_ORDER.length, 'pedindo com skip acumulado, cada sorteio traz um título novo até acabar');
  assert.equal(richCatalog.pick({ skip: seen }), null);
  assert.ok(POOL_ORDER.includes(key(richCatalog.pick())), 'sem opções usa Math.random e devolve candidato válido');
});

test('sorteio: tipo e duração (só filme com duração conhecida e <= máximo; série fica de fora)', () => {
  const at = (random, options) => key(richCatalog.pick({ random: () => random, ...options }));
  assert.equal(at(0.999999, { type: 'movie' }), 'movie:7');
  assert.equal(at(0, { type: 'tv' }), 'tv:10');
  assert.equal(at(0.999999, { type: 'tv' }), 'tv:12');
  assert.equal(at(0, { maxMinutes: 90 }), 'movie:1');
  assert.equal(at(0.999999, { maxMinutes: 90 }), 'movie:7', 'só os filmes de até 90 min: o 1 (90) e o 7 (60); o 6 não tem duração');
  assert.equal(at(0.999999, { maxMinutes: 120 }), 'movie:7');
  assert.equal(at(0.6, { maxMinutes: 120 }), 'movie:2', 'candidatos até 120 min: 1, 2 e 7');
  assert.equal(richCatalog.pick({ maxMinutes: 30 }), null);
  assert.equal(richCatalog.pick({ type: 'tv', maxMinutes: 600 }), null, 'com duração só entra filme: série não tem duração');
});

test('sorteio: gêneros restringem (série pelo equivalente); sem ninguém no gênero, sorteia sem gênero', () => {
  const at = (random, options) => key(richCatalog.pick({ random: () => random, ...options }));
  // Ação (28) casa com os filmes 1 e 6 e, pelo equivalente, com a série 10; Comédia (35) com 2, 7 e a série 12.
  const actionComedy = [28, 35];
  assert.equal(at(0, { genreIds: actionComedy }), 'movie:1');
  assert.equal(at(0.999999, { genreIds: actionComedy }), 'tv:12');
  const liked = new Set(POOL_ORDER.filter((k) => k !== 'movie:3'));
  for (let i = 0; i < 6; i++) assert.ok(liked.has(at(i / 6, { genreIds: actionComedy })), 'o filme de Drama nunca sai com Ação e Comédia');
  assert.equal(at(0.999999, { genreIds: [18, 99] }), 'movie:3', 'só o Drama casa');
  assert.equal(at(0, { genreIds: [99, 27] }), 'movie:1', 'ninguém casa (terror tem nota baixa, documentário não existe): vale o catálogo todo');
  assert.equal(at(0, { genreIds: [28, 35], type: 'tv' }), 'tv:10');
  assert.equal(at(0, { genreIds: [] }), 'movie:1');
});

test('sorteio: o pool é só dos 200 mais populares do que sobrou', () => {
  const many = Array.from({ length: 250 }, (_, k) => movie(k + 1, `Filme ${k + 1}`, { v: 1000 - k, n: 500, r: 7 }));
  const big = createCatalog({ data: { movies: many, series: [] }, now: () => NOW });
  assert.equal(big.pick({ random: () => 0.999999 }).id, '200', 'o último do pool é o 200º mais popular');
  assert.equal(big.pick({ random: () => 0 }).id, '1');
  assert.equal(big.pick({ random: () => 0.999999, exclude: new Set(['movie:1']) }).id, '201', 'excluir um libera o próximo do ranking');
});

test('hasTitle: título ou original inteiro, sem acento/pontuação/maiúscula; começo de palavra não vale', () => {
  assert.equal(richCatalog.hasTitle('aventura alta').id, '1');
  assert.equal(richCatalog.hasTitle('  AVENTURA,  Alta!! ').id, '1');
  assert.equal(richCatalog.hasTitle('comedia leve').id, '2');
  assert.equal(richCatalog.hasTitle('Light Comedy').id, '2', 'o título original também conta');
  assert.equal(richCatalog.hasTitle('Aventura'), null, 'começo do título não é o título');
  assert.equal(richCatalog.hasTitle('Aventura Alta 2'), null);
  assert.equal(richCatalog.hasTitle('!!'), null);
  assert.equal(richCatalog.hasTitle(''), null);
  assert.deepEqual(richCatalog.hasTitle('Série Boa', { type: 'tv' }), { id: '10', type: 'tv', title: 'Série Boa', year: '2019', poster: '/s10.jpg', backdrop: null, overview: null, rating: 8, runtime: null });
  assert.equal(richCatalog.hasTitle('Série Boa', { type: 'movie' }), null);
});

test('hasTitle: tipo e ano filtram; havendo mais de um, o mais popular', () => {
  const twins = createCatalog({
    data: {
      movies: [movie(20, 'Gêmeo', { y: '2001', v: 10 })],
      series: [{ i: 21, t: 'Gemeo', y: '2015', v: 20, s: [[1, 1]] }],
    },
    now: () => NOW,
  });
  const found = (options) => twins.hasTitle('gemeo', options) && key(twins.hasTitle('gemeo', options));
  assert.equal(found(), 'tv:21');
  assert.equal(found({ type: 'any' }), 'tv:21');
  assert.equal(found({ type: 'movie' }), 'movie:20');
  assert.equal(found({ year: 2001 }), 'movie:20', 'o ano escolhe entre os dois');
  assert.equal(found({ year: '2015', type: 'any' }), 'tv:21');
  assert.equal(found({ year: 1999 }), null);
  assert.equal(found({ type: 'tv', year: 2001 }), null);
});

test('info traz a classificação (0 é livre e não vira null; sem dado = null)', () => {
  assert.equal(richCatalog.info('movie', '1').certification, 12);
  assert.equal(richCatalog.info('movie', '2').certification, 0);
  assert.equal(richCatalog.info('movie', '6').certification, null);
  assert.equal(richCatalog.detail('tv', '10').certification, 14);
});

test('modo família: sem limite devolve o próprio catálogo; a visão é memoizada por valor', () => {
  assert.equal(richCatalog.forRating(null), richCatalog);
  assert.equal(richCatalog.forRating(undefined), richCatalog);
  assert.equal(richCatalog.forRating(12), richCatalog.forRating(12));
  assert.notEqual(richCatalog.forRating(12), richCatalog.forRating(10));
});

test('modo família: a visão só tem título com classificação conhecida e <= limite, em TODOS os métodos', async () => {
  const view = richCatalog.forRating(12);
  // Visíveis: filmes 1 (12), 2 (0), 5 (0), 7 (10) e séries 11 (0) e 12 (10). Fora: 3 (16), 4 (18), 6 e a série 13 (sem classificação), a 10 (14).
  assert.deepEqual(ids(await view.list('library-movies', 1)), ['1', '2', '7', '5']);
  assert.deepEqual((await view.list('library-shows', 1)).items.map((i) => i.id), ['11', '12']);
  assert.deepEqual(ids(await view.list('trending-movies', 1)), ['5', '1', '2', '7']);
  assert.deepEqual(ids(await view.search('dr')), [], 'Drama Longo (16) não aparece na busca');
  assert.deepEqual(ids(await view.search('aventura')), ['1']);
  assert.deepEqual(ids(await view.search('sem')), [], 'sem classificação fica de fora no modo família');
  assert.equal((await richCatalog.search('sem')).items.length, 1, 'e o catálogo completo continua achando');
  assert.deepEqual((await view.browse({ type: 'all' })).items.map(key).sort(), ['movie:1', 'movie:2', 'movie:5', 'movie:7', 'tv:11', 'tv:12']);
  assert.deepEqual((await view.browse({ type: 'tv' })).items.map(key).sort(), ['tv:11', 'tv:12']);

  assert.equal(view.lookup('movie', '1').title, 'Aventura Alta');
  for (const hidden of [['movie', '3'], ['movie', '4'], ['movie', '6'], ['tv', '10'], ['tv', '13']]) {
    assert.equal(view.lookup(...hidden), null, hidden.join(':'));
    assert.equal(view.info(...hidden), null, hidden.join(':'));
    assert.equal(view.detail(...hidden), null, hidden.join(':'));
    assert.notEqual(richCatalog.lookup(...hidden), null, 'o catálogo completo continua conhecendo');
  }
  assert.ok(view.detail('movie', '1').similar.every((item) => !['3', '4', '6'].includes(item.id)));
  assert.ok(view.similar('movie', '2').every((item) => view.lookup('movie', item.id)));

  assert.deepEqual(await view.seasons('10'), { seasons: [] });
  assert.deepEqual(await view.episodes('10', 1), { season: 1, episodes: [] });
  assert.deepEqual(await view.seasons('12'), { seasons: [1] });
  assert.equal(view.nextEpisode('10', 1, 1), null);
  assert.deepEqual(view.nextEpisode('12', 1, 1), { season: 1, episode: 2 });
  assert.equal(view.episodeCount('10'), null);
  assert.equal(view.episodeCount('12'), 5);
  assert.equal(view.hasTitle('Drama Longo'), null);
  assert.equal(view.hasTitle('Aventura Alta').id, '1');

  const { first, second, both } = view.recommend([28, 35]);
  for (const item of [...first, ...second, ...both]) assert.notEqual(view.lookup(item.type, item.id), null, `${key(item)} vazou na recomendação`);
  for (let i = 0; i < 20; i++) {
    const item = view.pick({ random: () => i / 20 });
    assert.notEqual(view.lookup(item.type, item.id), null, `${key(item)} vazou no sorteio`);
  }
});

test('modo família: diretor com poucos filmes na visão sai da lista, mas a página dele vale', async () => {
  const full = await richCatalog.directors();
  assert.deepEqual(full.items.map((d) => [d.id, d.count]), [['900', 3]]);
  const view = richCatalog.forRating(12);
  assert.deepEqual((await view.directors()).items, [], 'só 2 filmes visíveis (mínimo da lista: 3)');
  const page = await view.director('900');
  assert.deepEqual(ids(page), ['1', '2'], 'o filme de 16 anos não aparece');
  assert.equal(page.director.count, 2);
  assert.equal(await richCatalog.forRating(0).director('900').then((r) => r.items.length), 1);
});

test('modo família: uma visão de visão só restringe mais; a visão preserva `now` e `generatedAt`', async () => {
  const view = richCatalog.forRating(12);
  assert.deepEqual(ids(await view.forRating(10).list('library-movies', 1)), ['2', '7', '5']);
  assert.deepEqual(ids(await view.forRating(16).list('library-movies', 1)), ['1', '2', '7', '5'], 'não afrouxa além da visão de origem');
  // `now` (lançamentos): o filme 1 estreia em 2026-10-15, depois do `now` injetado (embora já passada no relógio real).
  assert.ok(!ids(await richCatalog.list('recent-movies', 1)).includes('1'));
  assert.ok(!ids(await view.list('recent-movies', 1)).includes('1'), 'a visão usa o mesmo relógio do catálogo');
  // `generatedAt` (novidades): o filme 1 entrou em 2026-09-30, dentro da janela da foto de 2026-10-01 (e fora da janela do `now`).
  assert.deepEqual(ids(await view.list('new-this-week', 1)), ['1']);
});

test('modo família: visão vazia (classificação ainda não coletada) responde lista vazia, não 503; catálogo vazio continua 503', async () => {
  const noRatings = createCatalog({ data: { movies: [movie(1, 'Sem Classificação')], series: [] }, now: () => NOW });
  assert.deepEqual((await noRatings.forRating(12).list('trending-movies', 1)).items, []);
  assert.deepEqual((await noRatings.forRating(12).search('sem')).items, []);
  assert.equal((await noRatings.list('trending-movies', 1)).items.length, 1);

  const empty = createCatalog({ data: { movies: [], series: [] }, now: () => NOW });
  await assert.rejects(empty.forRating(12).list('trending-movies', 1), { status: 503, code: 'catalog_empty' });
});
