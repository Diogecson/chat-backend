# Deploy no EasyPanel — passo a passo

## Pré-requisitos
- Backend está nos arquivos locais em `C:\Users\DG SOARES\UniFECAF\ChatBackend\`
- EasyPanel com projeto `plano_acao_high_performace` (onde já rodam n8n + Postgres)

---

## Opção 1 — Deploy via GitHub (recomendado)

### a) Sobe o código pro GitHub primeiro

```bash
cd "C:\Users\DG SOARES\UniFECAF\ChatBackend"
git init
git add .
git commit -m "chat-backend: esqueleto inicial"
# Cria repo privado no GitHub: chat-backend
git remote add origin git@github.com:SEU_USUARIO/chat-backend.git
git branch -M main
git push -u origin main
```

### b) No EasyPanel

1. Entra no projeto `plano_acao_high_performace`
2. Clica em **"+ Serviço"** → **"App"** (não Postgres, não n8n)
3. Nome: `chat-backend`
4. Aba **"Source"**:
   - Type: **GitHub**
   - Repo: `SEU_USUARIO/chat-backend`
   - Branch: `main`
   - Build Path: `/`
5. Aba **"Build"**:
   - Build Method: **Dockerfile** (ele vai detectar automático)
6. Aba **"Environment"** — adiciona as variáveis (veja seção "Variáveis de ambiente" abaixo)
7. Aba **"Domains"** — expõe a porta:
   - Port: `3100`
   - Host: `chat-backend-xxx.easypanel.host` (ele sugere)
8. Clica **"Deploy"**

---

## Opção 2 — Deploy via upload (sem GitHub)

1. Zipa a pasta ChatBackend (sem `node_modules` e sem `.env`)
2. EasyPanel → + Serviço → App → Source: **Upload**
3. Upload do zip
4. Resto igual ao da Opção 1 (env + domain)

---

## Processos (depois do deploy inicial)

Pra rodar os 3 processos (API + worker + cron), cria **3 serviços** usando o MESMO código:

| Serviço | CMD override | Domain? |
|---|---|---|
| `chat-backend-api` | (padrão) `node src/server.js` | Sim, porta 3100 |
| `chat-backend-worker` | `node src/workers/disparos.worker.js` | Não (não tem HTTP) |
| `chat-backend-cron` | `node src/crons/contadores.js` | Não |

Pra alterar CMD: aba **"Deployment"** → **"Start Command"** (ou similar no EasyPanel).

---

## Variáveis de ambiente (produção)

```env
# Server
PORT=3100
LOG_LEVEL=info

# DB (host INTERNO do Docker Swarm — não precisa SSL, não precisa túnel)
# Pega a senha no painel do EasyPanel > Postgres > Credenciais
DATABASE_URL=postgresql://postgres:SENHA_DO_POSTGRES@plano_acao_high_performace_postgresus:5432/plano_acao_high_performace

# Fila pg-boss usa o mesmo DB
QUEUE_DATABASE_URL=

# Meta
META_API_VERSION=v26.0

# Teste: começa em DRY_RUN pra não enviar nada de verdade
DRY_RUN=true
```

---

## Validação pós-deploy

Depois do primeiro deploy do `chat-backend-api`:

1. Abre no browser: `https://SEU_DOMINIO.easypanel.host/health`
   - Deve retornar `{"ok":true, "has_db": true, "dry_run": true, ...}`
2. Depois: `https://SEU_DOMINIO.easypanel.host/health/db`
   - Deve retornar `{"ok": true, "now": "..."}`
3. Se `/health/db` falhar, check:
   - Nome do host está correto? (ver `docker ps` na VPS)
   - Senha está certa?
   - Logs do serviço (EasyPanel → Logs)

---

## Próximos passos depois que /health/db funcionar

1. Implementar INSERT real em `/api/disparos/criar`
2. Enfileirar msgs no pg-boss
3. Subir o worker (serviço separado)
4. Testar E2E com DRY_RUN
5. Trocar DRY_RUN=false, testar com 1 número
6. Apontar o front disparos.html pro novo backend
