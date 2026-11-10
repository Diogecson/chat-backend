# Checklist — Toda vez que adicionar um menu/botão/feature novo

Pra garantir que o novo item respeite o controle de permissões (ADM pode ligar/desligar
por usuário) e apareça no painel `permissoes.html`, siga esses passos **toda vez**:

## 1. Define a key
No `public/permissoes.html`, procura `const FEATURES = [`. Adiciona uma linha:

```js
{ key:'minha_feature', label:'Nome amigável', desc:'O que ela faz', icon:'bi-icone' },
```

Regras da `key`:
- snake_case em pt-br (ex: `novo_contato`, não `newContact`)
- única — não repete
- curta (até ~20 chars)

## 2. Marca o elemento na UI
No `public/chat.html` (ou qualquer página), põe `data-feat="minha_feature"` no
elemento raiz do botão/link:

```html
<a href="pagina.html" id="railX" data-feat="minha_feature"><i class="bi ..."></i></a>
<button class="..." data-feat="minha_feature" onclick="...">...</button>
```

O JS do `chat.html` já esconde automaticamente qualquer elemento com `data-feat`
cuja permissão esteja OFF — não precisa de código extra.

## 3. Default é ON
Toda feature nova vem **ligada** por padrão pra não quebrar quem já usa.
Admin (ADM / SUPER) sempre vê tudo — ignora o override.

## 4. Teste
- Entra como USER consultor comum
- Abre `permissoes.html` como ADM
- Seleciona o usuário no dropdown "Editando:"
- Desliga o toggle da nova feature
- Salva
- Faz logout e login de novo no chat.html como aquele USER
- O botão/menu precisa estar sumido

## 5. Casos especiais
- **Só ADM vê:** usa `data-admin` em vez de `data-feat`. Não precisa cadastrar
  em FEATURES — já esconde automático pra USER.
- **Só SUPER vê:** usa `data-super`. Mesmo esquema.
- **Pra todo mundo:** omite data-feat / data-admin / data-super. Sempre visível.

## Mapeamento atual (nov/2026)

| Elemento             | data-feat        | Onde           |
|----------------------|------------------|----------------|
| Manual do Consultor  | `manual`         | composer       |
| Ajuda da IA          | `ajuda_ia`       | composer       |
| HubSpot              | `hubspot`        | header conversa|
| Tarefas              | `tarefas`        | composer       |
| Templates HSM        | `templates`      | rail + chat    |
| Follow-up IA         | `followup`       | rail           |
| Agendar Retorno      | `retorno`        | composer       |
| Triagem IA           | `triagem`        | rail + chat    |
| Respostas Rápidas    | `respostas`      | rail + chat    |
| Disparos em Massa    | `disparos`       | rail           |
| Funil de Conversas   | `funil`          | rail           |
| Base de Matrículas   | `matriculas`     | rail           |
| Consultar Contato    | `consulta`       | rail           |
| Novo Contato         | `novo_contato`   | header conversa|
| Distribuição em Massa| `mass_dist`      | header conversa|
| Status ONLINE/OFFLINE| `status_fila`    | header conversa|
| Gestão de Contas     | `contas`         | rail           |
