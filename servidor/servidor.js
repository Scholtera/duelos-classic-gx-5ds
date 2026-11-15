'use strict';
// Retransmissor do duelo online (Render ou qualquer servidor Node). Não roda o duelo: só cria salas com código e
// repassa as mensagens entre o anfitrião (que roda o motor no PC dele) e o convidado. Não guarda nada em disco.
//
// Protocolo (WebSocket, uma mensagem JSON por quadro de texto):
//   anfitrião → {op:'criar', versao}              ← {op:'sala', codigo}
//   convidado → {op:'entrar', codigo, versao}     ← {op:'conectado'}   (o anfitrião recebe {op:'par'})
//   qualquer  → {op:'dados', d:'<texto>'}         → o outro recebe {op:'dados', d}
//   o outro saiu ou caiu                          ← {op:'saiu'}
//   anfitrião → {op:'expulsar'}                    (o convidado recebe {op:'saiu'}; a sala continua)
//   erros                                         ← {op:'erro', motivo}
const http = require('http');
const { WebSocketServer } = require('ws');

const PORTA = Number(process.env.PORT) || 10000;
const LIMITE_MSG = 2 * 1024 * 1024;              // estados do duelo chegam a algumas centenas de KB
const SALA_OCIOSA_MS = 2 * 60 * 60 * 1000;       // sala sem atividade some em 2 h
const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O e 1/I para não confundir
const salas = new Map();                          // codigo → { anfitriao, convidado, versao, ultimo }
let total = { salas: 0, conexoes: 0 };

function novoCodigo() {
  for (;;) { let c = ''; for (let i = 0; i < 6; i++) c += LETRAS[Math.floor(Math.random() * LETRAS.length)]; if (!salas.has(c)) return c; }
}
const enviar = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

const servidor = http.createServer((req, res) => {
  // Página simples: o Render usa para saber se o serviço está no ar (e ela "acorda" o plano gratuito).
  if (req.url === '/saude') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, salas: salas.size })); }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`Retransmissor do Duelos Classic GX 5D's no ar. Salas abertas: ${salas.size}.`);
});
const wss = new WebSocketServer({ server: servidor, maxPayload: LIMITE_MSG });

wss.on('connection', ws => {
  total.conexoes++;
  ws.vivo = true; ws.sala = null; ws.papel = null;
  ws.on('pong', () => { ws.vivo = true; });
  ws.on('message', (bruto, binario) => {
    if (binario) return;
    let m; try { m = JSON.parse(bruto.toString()); } catch { return enviar(ws, { op: 'erro', motivo: 'Mensagem inválida.' }); }
    const s = ws.sala && salas.get(ws.sala);
    if (s) s.ultimo = Date.now();
    if (m.op === 'criar' && !ws.sala) {
      const codigo = novoCodigo();
      salas.set(codigo, { anfitriao: ws, convidado: null, versao: String(m.versao || ''), ultimo: Date.now() });
      ws.sala = codigo; ws.papel = 'anfitriao'; total.salas++;
      return enviar(ws, { op: 'sala', codigo });
    }
    if (m.op === 'entrar' && !ws.sala) {
      const codigo = String(m.codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const alvo = salas.get(codigo);
      if (!alvo) return enviar(ws, { op: 'erro', motivo: 'Sala não encontrada. Confira o código com o anfitrião.' });
      if (alvo.convidado) return enviar(ws, { op: 'erro', motivo: 'A sala já tem um convidado.' });
      alvo.convidado = ws; ws.sala = codigo; ws.papel = 'convidado';
      enviar(ws, { op: 'conectado' }); enviar(alvo.anfitriao, { op: 'par' });
      return;
    }
    if (m.op === 'dados' && s && typeof m.d === 'string') {
      const outro = ws.papel === 'anfitriao' ? s.convidado : s.anfitriao;
      return enviar(outro, { op: 'dados', d: m.d });
    }
    if (m.op === 'sair') return sair(ws);
    // o anfitrião recusou/derrubou o convidado: só o convidado sai, a sala continua aberta
    if (m.op === 'expulsar' && s && ws.papel === 'anfitriao' && s.convidado) { const c = s.convidado; s.convidado = null; c.sala = null; enviar(c, { op: 'saiu' }); try { c.close(); } catch { /* ignora */ } }
  });
  ws.on('close', () => sair(ws));
  ws.on('error', () => {});
});

// Quem sai: se for o convidado, a sala continua aberta para outro; se for o anfitrião, a sala acaba.
function sair(ws) {
  const s = ws.sala && salas.get(ws.sala);
  if (!s) return;
  if (ws.papel === 'convidado' && s.convidado === ws) { s.convidado = null; enviar(s.anfitriao, { op: 'saiu' }); }
  if (ws.papel === 'anfitriao' && s.anfitriao === ws) { enviar(s.convidado, { op: 'saiu' }); try { s.convidado && s.convidado.close(); } catch { /* ignora */ } salas.delete(ws.sala); }
  ws.sala = null;
}

// Mantém as conexões vivas (proxies fecham WebSocket parado) e limpa salas abandonadas.
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.vivo) { ws.terminate(); continue; } ws.vivo = false; try { ws.ping(); } catch { /* ignora */ } }
  const agora = Date.now();
  for (const [c, s] of salas) if (agora - s.ultimo > SALA_OCIOSA_MS) { enviar(s.anfitriao, { op: 'erro', motivo: 'Sala encerrada por inatividade.' }); enviar(s.convidado, { op: 'saiu' }); try { s.anfitriao.close(); } catch { /* */ } salas.delete(c); }
}, 25000).unref();

servidor.listen(PORTA, () => console.log(`Retransmissor ouvindo na porta ${PORTA}`));
module.exports = { servidor, salas };
