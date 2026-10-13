import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDomainChecker } from '../netlify/lib/email-domain.mjs';

// Resolver falso: cada domínio responde com registros ou com o erro que o c-ares devolveria.
function fakeResolver(zone) {
  const answer = (kind) => async (domain) => {
    const reply = zone[domain]?.[kind];
    if (reply instanceof Error) throw reply;
    if (reply === undefined) throw Object.assign(new Error('sem registro'), { code: 'ENODATA' });
    return reply;
  };
  return { resolveMx: answer('mx'), resolve4: answer('a'), resolve6: answer('aaaa') };
}

const dnsError = (code) => Object.assign(new Error(code), { code });

test('aprova domínio com MX, ou só com A/AAAA (o SMTP usa como MX implícito)', async () => {
  const accepts = createDomainChecker({
    resolver: fakeResolver({
      'com-mx.exemplo': { mx: [{ exchange: 'mx.exemplo', priority: 10 }] },
      'so-a.exemplo': { a: ['192.0.2.1'] },
      'so-aaaa.exemplo': { aaaa: ['2001:db8::1'] },
    }),
  });
  assert.equal(await accepts('com-mx.exemplo'), true);
  assert.equal(await accepts('so-a.exemplo'), true);
  assert.equal(await accepts('so-aaaa.exemplo'), true);
});

test('reprova domínio inexistente, sem registros ou com MX nulo (RFC 7505)', async () => {
  const accepts = createDomainChecker({
    resolver: fakeResolver({
      'nxdomain.exemplo': { mx: dnsError('ENOTFOUND'), a: dnsError('ENOTFOUND'), aaaa: dnsError('ENOTFOUND') },
      'vazio.exemplo': {},
      'mx-nulo.exemplo': { mx: [{ exchange: '', priority: 0 }], a: ['192.0.2.1'] },
    }),
  });
  assert.equal(await accepts('nxdomain.exemplo'), false);
  assert.equal(await accepts('vazio.exemplo'), false);
  assert.equal(await accepts('mx-nulo.exemplo'), false, 'MX nulo vale mesmo havendo registro A');
});

test('falha do próprio DNS não barra ninguém', async () => {
  for (const code of ['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED']) {
    const accepts = createDomainChecker({ resolver: fakeResolver({ 'qualquer.exemplo': { mx: dnsError(code) } }) });
    assert.equal(await accepts('qualquer.exemplo'), true, code);
  }
});
