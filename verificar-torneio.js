'use strict';
// Conferência automática do torneio. Roda no GitHub Actions (grátis), NUNCA no navegador do jogador.
// Para cada partida enviada: refaz a partida a partir do log, calcula a pontuação sozinho e só então publica no ranking.
// A pontuação que o navegador mandou é ignorada se não bater com o replay.
const fs = require('fs'), crypto = require('crypto');

const ARQ = process.env.TORNEIO_HTML || 'torneio.html';   // cópia do torneio.html publicado, neste repositório
const SITE = process.env.SITE_URL || '';                   // endereço do torneio.html NO AR (preenchido no conferir-torneio.yml)
const DB_URL = process.env.DATABASE_URL || '';             // endereço do Realtime Database (preenchido no conferir-torneio.yml)
const DRY = /^(1|true)$/i.test(process.env.DRY || '');                       // DRY=true: só mostra o que faria, sem gravar nada

const fatiaSim = html => {
  const a = html.indexOf('const W=800,H=600'), b = html.indexOf('window.verificarPartida=verificar;');
  if (a < 0 || b < a) throw new Error('Não achei a simulação no torneio.html');
  return html.slice(a, b);
};
const montarSim = codigo => new Function('location', 'URLSearchParams',
  codigo + '\nreturn {verificar,SEED_T,TICKS};')({ search: '' }, class { get() { return null; } });
const hash = t => crypto.createHash('sha256').update(t).digest('hex');

// Devolve {ok, calc, motivo}. v = {pontos,cod,k,em} gravado pelo jogador.
function conferir(sim, v) {
  try {
    if (!v || typeof v.cod !== 'string' || !Number.isFinite(v.pontos)) return { ok: false, motivo: 'formato' };
    const res = JSON.parse(Buffer.from(v.cod, 'base64').toString('utf8'));
    if (res.seed !== sim.SEED_T) return { ok: false, motivo: 'semente diferente' };
    const k = v.k === undefined ? res.k : v.k;              // partidas gravadas antes das regras novas não têm o campo k
    if (!Number.isInteger(k) || res.k !== k) return { ok: false, motivo: 'k diferente' };
    const r = sim.verificar(res.log, res.k);              // mesma função do jogo (valida o log antes de simular)
    if (r.s < 0) return { ok: false, motivo: 'log inválido' };
    if (r.s !== v.pontos || r.s !== res.s) return { ok: false, calc: r.s, motivo: 'pontuação não confere' };
    return { ok: true, calc: r.s };
  } catch (e) { return { ok: false, motivo: 'erro ao ler a partida' }; }
}

async function pool(itens, n, fn) { const it = itens[Symbol.iterator](); await Promise.all(Array.from({ length: n }, async () => { for (let x = it.next(); !x.done; x = it.next()) await fn(x.value); })); }

async function main() {
  if (!/^https:\/\//.test(SITE) || !/^https:\/\//.test(DB_URL))
    throw new Error('Preencha SITE_URL e DATABASE_URL no arquivo .github/workflows/conferir-torneio.yml (os dois precisam começar com https://)');
  const codigo = fatiaSim(fs.readFileSync(ARQ, 'utf8'));
  const vivo = await fetch(SITE, { headers: { 'cache-control': 'no-cache' } });
  if (!vivo.ok) throw new Error('Não consegui abrir ' + SITE + ' (' + vivo.status + ')');
  if (hash(fatiaSim(await vivo.text())) !== hash(codigo))
    throw new Error('A simulação do site no ar é diferente da deste repositório. Atualize o torneio.html do repositório antes de conferir.');
  const sim = montarSim(codigo), TID = String(sim.SEED_T), meu = tk => tk === TID || tk.startsWith(TID + '_');

  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)), databaseURL: DB_URL });
  const db = admin.database();

  const tent = (await db.ref('torneioTentativas').once('value')).val() || {};
  const conf = (await db.ref('torneioConferidas').once('value')).val() || {};
  const fila = [];
  for (const tk of Object.keys(tent)) if (meu(tk)) for (const uid of Object.keys(tent[tk]))
    for (let n = 1; n <= (+tent[tk][uid] || 0) && n <= 3; n++) if (!(conf[tk] && conf[tk][uid] && conf[tk][uid][n])) fila.push({ tk, uid, n: String(n) });

  let novas = 0, invalidas = 0;
  await pool(fila, 8, async ({ tk, uid, n }) => {
    const v = (await db.ref(`torneioPartidas/${tk}/${uid}/${n}`).once('value')).val();
    if (!v) return;                                        // tentativa reservada, partida ainda não enviada
    const r = conferir(sim, v);
    novas++; if (!r.ok) { invalidas++; console.log('INVÁLIDA', tk, uid, n, r.motivo, 'enviado=' + v.pontos, 'calculado=' + r.calc); }
    ((conf[tk] = conf[tk] || {})[uid] = conf[tk][uid] || {})[n] = { ok: r.ok, pontos: v.pontos, calc: r.calc == null ? null : r.calc, em: v.em || null, motivo: r.motivo || null };
    if (!DRY) await db.ref(`torneioConferidas/${tk}/${uid}/${n}`).set(Object.assign({}, conf[tk][uid][n], { quando: admin.database.ServerValue.TIMESTAMP }));
  });

  // melhor partida VÁLIDA de cada jogador (empate: quem registrou primeiro)
  const melhor = {};
  for (const tk of Object.keys(conf)) if (meu(tk)) for (const uid of Object.keys(conf[tk])) for (const n of Object.keys(conf[tk][uid])) {
    const c = conf[tk][uid][n]; if (!c.ok) continue;
    const m = melhor[uid], em = c.em == null ? Infinity : c.em;
    if (!m || c.pontos > m.pontos || (c.pontos === m.pontos && em < m.em)) melhor[uid] = { pontos: c.pontos, tk, n, em };
  }
  const atual = (await db.ref('torneioRanking/' + TID).once('value')).val() || {}, upd = {};
  for (const uid of Object.keys(melhor)) {
    const m = melhor[uid], a = atual[uid];
    if (a && a.pontos === m.pontos && a.tk === m.tk && a.n === m.n) continue;
    const nome = (await db.ref(`usuarios/${uid}/nome`).once('value')).val();
    if (!nome) { console.log('sem nome de usuário, ignorado:', uid); continue; }
    upd[`torneioRanking/${TID}/${uid}`] = { nome, pontos: m.pontos, tk: m.tk, n: m.n, em: m.em === Infinity ? Date.now() : m.em };
  }
  for (const uid of Object.keys(atual)) if (!melhor[uid]) upd[`torneioRanking/${TID}/${uid}`] = null; // entrada sem partida válida (ex.: gravada antes das regras novas)
  const chaves = Object.keys(upd);
  console.log(`partidas novas: ${novas} | inválidas: ${invalidas} | mudanças no ranking: ${chaves.length}${DRY ? ' (DRY: nada foi gravado)' : ''}`);
  if (!DRY) for (let i = 0; i < chaves.length; i += 400) { const parte = {}; chaves.slice(i, i + 400).forEach(k => parte[k] = upd[k]); await db.ref().update(parte); }
  await admin.app().delete();
}

module.exports = { fatiaSim, montarSim, conferir };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
