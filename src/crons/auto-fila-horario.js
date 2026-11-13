// Auto-fila por horario: a cada 5 min, pra cada atendente com modo_fila='auto',
// calcula se deve estar ON ou OFF segundo chat_atendentes_horario e atualiza
// chat_atendentes.na_fila.
//
// Porta o workflow-cron-auto-fila.json do n8n pro backend. Timezone: America/Sao_Paulo.
// Respeita: dias_semana, horario_inicio/fim, almoco_inicio/fim, horario_sab_*, sabados_ativos.
import { query } from '../services/db.js';
import { hasDb } from '../config.js';

const INTERVAL_MS = parseInt(process.env.AUTO_FILA_HORARIO_INTERVAL_MS || (5 * 60 * 1000), 10);
// Fallback global pra atendentes SEM linha em chat_atendentes_horario
const EXP_INI = parseInt(process.env.EXPEDIENTE_HORA_INI || '8', 10);
const EXP_FIM = parseInt(process.env.EXPEDIENTE_HORA_FIM || '18', 10);
const EXP_DIAS = String(process.env.EXPEDIENTE_DIAS || '1,2,3,4,5').split(',').map(x => parseInt(x, 10)).filter(Boolean);

function hhmmToMin(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}
function ordemSabadoDoMes(date) {
  return Math.ceil(date.getDate() / 7);
}

function calcularNaFila(h, agora) {
  const dow = agora.getDay();
  const diaBR = dow === 0 ? 7 : dow;
  const horaMin = agora.getHours() * 60 + agora.getMinutes();
  const dias = String(h.dias_semana || '').split(',').map(Number);
  if (!dias.includes(diaBR)) return false;
  // Sabado: respeita sabados_ativos
  if (diaBR === 6) {
    const sab = String(h.sabados_ativos || 'todos').trim();
    if (sab !== 'todos') {
      const ordens = sab.split(',').map(Number);
      if (!ordens.includes(ordemSabadoDoMes(agora))) return false;
    }
  }
  // Horario: sabado usa sab_* se preenchido; senao usa o padrao
  let ini, fim, ai = null, af = null;
  if (diaBR === 6 && h.sab_ini && h.sab_fim) {
    ini = hhmmToMin(h.sab_ini); fim = hhmmToMin(h.sab_fim);
  } else {
    ini = hhmmToMin(h.ini); fim = hhmmToMin(h.fim);
    ai = hhmmToMin(h.ai); af = hhmmToMin(h.af);
  }
  if (ini == null || fim == null) return false;
  if (horaMin < ini || horaMin >= fim) return false;
  if (ai != null && af != null && horaMin >= ai && horaMin < af) return false; // almoco
  return true;
}

export function startAutoFilaHorario(fastify) {
  if (!hasDb()) {
    fastify.log.warn('[auto-fila-horario] sem DB — nao iniciado');
    return;
  }
  let rodando = false;

  function expedienteGlobalAgora(agora) {
    const dow = agora.getDay();
    const diaBR = dow === 0 ? 7 : dow;
    if (!EXP_DIAS.includes(diaBR)) return false;
    const h = agora.getHours();
    return h >= EXP_INI && h < EXP_FIM;
  }

  async function tick() {
    if (rodando) return;
    rodando = true;
    try {
      // Pega TODOS os atendentes ativos (que sao USER/ADM, nao bots/admin)
      // Faz LEFT JOIN em chat_atendentes_horario pra ter a config se existir.
      // Regra:
      // - Se tem horario com modo_fila='auto'   -> calcula pelo horario proprio
      // - Se tem horario com modo_fila='manual' -> IGNORA (usuario decide)
      // - Se NAO tem horario                    -> aplica horario global
      const r = await query(
        `SELECT LOWER(a.usuario) AS usuario,
                COALESCE(a.na_fila, false) AS atual,
                h.modo_fila,
                to_char(h.horario_inicio,'HH24:MI') AS ini,
                to_char(h.horario_fim,'HH24:MI') AS fim,
                to_char(h.almoco_inicio,'HH24:MI') AS ai,
                to_char(h.almoco_fim,'HH24:MI') AS af,
                to_char(h.horario_sab_inicio,'HH24:MI') AS sab_ini,
                to_char(h.horario_sab_fim,'HH24:MI') AS sab_fim,
                h.dias_semana, h.sabados_ativos
         FROM chat_atendentes a
         LEFT JOIN chat_atendentes_horario h ON LOWER(h.usuario) = LOWER(a.usuario)
         WHERE COALESCE(a.ativo, true) = true
           AND LOWER(COALESCE(a.papel,'USER')) NOT IN ('super','ia_followup','triagem_ia')
           AND LOWER(a.usuario) <> 'admin'`
      ).catch(() => ({ rows: [] }));
      if (!r.rows.length) return;

      const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const globalOn = expedienteGlobalAgora(agora);
      let mudanças = 0;
      for (const h of r.rows) {
        const temConfig = !!h.modo_fila;
        if (temConfig && h.modo_fila === 'manual') continue; // respeita decisao manual
        const deveEstar = temConfig ? calcularNaFila(h, agora) : globalOn;
        if (deveEstar === !!h.atual) continue;
        await query(
          `UPDATE chat_atendentes SET na_fila=$2 WHERE LOWER(usuario)=LOWER($1)`,
          [h.usuario, deveEstar]
        );
        mudanças++;
        fastify.log.info(`[auto-fila-horario] ${h.usuario} -> na_fila=${deveEstar}${temConfig?'':' (global)'}`);
      }
      if (mudanças) fastify.log.info(`[auto-fila-horario] ${mudanças} atualizacoes`);
    } catch (err) {
      fastify.log.error('[auto-fila-horario] tick: ' + err.message);
    } finally {
      rodando = false;
    }
  }

  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 25000);
  fastify.log.info(`[auto-fila-horario] iniciado, intervalo=${INTERVAL_MS}ms`);
}
