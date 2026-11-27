// Auto-finalizar: msg IN que eh SO uma URL de share social (sem texto humano
// em volta) finaliza o chat automaticamente. Motivo: mensagem_automatica.
//
// Hosts tipicos de botao "compartilhar": facebook.com/share, fb.me,
// l.facebook.com, instagram.com, youtu.be, youtube.com/share, tiktok.com/t,
// twitter.com/share, x.com, etc. Esses chegam sem contexto nenhum — nao
// adianta a IA responder porque a pessoa nao esta na conversa.
//
// Checa a cada 30s msgs dos ultimos 10min. Idempotente: ao finalizar,
// chat_conversa_dono.finalizada=true e a condicao do SELECT filtra fora.

import { query } from '../services/db.js';
import { hasDb } from '../config.js';

const INTERVAL_MS = parseInt(process.env.AUTO_LINK_SOCIAL_INTERVAL_MS || '30000', 10);
const MOTIVO_PADRAO = process.env.AUTO_LINK_SOCIAL_MOTIVO || 'mensagem_automatica';

// Regex: texto que eh exclusivamente 1 URL (opcionalmente com espacos)
const SO_URL = /^\s*(https?:\/\/\S+)\s*$/i;

// Hosts de "share" automatico — quando a msg eh so a URL E o host bate,
// consideramos msg automatica (nao conversa real).
const HOSTS_SHARE = [
  'facebook.com/share',
  'fb.me',
  'l.facebook.com',
  'instagram.com/share',
  'instagr.am',
  'youtu.be',
  'youtube.com/share',
  'youtube.com/shorts',
  'tiktok.com/t',
  'vm.tiktok.com',
  'twitter.com/share',
  'x.com/share',
  't.co',
  'wa.me',
  'chat.whatsapp.com',
];

export function ehLinkSocialIsolado(texto) {
  if (!texto) return false;
  const m = SO_URL.exec(String(texto).trim());
  if (!m) return false;
  const url = m[1].toLowerCase();
  return HOSTS_SHARE.some(h => url.includes(h));
}

const SQL_CANDIDATAS = `
  SELECT m.conta_id, m.telefone, m.codigo, m.texto, m.timestamp
  FROM chat_mensagens m
  LEFT JOIN chat_conversa_dono cd
    ON cd.conta_id=m.conta_id AND cd.telefone=m.telefone
  WHERE m.direcao='in'
    AND m.tipo='text'
    AND m.timestamp > NOW() - INTERVAL '10 minutes'
    AND COALESCE(cd.finalizada, false) = false
    AND COALESCE(m.texto,'') ~* '^https?://'
  ORDER BY m.timestamp ASC
  LIMIT 100
`;

export function startAutoFinalizarLinkSocial(fastify) {
  if (!hasDb()) {
    fastify.log.warn('[auto-link-social] sem DB — nao iniciado');
    return;
  }
  let rodando = false;

  let motivoEscolhido = null;
  async function resolverMotivo() {
    if (motivoEscolhido) return motivoEscolhido;
    try {
      const exata = await query(`SELECT codigo FROM chat_motivos_fechamento WHERE LOWER(codigo)=LOWER($1) LIMIT 1`, [MOTIVO_PADRAO]);
      if (exata.rows.length) { motivoEscolhido = exata.rows[0].codigo; return motivoEscolhido; }
      const p = await query(`SELECT codigo FROM chat_motivos_fechamento WHERE tipo='perdido' ORDER BY ordem, codigo LIMIT 1`);
      if (p.rows.length) { motivoEscolhido = p.rows[0].codigo; return motivoEscolhido; }
    } catch (_) {}
    motivoEscolhido = MOTIVO_PADRAO;
    return motivoEscolhido;
  }

  async function tick() {
    if (rodando) return;
    rodando = true;
    try {
      const motivo = await resolverMotivo();
      const cand = await query(SQL_CANDIDATAS);
      if (!cand.rows.length) return;
      for (const c of cand.rows) {
        if (!ehLinkSocialIsolado(c.texto)) continue;
        try {
          // Desliga IA auto se tiver
          await query(
            `UPDATE chat_ia_auto SET ativo=false WHERE conta_id=$1 AND telefone=$2`,
            [c.conta_id, c.telefone]
          ).catch(() => {});
          const res = await fastify.inject({
            method: 'POST',
            url: '/webhook/chat-conversa-finalizar',
            headers: { 'Content-Type': 'application/json' },
            payload: {
              token: 'AUTO_LINK_SOCIAL',
              usuario: 'auto_link_social',
              conta_id: c.conta_id,
              telefone: c.telefone,
              motivo_fechamento: motivo,
            },
          });
          const body = JSON.parse(res.body || '{}');
          if (body.ok) {
            fastify.log.info(`[auto-link-social] ${c.conta_id}/${c.telefone} finalizada (link=${c.texto.substring(0, 60)})`);
          }
        } catch (err) {
          fastify.log.error(`[auto-link-social] ${c.conta_id}/${c.telefone}: ${err.message}`);
        }
      }
    } catch (err) {
      fastify.log.error('[auto-link-social] tick: ' + err.message);
    } finally {
      rodando = false;
    }
  }

  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 18000);
  fastify.log.info(`[auto-link-social] iniciado — intervalo=${INTERVAL_MS}ms motivo=${MOTIVO_PADRAO}`);
}
