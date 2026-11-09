import { config } from '../config.js';

// Upstream do n8n (pra reutilizar o chat-enviar que já grava em chat_mensagens)
const N8N_UPSTREAM = process.env.N8N_UPSTREAM || 'https://plano-acao-high-performace-n8n.szlqqi.easypanel.host';

/**
 * Envia template HSM. Por padrão delega ao endpoint /webhook/chat-enviar do n8n
 * (que faz Meta + grava em chat_mensagens). Isso mantém compatibilidade total
 * com o feed de conversas do chat enquanto a migração está em andamento.
 *
 * accountCfg = { phone_number_id, access_token, waba_id, ... } (vem do chat_contas.config)
 */
export async function enviarTemplate({ accountCfg, telefone, templateName, templateLanguage, bodyVars = [], campanha_id, templateBodyText = '' }) {
  if (config.dryRun) {
    console.log(`[DRY_RUN] send template "${templateName}" to ${telefone}`, bodyVars);
    return {
      ok: true,
      wamid: `wamid.DRYRUN_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      dryRun: true,
    };
  }

  // Monta o texto pronto do template (substitui {{1}}, {{2}}... com as bodyVars)
  // pra gravar no chat_mensagens.texto — assim o chat mostra a msg completa, não só "Olá"
  let tplText = String(templateBodyText || '');
  bodyVars.forEach((v, i) => {
    tplText = tplText.replace(new RegExp('\\{\\{\\s*' + (i + 1) + '\\s*\\}\\}', 'g'), String(v || ''));
  });

  // Delega pro chat-enviar do n8n (que já faz Meta + grava chat_mensagens)
  const bodyChatEnviar = {
    token: 'DISPARO_INTERNO',
    usuario: 'disparo_' + (campanha_id || 'bg'),
    conta_id: accountCfg?.codigo || accountCfg?.phone_number_id || '',
    telefone,
    tipo: 'template',
    template_name: templateName,
    template_language: templateLanguage || 'pt_BR',
    template_body_vars: bodyVars,
    template_body_text: tplText,
    texto: tplText,
  };

  try {
    const r = await fetch(`${N8N_UPSTREAM}/webhook/chat-enviar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyChatEnviar),
    });
    const data = await r.json().catch(() => ({}));
    if (!data.ok) {
      return { ok: false, error: data.erro || `HTTP ${r.status}`, raw: data };
    }
    const wamid = (data.mensagem && data.mensagem.external_id) || '';
    return { ok: true, wamid, raw: data };
  } catch (err) {
    return { ok: false, error: err.message || 'fetch_error' };
  }
}
