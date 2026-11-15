# Retransmissor do duelo online

Servidor pequeno (Node + `ws`) que liga os dois jogadores do **Duelos Classic GX 5D's** pela internet, sem abrir portas no roteador.

- O anfitrião cria a sala e recebe um **código de 6 caracteres**; o convidado entra com esse código.
- O servidor **não roda o duelo** nem guarda nada: só repassa as mensagens. O motor de regras continua no PC do anfitrião.
- Uma sala tem um anfitrião e um convidado. Ela some quando o anfitrião sai ou depois de 2 horas sem atividade.

## No Render

1. Em <https://dashboard.render.com>: **New → Blueprint** e escolha este repositório (o `render.yaml` na raiz cria o serviço `duelos-online`, plano gratuito).
2. Depois do deploy, o endereço fica parecido com `https://duelos-online.onrender.com`. No jogo, ele vai em `src/main/publicacao.json` como `wss://duelos-online.onrender.com`.
3. Plano gratuito: o serviço "dorme" depois de 15 minutos sem uso e leva até ~1 minuto para acordar na primeira conexão (o jogo avisa e espera).

## Rodar localmente

```bash
npm install
```

```bash
npm start
```

Ouve na porta `PORT` (padrão 10000). `GET /saude` responde `{"ok":true,"salas":N}`.
