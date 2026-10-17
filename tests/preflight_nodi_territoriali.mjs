// TURENTU POPBUS — Preflight unificazione nodi (sola lettura)
// Uso: node --env-file=.env tests/preflight_nodi_territoriali.mjs > preflight_nodi.txt 2>&1
import { pool } from '../db/db.js';

const q = async (client, title, sql, params = []) => {
  try {
    const { rows } = await client.query(sql, params);
    console.log(`\n[${title}] righe=${rows.length}`);
    console.log(JSON.stringify(rows, null, 2));
  } catch (error) {
    console.log(`\n[${title}] ERRORE ${error.code ?? ''}: ${error.message}`);
  }
};

const client = await pool.connect();
try {
  await client.query('BEGIN READ ONLY');
  console.log('=== TURENTU — PREFLIGHT NODI TERRITORIALI (READ ONLY) ===');

  await q(client, 'COLONNE_TABELLE', `
    SELECT table_name, ordinal_position, column_name, data_type, udt_name,
           is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name, ordinal_position
  `, [['nodi_territoriali','nodi_direttrice','richieste_pop_bus',
       'direttrici_virtuali','segmenti','missioni_ritorno','pixel_fermate']]);

  await q(client, 'CONSTRAINTS', `
    SELECT c.conrelid::regclass::text AS tabella, c.conname AS vincolo,
           c.contype AS tipo, pg_get_constraintdef(c.oid, true) AS definizione
    FROM pg_constraint c
    WHERE c.connamespace='public'::regnamespace
      AND (c.conrelid IN (
        'public.nodi_territoriali'::regclass, 'public.nodi_direttrice'::regclass,
        'public.richieste_pop_bus'::regclass, 'public.direttrici_virtuali'::regclass,
        'public.segmenti'::regclass, 'public.missioni_ritorno'::regclass,
        'public.pixel_fermate'::regclass)
      OR c.confrelid IN ('public.nodi_direttrice'::regclass,
                         'public.nodi_territoriali'::regclass))
    ORDER BY tabella, vincolo
  `);

  await q(client, 'FUNZIONI_RIFERIMENTI', `
    SELECT n.nspname AS schema, p.proname AS funzione,
           pg_get_function_identity_arguments(p.oid) AS argomenti,
           pg_get_functiondef(p.oid) AS definizione
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.prokind IN ('f','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND (pg_get_functiondef(p.oid) ILIKE '%nodi_direttrice%'
           OR pg_get_functiondef(p.oid) ILIKE '%nodi_territoriali%'
           OR pg_get_functiondef(p.oid) ILIKE '%start_node_id%')
    ORDER BY schema, funzione
  `);

  await q(client, 'TRIGGER_NON_INTERNI', `
    SELECT t.tgrelid::regclass::text AS tabella, t.tgname AS trigger,
           pg_get_triggerdef(t.oid, true) AS definizione
    FROM pg_trigger t WHERE NOT t.tgisinternal
      AND t.tgrelid IN ('public.richieste_pop_bus'::regclass,
        'public.direttrici_virtuali'::regclass,'public.segmenti'::regclass,
        'public.missioni_ritorno'::regclass,'public.pixel_fermate'::regclass,
        'public.nodi_direttrice'::regclass,'public.nodi_territoriali'::regclass)
    ORDER BY tabella, trigger
  `);

  await q(client, 'CONTEGGI', `
    SELECT 'nodi_territoriali' AS tabella, count(*)::bigint AS righe FROM public.nodi_territoriali
    UNION ALL SELECT 'nodi_direttrice',count(*) FROM public.nodi_direttrice
    UNION ALL SELECT 'richieste_pop_bus',count(*) FROM public.richieste_pop_bus
    UNION ALL SELECT 'direttrici_virtuali',count(*) FROM public.direttrici_virtuali
    UNION ALL SELECT 'segmenti',count(*) FROM public.segmenti
    UNION ALL SELECT 'missioni_ritorno',count(*) FROM public.missioni_ritorno
    UNION ALL SELECT 'pixel_fermate',count(*) FROM public.pixel_fermate
  `);

  await q(client, 'RICHIESTE_STATO_NODI', `
    SELECT count(*)::bigint AS totale,
      count(*) FILTER (WHERE origine_nodo_territoriale_id IS NULL)::bigint AS origine_territoriale_null,
      count(*) FILTER (WHERE destinazione_nodo_territoriale_id IS NULL)::bigint AS destinazione_territoriale_null,
      count(*) FILTER (WHERE start_node_id IS NOT NULL)::bigint AS origine_legacy_presente,
      count(*) FILTER (WHERE end_node_id IS NOT NULL)::bigint AS destinazione_legacy_presente,
      count(*) FILTER (WHERE origine_nodo_territoriale_id IS NOT NULL
        AND destinazione_nodo_territoriale_id IS NOT NULL)::bigint AS coppie_territoriali_complete
    FROM public.richieste_pop_bus
  `);

  await q(client, 'RICHIESTE_DIVERGENZE_GEOGRAFICHE', `
    SELECT count(*)::bigint AS coppie_confrontabili,
      count(*) FILTER (WHERE ST_Distance(a.posizione,b.posizione)>1)::bigint AS origini_divergenti,
      count(*) FILTER (WHERE ST_Distance(c.posizione,d.posizione)>1)::bigint AS destinazioni_divergenti
    FROM public.richieste_pop_bus r
    LEFT JOIN public.nodi_direttrice a ON a.id=r.start_node_id
    LEFT JOIN public.nodi_territoriali b ON b.id=r.origine_nodo_territoriale_id
    LEFT JOIN public.nodi_direttrice c ON c.id=r.end_node_id
    LEFT JOIN public.nodi_territoriali d ON d.id=r.destinazione_nodo_territoriale_id
    WHERE a.id IS NOT NULL AND b.id IS NOT NULL AND c.id IS NOT NULL AND d.id IS NOT NULL
  `);

  await q(client, 'RIFERIMENTI_LEGACY_USATI', `
    SELECT 'direttrici_virtuali' AS tabella,
      count(*)::bigint AS righe,
      count(*) FILTER (WHERE start_node_id IS NOT NULL OR end_node_id IS NOT NULL)::bigint AS con_nodi
    FROM public.direttrici_virtuali
    UNION ALL SELECT 'segmenti',count(*),
      count(*) FILTER (WHERE start_node_id IS NOT NULL OR end_node_id IS NOT NULL)
    FROM public.segmenti
    UNION ALL SELECT 'missioni_ritorno',count(*),
      count(*) FILTER (WHERE nodo_origine IS NOT NULL OR capolinea_finale_id IS NOT NULL)
    FROM public.missioni_ritorno
  `);

  await q(client, 'DIPENDENZE_VISTE', `
    SELECT DISTINCT v.schemaname, v.viewname, v.definition
    FROM pg_views v
    WHERE v.schemaname NOT IN ('pg_catalog','information_schema')
      AND (v.definition ILIKE '%nodi_direttrice%'
           OR v.definition ILIKE '%nodi_territoriali%')
    ORDER BY v.schemaname,v.viewname
  `);

  console.log('\nFINE: nessuna modifica effettuata.');
} finally {
  try { await client.query('ROLLBACK'); } finally { client.release(); await pool.end(); }
}
