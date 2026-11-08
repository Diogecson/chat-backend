# ChatBackend — substituto do n8n (fase MVP: disparos)

Backend Node em Fastify + Postgres + pg-boss pra substituir os workflows n8n de disparos (e, depois, o resto do ChatMultiConta).

## Stack
- **Node 20+** (type: module)
- **Fastify 5** — HTTP server
- **pg** — driver Postgres puro
- **pg-boss** — fila confiável em cima do próprio Postgres (sem Redis)
- **pino-pretty** — logs

## Estrutura

```
src/
├── config.js              # lê .env
├── server.js              # entrypoint HTTP (rotas)
├── routes/
│   ├── health.js
│   └── disparos.js        # /api/disparos/*
├── services/
│   ├── db.js              # pool Postgres
│   ├── queue.js           # pg-boss
│   └── meta.js            # cliente Meta Cloud API
├── workers/
│   └── disparos.worker.js # consome fila "disparos"
└── crons/
    └── contadores.js      # atualiza enviadas/falharam + cleanup em_envio
```

## Setup local

```bash
cd ChatBackend
npm install
cp .env.example .env     # deixe DATABASE_URL vazio por enquanto
npm run dev              # servidor sobe em http://localhost:3100
```

Teste:
- http://localhost:3100/ — info
- http://localhost:3100/health — status básico
- http://localhost:3100/health/db — 503 enquanto .env sem DB

## Próximos passos (feitos aos poucos)

1. ✅ Esqueleto HTTP + health
2. ✅ Rota POST /api/disparos/criar (valida, retorna skeleton)
3. ⏳ Conectar Postgres do EasyPanel (preencher DATABASE_URL)
4. ⏳ Implementar INSERT real em chat_disparos + chat_disparos_msgs
5. ⏳ Enfileirar msgs no pg-boss
6. ⏳ Worker consumir fila + chamar Meta + atualizar status (concurrency=1)
7. ⏳ Testar com DRY_RUN=true
8. ⏳ Ligar com Meta real
9. ⏳ Apontar front disparos.html pra http://backend/api/disparos/criar
10. ⏳ Deploy no EasyPanel

## Processos (rodar separados)

```bash
npm start           # HTTP API (porta 3100)
npm run worker      # worker de disparos
npm run cron        # cron de contadores (a cada 2min)
```

Em produção, cada um vira um service separado no EasyPanel.
