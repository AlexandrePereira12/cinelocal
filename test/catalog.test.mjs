import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalog, parseCards } from '../netlify/lib/catalog.mjs';

const card = (id, title, { poster = 'abc.jpg', top = 'HD', bottom = '100 Min', suffix = '' } = {}) => `
  <div class="card movie-card p-5 border-0 mb-10">
    <div class="front"><div class="poster-img lazy" data-bg-multi="linear-gradient(a), url(https://tmdb.img.cinemaplay.top/tmdb/w300/${poster})"></div>
      <div class="top"><span>${top}</span></div><div class="bottom"><span>${bottom}</span></div></div>
    <div class="back"><p class="title mt-0">
      ${title}
    </p><a href="https://embedplayapi.top/embed/${id}${suffix}">play</a></div>
  </div>`;

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) });

test('parseCards extrai campos, decodifica entidades e deduplica', () => {
  const html = card('1', 'All the Queen&#039;s Men - 2021') + card('1', 'repetido - 2021') + card('2', 'Top - 2019', { top: '8.5' });
  const items = parseCards(html, 'movie');
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { id: '1', type: 'movie', title: "All the Queen's Men", year: '2021', poster: '/abc.jpg', quality: 'HD', rating: null, runtime: 100 });
  assert.equal(items[1].rating, 8.5);
  assert.equal(items[1].quality, null);
});

test('parseCards na busca: link com /T/E ou sem runtime é série', () => {
  const html = card('3', 'Serie - 2020', { top: '', bottom: '' }) + card('4', 'Filme - 2020') + card('5', 'Ep - 2022', { suffix: '/6/11' });
  assert.deepEqual(parseCards(html, null).map((i) => i.type), ['tv', 'movie', 'tv']);
});

test('parseCards ignora pôster fora do padrão', () => {
  const [item] = parseCards(card('1', 'X - 2020', { poster: '../../evil.jpg' }), 'movie');
  assert.equal(item.poster, null);
});

test('bloqueio do upstream vira erro claro, não catálogo vazio', async () => {
  for (const status of [403, 429, 503]) {
    const catalog = createCatalog({ fetchImpl: async () => response('', status) });
    await assert.rejects(catalog.list('trending-movies', 1), { status: 502, code: 'upstream_blocked' });
  }
  const challenge = createCatalog({ fetchImpl: async () => response('<html>Just a moment...</html>') });
  await assert.rejects(challenge.list('trending-movies', 1), { status: 502, code: 'upstream_blocked' });
  const down = createCatalog({ fetchImpl: async () => { throw new Error('rede'); } });
  await assert.rejects(down.list('trending-movies', 1), { status: 502 });
});

test('lista desconhecida é 404 e busca vazia é válida', async () => {
  const catalog = createCatalog({ fetchImpl: async () => response('') });
  await assert.rejects(catalog.list('nao-existe', 1), { status: 404 });
  assert.deepEqual(await catalog.search('sem resultado'), { items: [] });
});

test('descobre temporadas e episódios por sondagem em lotes', async () => {
  const existing = new Set(['1:1', '1:2', '1:3', '2:1', '2:2']); // temporada:episódio
  const probes = [];
  const fetchImpl = async (url) => {
    const q = new URL(url).searchParams;
    probes.push(url);
    return response(JSON.stringify({ status: existing.has(`${q.get('sea')}:${q.get('epi')}`) ? 'success' : 'failed' }));
  };
  const catalog = createCatalog({ fetchImpl });
  assert.deepEqual(await catalog.seasons('1396'), { seasons: [1, 2] });
  assert.deepEqual(await catalog.episodes('1396', 1), { season: 1, episodes: [1, 2, 3] });
  const before = probes.length;
  await catalog.episodes('1396', 1);
  assert.equal(probes.length, before, 'segunda chamada vem do cache');
});

test('sondagem de episódios respeita o teto por invocação', async () => {
  let calls = 0;
  const catalog = createCatalog({ fetchImpl: async () => (calls++, response(JSON.stringify({ status: 'success' }))) });
  const { episodes } = await catalog.episodes('1', 1);
  assert.equal(episodes.length, 100);
  assert.equal(calls, 100);
});
