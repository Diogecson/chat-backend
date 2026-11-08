import { config } from '../config.js';

/**
 * Envia template HSM pra Meta Cloud API.
 * accountCfg = { phone_number_id, access_token, waba_id, ... }
 */
export async function enviarTemplate({ accountCfg, telefone, templateName, templateLanguage, bodyVars = [] }) {
  if (config.dryRun) {
    console.log(`[DRY_RUN] Meta send template "${templateName}" to ${telefone}`, bodyVars);
    return {
      ok: true,
      wamid: `wamid.DRYRUN_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      dryRun: true,
    };
  }

  if (!accountCfg?.phone_number_id || !accountCfg?.access_token) {
    return { ok: false, error: 'account_cfg_incompleto' };
  }

  const url = `https://graph.facebook.com/${config.metaApiVersion}/${accountCfg.phone_number_id}/messages`;
  const components = [];
  if (bodyVars.length) {
    components.push({
      type: 'body',
      parameters: bodyVars.map((v) => ({ type: 'text', text: String(v || '') })),
    });
  }

  const body = {
    messaging_product: 'whatsapp',
    to: telefone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLanguage || 'pt_BR' },
      components,
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accountCfg.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      return {
        ok: false,
        error: data?.error?.message || `HTTP ${res.status}`,
        status: res.status,
        raw: data,
      };
    }
    const wamid = data?.messages?.[0]?.id || '';
    return { ok: true, wamid, raw: data };
  } catch (err) {
    return { ok: false, error: err.message || 'fetch_error' };
  }
}
