import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const text = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

// app.js é script de navegador (sem exports): extrai os trechos puros e os executa isolados.
async function load() {
  const app = await text('public/app.js');
  const modesLiteral = app.match(/const SANDBOX_MODES = (\{[\s\S]*?\n\});\nconst DEFAULT_SANDBOX = '(\w[\w-]*)';/);
  assert.ok(modesLiteral, 'SANDBOX_MODES / DEFAULT_SANDBOX não encontrados em app.js');
  const modes = new Function(`return ${modesLiteral[1]}`)();
  const loader = app.match(/function loadSandboxMode\(\) \{[\s\S]*?\n\}/)[0];
  const loadMode = (stored) => new Function('readStore', 'SANDBOX_MODES', 'DEFAULT_SANDBOX', `${loader}; return loadSandboxMode();`)(() => stored, modes, modesLiteral[2]);
  return { app, modes, defaultMode: modesLiteral[2], loadMode };
}

test('o sandbox vem desligado por padrão (o provedor já recusou tocar sob sandbox)', async () => {
  const { modes, defaultMode } = await load();
  assert.equal(defaultMode, 'off');
  assert.equal(modes.off.flags, null);
});

test('nenhuma variação libera navegação da página principal nem pop-up fora do sandbox', async () => {
  const { modes } = await load();
  for (const [name, mode] of Object.entries(modes)) {
    if (mode.flags === null) continue;
    const flags = mode.flags.split(' ');
    assert.ok(flags.includes('allow-scripts'), `${name}: o player precisa de allow-scripts`);
    for (const flag of flags) {
      assert.match(flag, /^allow-[a-z-]+$/, `${name}: flag inesperada ${flag}`);
      assert.ok(!flag.startsWith('allow-top-navigation'), `${name}: ${flag} deixaria o iframe redirecionar a página`);
      assert.notEqual(flag, 'allow-popups-to-escape-sandbox', `${name}: o anúncio abriria fora do sandbox`);
    }
    assert.ok(mode.label && mode.hint, `${name}: falta rótulo/explicação para a tela`);
  }
});

test('só a variação "redirect-only" libera pop-up, e a explicação diz que as abas continuam abrindo', async () => {
  const { modes } = await load();
  const withPopups = Object.entries(modes).filter(([, mode]) => mode.flags?.split(' ').includes('allow-popups'));
  assert.deepEqual(withPopups.map(([name]) => name), ['redirect-only']);
  assert.match(modes['redirect-only'].hint, /NÃO impede abas/);
});

test('a variação guardada no aparelho só vale se existir; qualquer outra coisa volta ao padrão', async () => {
  const { loadMode } = await load();
  assert.equal(loadMode({ mode: 'block' }), 'block');
  assert.equal(loadMode({ mode: 'block-forms' }), 'block-forms');
  for (const bad of [{}, { mode: 'inexistente' }, { mode: 'constructor' }, { mode: '__proto__' }, { mode: 'toString' }, { mode: 5 }, { mode: null }, { mode: ['block'] }]) {
    assert.equal(loadMode(bad), 'off', JSON.stringify(bad));
  }
});

test('o iframe da tela do filme usa o sandbox escolhido e continua pedindo só o que o player precisa', async () => {
  const { app } = await load();
  const frame = app.match(/el\('iframe', \{([\s\S]*?)\n\s*\}\)/)[1];
  assert.match(frame, /sandbox: SANDBOX_MODES\[sandboxMode\]\.flags/);
  assert.match(frame, /allow: 'autoplay; fullscreen; encrypted-media; picture-in-picture'/);
  assert.equal(app.match(/el\('iframe'/g).length, 1, 'o iframe do player deve ser criado em um lugar só');
});

test('a guarda contra redirecionamento só pergunta na tela do filme e não repete depois do "Sair" confirmado', async () => {
  const { app } = await load();
  assert.match(app, /window\.addEventListener\('beforeunload', onWatchBeforeUnload\)/);
  const handler = app.match(/function onWatchBeforeUnload\(event\) \{([\s\S]*?)\n\}/)[1];
  assert.match(handler, /if \(!watchGuard \|\| watchGuard\.leaving\) return;/);
  assert.match(handler, /event\.preventDefault\(\)/);

  // watchGuard é zerado a cada rota; "leaving" é marcado só depois de a pessoa confirmar a saída.
  assert.match(app, /function route\(\) \{[\s\S]*?watchGuard = null;/);
  assert.match(app, /if \(!leave \|\| !watchGuard\) return;\n\s*watchGuard\.leaving = true;/);
});

test('a TV continua sem sandbox: lá ninguém clica no player, e o tv-player.js é ES5 validado por outro teste', async () => {
  const [tvPlayer, receiver] = await Promise.all([text('public/tv-player.js'), text('public/receiver.js')]);
  assert.ok(!/sandbox/.test(tvPlayer.replace(/\/\*[\s\S]*?\*\//g, '')), 'tv-player.js não deve ganhar sandbox sem teste com o player no ar');
  assert.ok(!/sandbox/.test(receiver));
});
