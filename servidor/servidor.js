'use strict';
// Retransmissor do duelo online (Render ou qualquer servidor Node). Não roda o duelo: só cria salas com código e
// repassa as mensagens entre o anfitrião (que roda o motor no PC dele) e o convidado. Não guarda nada em disco.
//
// Protocolo (WebSocket, uma mensagem JSON por quadro de texto):
//   anfitrião → {op:'criar', versao, chave, publica, nome, deck}   ← {op:'sala', codigo}
//   anfitrião → {op:'retomar', codigo, chave}   (reconecta após queda) ← {op:'sala', codigo, retomada:true}
//   anfitrião → {op:'publica', valor}           (mostra/esconde a sala em "Procurar partida")
//   anfitrião → {op:'encerrar'}                 (fecha a sala de propósito)
//   anfitrião → {op:'expulsar'}                 (o convidado recebe {op:'saiu'}; a sala continua)
//   qualquer  → {op:'listar', versao}           ← {op:'salas', lista:[{codigo, nome, deck, esperando}]}
//   convidado → {op:'entrar', codigo, versao}   ← {op:'conectado'}   (o anfitrião recebe {op:'par'})
//   convidado → {op:'sair'}
//   qualquer  → {op:'dados', d:'<texto>'}       → o outro recebe {op:'dados', d}
//   o convidado saiu/caiu                       ← anfitrião recebe {op:'saiu'}
//   o anfitrião caiu (sala guardada por 2 min)  ← convidado recebe {op:'anfitriao-caiu'}; quando ele volta, {op:'anfitriao-voltou'}
//   erros                                       ← {op:'erro', motivo}
const http = require('http');
const { WebSocketServer } = require('ws');

const PORTA = Number(process.env.PORT) || 10000;
const LIMITE_MSG = 2 * 1024 * 1024;              // estados do duelo chegam a algumas centenas de KB
const SALA_OCIOSA_MS = 2 * 60 * 60 * 1000;       // sala sem atividade some em 2 h
const ORFA_MS = Number(process.env.ORFA_MS) || 2 * 60 * 1000;   // anfitrião caiu: a sala espera ele voltar por 2 min
const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O e 1/I para não confundir
const salas = new Map();   // codigo → { anfitriao, convidado, versao, chave, publica, nome, deck, desde, ultimo, orfaAte }

function novoCodigo() {
  for (;;) { let c = ''; for (let i = 0; i < 6; i++) c += LETRAS[Math.floor(Math.random() * LETRAS.length)]; if (!salas.has(c)) return c; }
}
const enviar = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const texto = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

const servidor = http.createServer((req, res) => {
  // Página simples: o Render usa para saber se o serviço está no ar (e ela "acorda" o plano gratuito).
  if (req.url === '/saude') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, salas: salas.size })); }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`Retransmissor do Duelos Classic GX 5D's no ar. Salas abertas: ${salas.size}.`);
});
const wss = new WebSocketServer({ server: servidor, maxPayload: LIMITE_MSG });

function apagar(codigo, motivoConvidado = 'saiu') {
  const s = salas.get(codigo); if (!s) return;
  if (s.convidado) { enviar(s.convidado, { op: motivoConvidado }); s.convidado.sala = null; try { s.convidado.close(); } catch { /* ignora */ } }
  if (s.anfitriao) s.anfitriao.sala = null;
  salas.delete(codigo);
}

wss.on('connection', ws => {
  ws.vivo = true; ws.sala = null; ws.papel = null;
  ws.on('pong', () => { ws.vivo = true; });
  ws.on('message', (bruto, binario) => {
    if (binario) return;
    let m; try { m = JSON.parse(bruto.toString()); } catch { return enviar(ws, { op: 'erro', motivo: 'Mensagem inválida.' }); }
    const s = ws.sala && salas.get(ws.sala);
    if (s) s.ultimo = Date.now();
    if (m.op === 'criar' && !ws.sala) {
      const codigo = novoCodigo();
      salas.set(codigo, { anfitriao: ws, convidado: null, versao: texto(m.versao, 60), chave: texto(m.chave, 64), publica: !!m.publica,
        nome: texto(m.nome, 24) || 'Duelista', deck: texto(m.deck, 40), desde: Date.now(), ultimo: Date.now(), orfaAte: 0 });
      ws.sala = codigo; ws.papel = 'anfitriao';
      return enviar(ws, { op: 'sala', codigo });
    }
    if (m.op === 'retomar' && !ws.sala) {
      const codigo = texto(m.codigo, 6).toUpperCase(), alvo = salas.get(codigo);
      if (!alvo || !alvo.chave || alvo.chave !== texto(m.chave, 64)) return enviar(ws, { op: 'erro', motivo: 'Não foi possível retomar a sala (ela expirou).' });
      // a conexão antiga ainda pode parecer viva (o proxy demora a avisar a queda): a chave secreta prova que é o mesmo anfitrião
      if (alvo.anfitriao && alvo.anfitriao !== ws) { const velho = alvo.anfitriao; velho.sala = null; try { velho.terminate(); } catch { /* ignora */ } }
      alvo.anfitriao = ws; alvo.orfaAte = 0; alvo.ultimo = Date.now(); ws.sala = codigo; ws.papel = 'anfitriao';
      enviar(ws, { op: 'sala', codigo, retomada: true });
      if (alvo.convidado) { enviar(alvo.convidado, { op: 'anfitriao-voltou' }); enviar(ws, { op: 'par', retomado: true }); }
      return;
    }
    if (m.op === 'listar') {
      const v = texto(m.versao, 60), agora = Date.now();
      const lista = [...salas.entries()].filter(([, x]) => x.publica && x.anfitriao && !x.convidado && (!v || x.versao === v))
        .sort((a, b) => b[1].desde - a[1].desde).slice(0, 30)
        .map(([codigo, x]) => ({ codigo, nome: x.nome, deck: x.deck, esperando: Math.round((agora - x.desde) / 1000) }));
      return enviar(ws, { op: 'salas', lista });
    }
    if (m.op === 'entrar' && !ws.sala) {
      const codigo = String(m.codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const alvo = salas.get(codigo);
      if (!alvo) return enviar(ws, { op: 'erro', motivo: 'Sala não encontrada. Confira o código com o anfitrião.' });
      if (alvo.convidado) return enviar(ws, { op: 'erro', motivo: 'A sala já tem um convidado.' });
      if (!alvo.anfitriao) return enviar(ws, { op: 'erro', motivo: 'O anfitrião está reconectando. Tente de novo em alguns segundos.' });
      alvo.convidado = ws; ws.sala = codigo; ws.papel = 'convidado';
      enviar(ws, { op: 'conectado' }); enviar(alvo.anfitriao, { op: 'par' });
      return;
    }
    if (m.op === 'dados' && s && typeof m.d === 'string') {
      const outro = ws.papel === 'anfitriao' ? s.convidado : s.anfitriao;
      return enviar(outro, { op: 'dados', d: m.d });
    }
    if (m.op === 'publica' && s && ws.papel === 'anfitriao') { s.publica = !!m.valor; return; }
    if (m.op === 'encerrar' && s && ws.papel === 'anfitriao') return apagar(ws.sala);
    if (m.op === 'sair') return sair(ws);
    // o anfitrião recusou/derrubou o convidado: só o convidado sai, a sala continua aberta
    if (m.op === 'expulsar' && s && ws.papel === 'anfitriao' && s.convidado) { const c = s.convidado; s.convidado = null; c.sala = null; enviar(c, { op: 'saiu' }); try { c.close(); } catch { /* ignora */ } }
  });
  ws.on('close', () => sair(ws, true));
  ws.on('error', () => {});
});

// Convidado saiu: a sala continua aberta para outro (ou para ele voltar). Anfitrião caiu sem "encerrar": a sala
// fica guardada por ORFA_MS para ele reconectar; se não voltar, acaba.
function sair(ws, queda = false) {
  const s = ws.sala && salas.get(ws.sala);
  if (!s) return;
  if (ws.papel === 'convidado' && s.convidado === ws) { s.convidado = null; enviar(s.anfitriao, { op: 'saiu' }); }
  if (ws.papel === 'anfitriao' && s.anfitriao === ws) {
    if (queda && s.chave) { s.anfitriao = null; s.orfaAte = Date.now() + ORFA_MS; enviar(s.convidado, { op: 'anfitriao-caiu' }); }
    else { apagar(ws.sala); return; }
  }
  ws.sala = null;
}

// Mantém as conexões vivas (proxies fecham WebSocket parado) e limpa salas abandonadas.
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.vivo) { ws.terminate(); continue; } ws.vivo = false; try { ws.ping(); } catch { /* ignora */ } }
  const agora = Date.now();
  for (const [c, s] of salas) {
    if (s.orfaAte && agora > s.orfaAte) apagar(c);
    else if (agora - s.ultimo > SALA_OCIOSA_MS) { enviar(s.anfitriao, { op: 'erro', motivo: 'Sala encerrada por inatividade.' }); try { s.anfitriao && s.anfitriao.close(); } catch { /* */ } apagar(c); }
  }
}, Number(process.env.VARREDURA_MS) || 25000).unref();

servidor.listen(PORTA, () => console.log(`Retransmissor ouvindo na porta ${PORTA}`));
module.exports = { servidor, salas };
