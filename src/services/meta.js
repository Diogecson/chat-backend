import { config } from '../config.js';

// Endpoint local do backend (chat-enviar migrado) — grava texto completo em chat_mensagens
// Fallback pro n8n só se SELF_HOST_URL não estiver setada
const SELF_HOST = process.env.SELF_HOST_URL || `http://localhost:${process.env.PORT || 3100}`;

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
    // Chama o próprio endpoint /webhook/chat-enviar local (que agora grava texto completo)
    const r = await fetch(`${SELF_HOST}/webhook/chat-enviar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyChatEnviar),
    });
    const data = await r.json().catch(() => ({}));
    if (!data.ok) {
      return { ok: false, error: data.erro || `HTTP ${r.status}`, raw: data };
    }
    const wamid = (data.mensagem && data.mensagem.external_id) || '';
    return { ok: true, wamid, raw: data, dryRun: data.dryRun };
  } catch (err) {
    return { ok: false, error: err.message || 'fetch_error' };
  }
}
