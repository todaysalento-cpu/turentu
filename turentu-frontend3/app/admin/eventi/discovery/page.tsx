'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

const api = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001') + '/api/admin/event-discovery';
const button = 'rounded border border-[#ff3036] px-3 py-1 text-[#ad2229] disabled:opacity-50';
const input = 'block w-full rounded border border-gray-300 bg-white p-2';
const sections = ['Panoramica', 'Scoperta', 'Fonti', 'Candidati', 'Sincronizzazioni', 'Configurazione'];
const eventFields = [
  ['title', 'Titolo'], ['category', 'Categoria'], ['start', 'Inizio (ISO 8601)'], ['end', 'Fine (ISO 8601)'],
  ['venue', 'Luogo'], ['address', 'Indirizzo'], ['city', 'Comune'], ['province', 'Provincia'],
  ['lat', 'Latitudine'], ['lng', 'Longitudine'], ['organizer', 'Organizzatore'], ['url', 'Sito ufficiale'], ['tickets', 'Biglietti'],
];

type Settings = { territories: string[]; categories: string[]; highPriority: string[]; mediumPriority: string[]; days: number; intervalMinutes: number; radiusKm: number; autoPublishConfidence: number };
type Source = { id: number; name: string; url: string; kind: string; state: string; terms: string; timezone: string; interval_minutes: number; reliability: number; last_sync?: string; last_result?: string; last_count?: number };
type EventData = Record<string, string | number | null>;
type Candidate = { id: number; data: EventData; reviewed_data: EventData | null; state: string; source: string; source_url: string; confidence: number; mobility: string; event_id: number | null; auto_publish: boolean; observed_at: string; possible_duplicates: number[]; evidence: Record<string, unknown>; last_change?: { mobilityAlert: boolean } };
type Run = { id: number; kind: string; source_id: number | null; state: string; started_at: string; finished_at: string | null; error: string | null; count: number | null };
type Summary = { metrics: Record<string, number>; permissions: string[]; flags: Record<string, boolean> };
type Territory = { suggestions: { id: string; nome: string; metres: number; stops: string[] }[]; confirmed: { node_id: string; stop_id: string | null } | null };

async function get<T>(path = '', method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(api + path, {
    method, credentials: 'include', cache: 'no-store',
    ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-Event-Discovery': '1' }, body: JSON.stringify(data) }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Operazione non riuscita');
  }
  return response.json();
}

function date(value?: string | null) {
  return value ? new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Rome',
  }).format(new Date(value)) : '—';
}

function settingsForm(form: FormData) {
  const items = (name: string) => String(form.get(name)).split(',').map((value) => value.trim()).filter(Boolean);
  return { territories: items('territories'), categories: items('categories'), days: Number(form.get('days')),
    ...(form.has('radiusKm') ? { radiusKm: Number(form.get('radiusKm')), intervalMinutes: Number(form.get('intervalMinutes')),
      highPriority: items('highPriority'), mediumPriority: items('mediumPriority'),
      autoPublishConfidence: Number(form.get('autoPublishConfidence')) } : {}) };
}

function SettingsFields({ config, schedule }: { config: Settings; schedule: boolean }) {
  return <>
    <label>Territori e comuni <input name="territories" className={input} defaultValue={config.territories.join(', ')} required /></label>
    <label>Categorie <input name="categories" className={input} defaultValue={config.categories.join(', ')} required /></label>
    <label>Orizzonte in giorni <input name="days" className={input} type="number" min="1" max="365" defaultValue={config.days} required /></label>
    {schedule && <>
      <label>Intervallo di ricerca (minuti) <input name="intervalMinutes" className={input} type="number" min="60" max="43200" defaultValue={config.intervalMinutes} required /></label>
      <label>Raggio per i nodi PIXEL (km) <input name="radiusKm" className={input} type="number" min="1" max="100" defaultValue={config.radiusKm} required /></label>
      <label>Categorie con priorità alta <input name="highPriority" className={input} defaultValue={config.highPriority.join(', ')} /></label>
      <label>Categorie con priorità media <input name="mediumPriority" className={input} defaultValue={config.mediumPriority.join(', ')} /></label>
      <label>Confidenza minima per pubblicazione programmata (%) <input name="autoPublishConfidence" className={input}
        type="number" min="0" max="100" defaultValue={config.autoPublishConfidence} required /></label>
    </>}
  </>;
}

function SourceForm({ source, social, busy, save }: { source?: Source; social: boolean; busy: boolean; save: (form: FormData) => void }) {
  return <form className="grid gap-2 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); save(new FormData(event.currentTarget)); }}>
    <label>Nome <input name="name" className={input} defaultValue={source?.name} required /></label>
    <label>URL HTTPS <input name="url" className={input} type="url" defaultValue={source?.url} required /></label>
    <label>Connettore <select name="kind" className={input} defaultValue={source?.kind || 'jsonld'}>
      <option value="jsonld">Pagina con JSON-LD</option><option value="html">Pagina HTML con metadati evento</option><option value="json">API / Open Data JSON</option>
      <option value="ics">Calendario ICS</option><option value="rss">Feed RSS</option>
      {(social || source?.kind === 'social') && <option value="social">Segnalazione social</option>}
    </select></label>
    <label>Stato <select name="state" className={input} defaultValue={source?.state || 'candidata'}>
      {['candidata', 'in_verifica', 'attiva', 'sospesa', 'non_supportata'].map((value) => <option key={value}>{value}</option>)}
    </select></label>
    <label>Condizioni e autorizzazione d’uso <textarea name="terms" className={input} maxLength={2000} defaultValue={source?.terms} /></label>
    <label>Fuso orario IANA <input name="timezone" className={input} defaultValue={source?.timezone || 'Europe/Rome'} required /></label>
    <label>Frequenza (minuti) <input name="interval_minutes" className={input} type="number" min="15" max="43200" defaultValue={source?.interval_minutes ?? 1440} required /></label>
    <label>Affidabilità (0–100) <input name="reliability" className={input} type="number" min="0" max="100" defaultValue={source?.reliability ?? 50} required /></label>
    <button className={button} disabled={busy}>{source ? 'Salva fonte' : 'Registra fonte'}</button>
  </form>;
}

export default function EventDiscoveryPage() {
  const [section, setSection] = useState(sections[0]);
  const [summary, setSummary] = useState<Summary>();
  const [config, setConfig] = useState<Settings>();
  const [sources, setSources] = useState<Source[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [history, setHistory] = useState<Record<number, unknown[]>>({});
  const [territory, setTerritory] = useState<Record<number, Territory>>({});
  const [sourceOffset, setSourceOffset] = useState(0);
  const [candidateOffset, setCandidateOffset] = useState(0);
  const [candidateState, setCandidateState] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [searchUrls, setSearchUrls] = useState<string[]>([]);
  const allow = (action: string) => Boolean(summary?.permissions.includes(action));

  async function load() {
    const current = await get<Summary>();
    setSummary(current);
    await Promise.all([
      get<Settings>('/settings').then(setConfig),
      get<Source[]>('/sources?offset=' + sourceOffset).then(setSources),
      get<Candidate[]>('/candidates?offset=' + candidateOffset + '&state=' + candidateState).then(setCandidates),
      get<Run[]>('/runs').then(setRuns),
    ]);
  }

  useEffect(() => {
    load().catch((reason: Error) => setError(reason.message));
    // A filter or page change reloads the Admin data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceOffset, candidateOffset, candidateState]);

  async function perform(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try { await action(); await load(); setNotice(message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Operazione non riuscita'); }
    finally { setBusy(false); }
  }

  const send = (path: string, method: string, data: unknown, message: string) =>
    perform(() => get(path, method, data), message);
  function saveSource(form: FormData, source?: Source) {
    const body = { ...Object.fromEntries(form), interval_minutes: Number(form.get('interval_minutes')), reliability: Number(form.get('reliability')) };
    return send(source ? '/sources/' + source.id : '/sources', source ? 'PUT' : 'POST', body, 'Fonte registrata');
  }
  function review(event: FormEvent<HTMLFormElement>, candidate: Candidate) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const autoPublish = form.has('autoPublish');
    form.delete('autoPublish');
    return send(`/candidates/${candidate.id}/review`, 'POST',
      { action: 'approve', data: Object.fromEntries(form), autoPublish, version: candidate.observed_at }, 'Candidato approvato');
  }

  return <div className="mx-auto max-w-5xl space-y-5 pt-8 text-gray-900">
    <h1 className="text-2xl font-semibold">Event Discovery</h1>
    {error && <p role="alert" className="rounded bg-red-50 p-3 text-red-800">{error}</p>}
    {notice && <p role="status" className="rounded bg-green-50 p-3 text-green-800">{notice}</p>}
    {busy && <p role="status">Operazione in corso…</p>}
    {summary && <>
      <nav className="flex flex-wrap gap-2" aria-label="Sezioni Event Discovery">
        {sections.map((name) => <button key={name} className={button} aria-pressed={section === name}
          onClick={() => { setSection(name); setNotice(''); if (name !== 'Scoperta') setSearchUrls([]); }}>{name}</button>)}
      </nav>
      <section className="space-y-4 rounded bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold">{section}</h2>
        {section === 'Panoramica' && <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {Object.entries({ monitored: 'Fonti monitorate', discovered: 'Eventi scoperti', pending: 'Da rivedere', approved: 'Approvati', published: 'Pubblicati', duplicates: 'Gruppi di duplicati', errors: 'Errori' }).map(([key, label]) =>
            <div key={key} className="rounded bg-gray-50 p-3"><dt>{label}</dt><dd className="text-xl font-semibold">{summary.metrics[key]}</dd></div>)}
        </dl>}
        {section === 'Scoperta' && config && <>
          <p>Provider Brave Search. I risultati salvabili compaiono in Fonti. Gli altri sono mostrati per la consultazione temporanea.</p>
          <form className="grid gap-3" onSubmit={(event) => {
            event.preventDefault();
            const filters = settingsForm(new FormData(event.currentTarget));
            void perform(async () => {
              const result = await get<{ count: number; urls?: string[] }>('/discover', 'POST', filters);
              setSearchUrls(result.urls || []);
              if (!result.urls) { setSourceOffset(0); setSection('Fonti'); }
              return result;
            }, 'Ricerca completata');
          }}>
            <SettingsFields config={config} schedule={false} />
            <button className={button} disabled={busy || !allow('acquire') || !summary.flags.search}>Cerca sul web</button>
          </form>
          {searchUrls.length > 0 && <ul className="space-y-1">
            {searchUrls.map((url) => <li key={url} className="break-all"><a className="underline" href={url} target="_blank" rel="noreferrer">{url}</a></li>)}
          </ul>}
        </>}
        {section === 'Fonti' && <>
          {allow('sources') && <details className="rounded border p-3"><summary>Registra una fonte</summary>
            <SourceForm social={summary.flags.social} busy={busy} save={saveSource} />
          </details>}
          {sources.map((source) => <details key={source.id} className="rounded border p-3">
            <summary>{source.name} · {source.state} · {source.kind}</summary>
            <p className="break-all text-sm">{source.url}</p>
            <p className="text-sm">{date(source.last_sync)} · {source.last_result || 'In attesa'} · {source.last_count ?? '—'} eventi</p>
            {allow('sources') && <SourceForm key={JSON.stringify(source)} source={source} social={summary.flags.social} busy={busy} save={(form) => saveSource(form, source)} />}
            {allow('acquire') && source.state === 'attiva' && summary.flags.monitor && <button className={button} disabled={busy}
              onClick={() => send(`/sources/${source.id}/sync`, 'POST', {}, 'Acquisizione completata')}>Sincronizza</button>}
          </details>)}
          <button className={button} disabled={sourceOffset === 0} onClick={() => setSourceOffset(sourceOffset - 100)}>Precedenti</button>{' '}
          <button className={button} disabled={sources.length < 100} onClick={() => setSourceOffset(sourceOffset + 100)}>Successive</button>
        </>}
        {section === 'Candidati' && <>
          <label>Stato <select className={input} value={candidateState} onChange={(event) => { setCandidateState(event.target.value); setCandidateOffset(0); }}>
            <option value="">Tutti</option><option value="pending">Da rivedere</option><option value="approved">Approvati</option>
            <option value="rejected">Rifiutati</option><option value="published">Pubblicati</option>
          </select></label>
          {candidates.map((candidate) => {
            const data = candidate.reviewed_data || candidate.data;
            const currentTerritory = candidate.event_id ? territory[candidate.event_id] : null;
            return <details key={candidate.id} className="space-y-3 rounded border p-3">
              <summary>{data.title || 'Titolo da verificare'} · {data.start || 'Data da verificare'} · {candidate.state}</summary>
              <p>{data.category} · {data.venue} · {data.city}</p>
              <p>Confidenza {candidate.confidence}% · Priorità mobilità {candidate.mobility}</p>
              {candidate.auto_publish && <p>Pubblicazione programmata al prossimo passaggio del worker.</p>}
              <p className="break-all text-sm">{candidate.source} · {candidate.source_url}</p>
              {candidate.event_id && <p>Evento Turentu #{candidate.event_id}</p>}
              {candidate.possible_duplicates.length > 0 && <p>Possibili duplicati tra i candidati #{candidate.possible_duplicates.join(', #')}</p>}
              {candidate.last_change?.mobilityAlert && <p role="alert">Variazione su un evento collegato a corse o richieste POPBUS.</p>}
              {data.status !== 'scheduled' && <p>Stato comunicato dalla fonte · {data.status === 'cancelled' ? 'Cancellazione' : 'Rinvio o modifica'}</p>}
              <details><summary>Evidenze</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(candidate.evidence, null, 2)}</pre></details>
              {Boolean(candidate.evidence.geocode) && <p className="text-xs">Dati geografici © <a className="underline" href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a></p>}
              <button className={button} disabled={busy} onClick={() => void perform(async () => {
                const entries = await get<unknown[]>(`/candidates/${candidate.id}/history`);
                setHistory((previous) => ({ ...previous, [candidate.id]: entries }));
              }, 'Storico caricato')}>Carica storico</button>
              {history[candidate.id] && <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(history[candidate.id], null, 2)}</pre>}
              {candidate.state === 'pending' && allow('review') && <>
                <form key={candidate.observed_at} className="grid gap-2 sm:grid-cols-2" onSubmit={(event) => review(event, candidate)}>
                  {eventFields.map(([field, label]) => <label key={field}>{label}
                    <input name={field} className={input} defaultValue={data[field] ?? ''} /></label>)}
                  <label className="sm:col-span-2">Descrizione <textarea name="description" className={input} defaultValue={data.description ?? ''} /></label>
                  {summary.flags.autoPublish && allow('publish') && !candidate.event_id && data.status === 'scheduled' &&
                    <label className="sm:col-span-2"><input type="checkbox" name="autoPublish" /> Programma la pubblicazione dopo l’approvazione</label>}
                  <button className={button} disabled={busy}>Approva</button>
                </form>
                <button className={button} disabled={busy} onClick={() => send(`/candidates/${candidate.id}/review`, 'POST',
                  { action: 'reject', version: candidate.observed_at }, 'Candidato rifiutato')}>Rifiuta</button>
              </>}
              {candidate.state === 'approved' && !candidate.event_id && data.status === 'scheduled' && allow('publish') && !summary.flags.shadow && <form className="space-y-2" onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const eventId = Number(form.get('eventId'));
                void send(`/candidates/${candidate.id}/publish`, 'POST',
                  { eventId: eventId || null, distinct: form.has('distinct'), version: candidate.observed_at }, 'Evento pubblicato o collegato');
              }}>
                <label>ID evento esistente (facoltativo) <input name="eventId" type="number" min="1" className={input} /></label>
                <label className="block"><input type="checkbox" name="distinct" /> Ho verificato che si tratta di un evento distinto dai possibili duplicati</label>
                <button className={button} disabled={busy}>Pubblica o collega</button>
              </form>}
              {candidate.event_id && <button className={button} disabled={busy} onClick={() => void perform(async () => {
                const eventId = candidate.event_id!;
                const result = await get<Territory>(`/events/${eventId}/territory`);
                setTerritory((previous) => ({ ...previous, [eventId]: result }));
              }, 'Associazioni territoriali caricate')}>Carica suggerimenti PIXEL</button>}
              {currentTerritory && <>
                <p>{currentTerritory.confirmed ? `Nodo confermato #${currentTerritory.confirmed.node_id}` : 'Nessuna associazione confermata'}</p>
                {!currentTerritory.suggestions.length && <p>Nessun nodo compatibile. Verifica le coordinate e il raggio.</p>}
                {currentTerritory.suggestions.map((node) => <form className="flex flex-wrap items-center gap-2" key={node.id} onSubmit={(event) => {
                  event.preventDefault();
                  const stopId = new FormData(event.currentTarget).get('stopId') || null;
                  const path = `/events/${candidate.event_id}/territory`;
                  void perform(async () => {
                    await get(path, 'PUT', { nodeId: node.id, stopId });
                    const result = await get<Territory>(path);
                    setTerritory((previous) => ({ ...previous, [candidate.event_id!]: result }));
                  }, 'Associazione salvata');
                }}>
                  <span>{node.nome} · {node.metres} m</span>
                  {allow('publish') && !summary.flags.shadow && <><select name="stopId" aria-label="Fermata" className="rounded border p-1">
                    <option value="">Solo nodo</option>{node.stops.map((stop) => <option key={stop} value={stop}>Fermata #{stop}</option>)}
                  </select><button className={button} disabled={busy}>Conferma</button></>}
                </form>)}
              </>}
            </details>;
          })}
          <button className={button} disabled={candidateOffset === 0} onClick={() => setCandidateOffset(candidateOffset - 50)}>Precedenti</button>{' '}
          <button className={button} disabled={candidates.length < 50} onClick={() => setCandidateOffset(candidateOffset + 50)}>Successivi</button>
        </>}
        {section === 'Sincronizzazioni' && <>
          <p>Frequenza di ricerca: {config?.intervalMinutes ?? '—'} min. Le fonti usano l’intervallo impostato nel registro.</p>
          <button className={button} disabled={busy} onClick={() => perform(load, 'Storico aggiornato')}>Aggiorna elenco</button>
          {runs.map((run) => <div key={run.id} className="flex flex-wrap items-center gap-3 border-b py-2">
            <span>#{run.id} · {run.kind === 'search' ? 'Ricerca' : 'Acquisizione'} · {run.state} · {date(run.started_at)}</span>
            {run.finished_at && <span>{Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000)} s</span>}
            {run.count !== null && <span>{run.count} acquisiti</span>}{run.error && <span>{run.error}</span>}
            {run.state === 'error' && allow('acquire') && run.source_id && summary.flags.monitor && <button className={button} disabled={busy}
              onClick={() => send(`/sources/${run.source_id}/sync`, 'POST', {}, 'Nuova acquisizione completata')}>Riprova</button>}
          </div>)}
        </>}
        {section === 'Configurazione' && config && <>
          <p>Provider Brave Search · {summary.flags.shadow ? 'modalità shadow' : 'pubblicazione con revisione amministrativa'}</p>
          <form key={JSON.stringify(config)} className="grid gap-3" onSubmit={(event) => {
            event.preventDefault();
            void send('/settings', 'PUT', settingsForm(new FormData(event.currentTarget)), 'Configurazione salvata');
          }}>
            <fieldset className="grid gap-3 sm:grid-cols-2" disabled={!allow('configure') || busy}><SettingsFields config={config} schedule />
              <button className={button}>Salva configurazione</button>
            </fieldset>
          </form>
        </>}
      </section>
    </>}
  </div>;
}
