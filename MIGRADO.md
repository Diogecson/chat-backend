# Endpoints migrados do n8n → backend novo

Status da migração ChatMultiConta: n8n → Node/Fastify/pg-boss.

**Como funciona**: o backend novo registra os mesmos paths `/webhook/chat-*` que o chat.html já chama. Essas rotas interceptam ANTES do proxy pro n8n. Então o chat.html NÃO MUDA — só fica mais rápido.

## ✅ Migrados (24 endpoints)

### Leitura — rodam direto no Postgres (muito mais rápido)
- `chat-conversas` — lista da sidebar (**as abas Minhas/Livres/Todas**)
- `chat-conversas-delta` — polling incremental
- `chat-contadores` — badges das abas
- `chat-mensagens` — msgs ao abrir conversa
- `chat-mensagens-delta` — polling de msgs novas
- `chat-ping` — presença dos atendentes
- `chat-link-versao-get` — versão do app
- `chat-contas-list` — contas Meta/Evolution
- `chat-atendentes-list` — lista de consultores
- `chat-motivos-list` — motivos de fechamento
- `chat-etiquetas-list` — etiquetas em uso
- `chat-respostas-list` — respostas rápidas
- `chat-retorno-list` — retornos agendados
- `chat-triagem-ativas` — sessões ativas
- `chat-triagem-config-list` — configs de triagem
- `chat-manual-nos-list` — nós do manual
- `chat-manual-estado-get` — estado do manual por usuário
- `chat-permissoes-list` — features habilitadas
- `chat-stickers-list` — stickers disponíveis
- `chat-eventos-list` — histórico de eventos
- `chat-tarefas-get` — tarefas da conversa
- `chat-conversas-finalizadas` — aba finalizadas
- `chat-buscar-mensagens` — busca por texto

### Escrita — ações do usuário
- `chat-conversa-finalizar`
- `chat-conversa-reabrir`
- `chat-conversa-transferir`
- `chat-conversa-delete`
- `chat-conversa-etiqueta-add`
- `chat-contato-save`
- `chat-evento-registrar`
- `chat-tarefas-toggle`
- `chat-manual-estado-set`
- `chat-retorno-criar`
- `chat-retorno-concluir`
- `chat-triagem-ativar-conversa`
- `chat-triagem-desativar-conversa`
- `chat-atendentes-save`

### Autenticação
- `chat-login` — mesma tabela chat_atendentes

### Disparos (novo endpoint com fila pg-boss)
- `POST /api/disparos/criar` — grava + enfileira
- `POST /api/disparos/reenfileirar`
- `POST /api/disparos/:codigo/cancelar`
- `GET /api/disparos/list`
- `GET /api/disparos/:codigo`
- Worker `/webhook/chat-disparos-criar` → hoje ainda passa pelo n8n
  (trocar depois no disparos.html quando quiser)

## 🔄 Ainda via proxy pro n8n (mantém funcionando)

Tudo que não foi migrado continua passando pelo proxy `/webhook/*` → n8n antigo. Lista do que falta migrar quando quiser:

### Enviar/receber msgs
- `chat-enviar` — Meta API + grava chat_mensagens (lógica complexa)
- `chat-sticker-meta-enviar`
- `chat-stickers-upload`, `chat-stickers-delete`, `chat-stickers-favorito`, `chat-stickers-uso`

### IA
- `chat-ia-atendimento-executar` — Claude/Groq
- `chat-ia-atendimento-preview`
- `chat-ia-atendimento-toggle`
- `chat-corrigir-texto` — Claude
- `chat-transcrever-msg` — Groq Whisper

### Templates Meta (precisa chamar Meta Graph API)
- `chat-templates`

### HubSpot
- `chat-finalizar-massa-hubspot`

### Distribuição manual
- `chat-conversas-distribuir`

### Disparos (criar campanha via webhook antigo)
- `chat-disparos-criar` — já tem endpoint equivalente em `/api/disparos/criar`
  (trocar no disparos.html quando quiser)

## 📊 Como está hoje

- **Backend `chat-backend-api`** no EasyPanel: API + worker embutido
- **Fila pg-boss**: funcionando, `teamConcurrency: 1` (zero duplicação)
- **Proxy n8n**: ativo pra tudo que não foi migrado
- **DRY_RUN=true**: envios Meta ainda simulados (pra testar)
- **URL**: https://plano-acao-high-performace-chat-backend-api.szlqqi.easypanel.host

## Como testar

### 1. Entra pelo backend novo:
```
https://plano-acao-high-performace-chat-backend-api.szlqqi.easypanel.host/login.html
```

### 2. Ver que ficou mais rápido:
- F12 → Network → clica em "Minhas/Livres/Todas"
- Response time das chamadas `chat-conversas` e `chat-contadores` deve ser 10-20x mais rápido que no n8n

### 3. GitHub Pages atual continua intocado:
A equipe inteira segue usando como sempre — ninguém é afetado.

## Deploys

Cada `git push` dispara rebuild no EasyPanel automaticamente **se** o GitHub token estiver configurado (já está).

Após push: EasyPanel → `chat-backend-api` → **Implantar** (se não auto-rebuildou).

---

**Próximos passos quando quiser:**
1. Trocar DRY_RUN=false e testar envio real de template via `/api/disparos/criar`
2. Migrar `chat-enviar` (grande, mas destrava envio independente do n8n)
3. Migrar os endpoints de IA conforme usar
