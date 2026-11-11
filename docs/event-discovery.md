# Event Discovery Engine

## Analisi iniziale

Base di lavoro: checkout `procaccio-release`, main a `77e7de18`. Il checkout `monitoraggio-app/release-live` contiene una release separata per il monitoraggio. La dashboard web presente nel repository usa Next.js, Topbar e UserContext. Non contiene una pagina Admin per gli eventi. La gestione eventi esistente è esposta da `routes/eventi.routes.js` sotto `/api/eventi`. La ricerca pubblica legge direttamente `public.eventi`; le scritture esistenti usano JWT e query parametrizzate.

Express monta `routes/admin/index.js` sotto `/api/admin`, con JWT da cookie o Bearer e controllo del ruolo Admin. Il pool PostgreSQL condiviso è in `db/db.js`. Redis è già inizializzato dal server per Socket.IO e per altri flussi. I processi PIXEL e POPBUS hanno entry point separati sotto `workers/`. I log correnti usano la console.

Le copie locali dello schema (`phase-g-http/extra-schema.json`, `phase-a/db-schema.json` e `turentu-fase5q-render-schema.json`) mostrano ID evento intero, timestamp con fuso, titolo/categoria/luogo obbligatori, coordinate e autore facoltativi, stato predefinito `in_attesa`. Corse e richieste POPBUS riferiscono gli eventi con FK rispettivamente SET NULL e RESTRICT. I nodi e le fermate hanno ID bigint e una posizione PostGIS. Le fermate riferiscono il nodo. Il catalogo LIVE va verificato prima del rilascio con una connessione autorizzata in sola lettura.

Il modulo usa tabelle di staging, storico e sincronizzazioni, pubblica in `public.eventi` dopo revisione e usa PostgreSQL anche per il coordinamento delle esecuzioni.

## Funzionamento

1. In **Eventi → Event Discovery → Scoperta** scegli territorio, categoria e orizzonte. Brave genera una lista di pagine tramite query composte e un limite di 12 query per esecuzione. Le esecuzioni pianificate ruotano le combinazioni. Le pagine sono proposte di fonte da verificare.
2. In **Fonti** verifica il connettore, l’URL canonico e il permesso di acquisire e riusare i campi. Annota le condizioni d’uso prima dell’attivazione. La sincronizzazione importa solo dalle fonti attive. Un risultato Brave da solo non abilita il monitoraggio.
3. In **Candidati** controlla le evidenze, correggi i dati, approva e pubblica o collega a un ID esistente. Per la pubblicazione sono obbligatori titolo, categoria, luogo e un orario futuro. Un giorno senza orario resta disponibile per la revisione. L’URL canonico con inizio corrispondente collega un evento già pubblicato dal modulo. Titolo normalizzato, data e località aiutano a trovare duplicati probabili. Le evidenze restano distinte per fonte e una nuova acquisizione non sovrascrive il record pubblicato.
4. Il monitoraggio conserva variazioni e cancellazioni esplicite. Lo storico indica se l’evento ha corse o richieste POPBUS. L’assenza di un elemento da una risposta non costituisce cancellazione. Per modifiche a record già pubblicati, usa lo storico per istruire la gestione manuale dell’evento.
5. Sulla scheda pubblicata, controlla i suggerimenti di nodi e fermate esistenti e conferma l’associazione. Le distanze si calcolano in metri con PostGIS. La priorità di mobilità è una classificazione per categoria modificabile separatamente dalla confidenza.

Il parser supporta array JSON con campi canonici o `{events: [...]}`, Schema.org Event in JSON-LD, HTML con metadati evento, RSS con date evento esplicite e ICS. Le ricorrenze ICS giornaliere e settimanali semplici gestiscono eccezioni e sostituzioni. Una serie con regole ulteriori viene marcata da verificare. L’ora locale ambigua durante un cambio di ora richiede un offset o una correzione. Il corpo di origine viene elaborato in memoria. In database restano valori normalizzati e relative evidenze.

Per il [feed Andiamo in Puglia](https://andiamoinpuglia.it/dati/eventi.json), registra l’URL esatto con il formato JSON e documenta la [licenza CC BY 4.0](https://andiamoinpuglia.it/metodologia/). L’adattatore mappa i campi del feed e conserva l’attribuzione e la fonte primaria nelle evidenze e nella descrizione di un nuovo evento pubblicato. Le date prive di ora restano date di calendario. In revisione completa gli orari a partire dalla fonte ufficiale quando disponibili. Il limite di risposta per questo solo URL è 4 MB.

Per [Cosa fare in Puglia](https://dati.puglia.it/v2/dataset/cosa-fare-in-puglia-progressivo), registra come JSON l’URL `https://dati.puglia.it/ckan/api/3/action/datastore_search?resource_id=42f8e0d3-bc1b-46b7-9fa6-7d2a8ab94992` e documenta la licenza CC BY 4.0. Il connettore interroga l’API CKAN pubblica con la finestra di monitoraggio configurata, seleziona solo campi evento e conserva l’attribuzione ad ARET – Pugliapromozione.

La rete è limitata a HTTPS su porta standard, IPv4 pubblici con indirizzo verificato e fissato per la connessione, senza redirect. Le fonti attive sono controllate via robots.txt in modo conservativo. Per ogni risposta valgono un limite di 2 MB, timeout, retry per guasti temporanei ed ETag con rilettura completa almeno giornaliera se la fonte è in scadenza. L’esecuzione è serializzata tramite lock PostgreSQL, con vincolo per fonte e identificativo e pubblicazione transazionale. Il worker riprende le fonti in scadenza, fino a 10 per avvio. Intervalli, esiti e durata sono consultabili nella dashboard. La geocodifica opzionale usa un endpoint Nominatim dedicato e autorizzato, al massimo quattro nuove interrogazioni per sincronizzazione. Una corrispondenza ambigua o un guasto lascia il candidato da verificare.

## Contratti e costi

| Servizio | Stato e accesso |
| --- | --- |
| [Brave Web Search](https://api-dashboard.search.brave.com/app/documentation/web-search) | Adattatore implementato. Chiave in `X-Subscription-Token`. Le [condizioni standard](https://api-dashboard.search.brave.com/documentation/resources/terms-of-service) limitano la conservazione. I risultati sono visualizzati temporaneamente per impostazione predefinita. Conservazione e pianificazione richiedono un contratto che le autorizzi. Impostare anche un tetto di spesa presso il provider. |
| [Google Custom Search JSON API](https://developers.google.com/custom-search/v1/overview) | Chiuso a nuovi clienti. Non integrato. |
| [Ticketmaster Discovery API](https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/) | Documentazione verificata, copertura dichiarata per l’Italia, chiave e quota predefinita di 5.000 richieste al giorno. Adattatore specifico non implementato. Il connettore JSON legge il formato canonico del modulo. |
| [Nominatim](https://nominatim.org/release-docs/latest/api/Search/) | Adattatore implementato per un servizio dedicato con permesso di conservare i risultati. L’[endpoint pubblico OSMF](https://operations.osmfoundation.org/policies/nominatim/) è escluso. Verificare la licenza del servizio e l’attribuzione dei dati prima dell’uso. |
| Facebook / Instagram | Le pagine ufficiali [Page Public Content Access](https://developers.facebook.com/docs/features-reference/page-public-content-access/) e [Business Discovery](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery/) hanno restituito 429 durante la verifica. Permessi e approvazioni da verificare. |
| [Telegram Bot API](https://core.telegram.org/bots/faq) | L’accesso ai messaggi di canale dipende dall’appartenenza del bot. Ricerca pubblica generalizzata non supportata dal modulo. |
| [YouTube Data API](https://developers.google.com/youtube/v3/docs/search/list) | La ricerca pubblica richiede un progetto API e dispone di una quota predefinita dedicata. Restituisce video e canali. Connettore non implementato. |

Fonti territoriali individuate dalle pagine ufficiali: [Vivi Lecce dal portale del Comune](https://www.comune.lecce.it/aree-tematiche/cultura-e-tempo-libero) e [calendario della Regione Puglia](https://areeinterne.regione.puglia.it/it/web/guest/fiere-ed-eventi). Sono riferimenti editoriali. Licenza, endpoint macchina, robots.txt e acquisizione con dati reali devono essere confermati per ogni URL prima dell’attivazione. Nessuna fonte è preattivata dalla migrazione.

Al prezzo di listino Brave Search di 5 USD per 1.000 richieste, 12 query al giorno per 30 giorni costano circa 1,80 USD al mese prima dei crediti, dei retry e di un eventuale accordo separato per la conservazione. Cinque esecuzioni giornaliere da 12 query arrivano a circa 9 USD al mese prima dei retry. Un Cron Render ha un minimo dichiarato di 1 USD/mese e il costo è legato al tempo attivo. Il modulo riutilizza PostgreSQL. L’eventuale servizio di geocodifica dedicato ha un costo separato da quotare. [Listino Brave](https://brave.com/search/api/) · [Render Cron Jobs](https://render.com/docs/cronjobs).

## API e permessi

Il prefisso è `/api/admin/event-discovery`. JWT Admin obbligatorio. Per le mutazioni inviare JSON e l’intestazione `X-Event-Discovery: 1`. I permessi di scrittura sono elenchi di ID Admin separati da virgole. Le impostazioni predefinite concedono solo consultazione.

| Percorsi | Permesso |
| --- | --- |
| GET `/`, `/settings`, `/sources`, `/candidates`, `/candidates/:id/history`, `/runs`, `/events/:id/territory` | Admin |
| POST `/sources`, PUT `/sources/:id` | `EVENT_DISCOVERY_SOURCES_USERS` |
| POST `/discover`, `/sources/:id/sync` | `EVENT_DISCOVERY_ACQUIRE_USERS` |
| POST `/candidates/:id/review` | `EVENT_DISCOVERY_REVIEW_USERS` |
| POST `/candidates/:id/publish`, PUT `/events/:id/territory` | `EVENT_DISCOVERY_PUBLISH_USERS` |
| PUT `/settings` | `EVENT_DISCOVERY_CONFIGURE_USERS` |

## Staging e Render

| Variabile | Uso |
| --- | --- |
| `EVENT_DISCOVERY_ENABLED` | Abilita il modulo backend. Predefinito disattivato. |
| `NEXT_PUBLIC_EVENT_DISCOVERY` | Mostra la voce di menu nel build Next.js. |
| `EVENT_DISCOVERY_SEARCH`, `EVENT_DISCOVERY_BRAVE_KEY` | Abilitano il provider di ricerca con chiave in secret store. |
| `EVENT_DISCOVERY_BRAVE_STORAGE_AUTHORIZED` | Attivare esclusivamente con diritti di conservazione documentati. |
| `EVENT_DISCOVERY_MONITOR` | Abilita acquisizioni manuali e pianificate. |
| `EVENT_DISCOVERY_GEO`, `EVENT_DISCOVERY_GEOCODER_URL` | Abilitano la geocodifica via URL HTTPS dedicato con endpoint `/search`. |
| `EVENT_DISCOVERY_SOCIAL` | Abilita soltanto la registrazione manuale degli URL social. |
| `EVENT_DISCOVERY_AUTO_PUBLISH`, `EVENT_DISCOVERY_AUTO_PUBLISH_USER` | Facoltativi. Il worker pubblica candidati approvati e programmati esplicitamente da un Admin con permessi di revisione e pubblicazione. Il secondo valore è un ID Admin dedicato presente in `EVENT_DISCOVERY_PUBLISH_USERS` e valido come autore in `eventi`. Il worker applica la soglia di confidenza configurata e mantiene la revisione per i duplicati probabili. |
| `EVENT_DISCOVERY_SHADOW` | Blocca pubblicazione e conferma territoriale del modulo, lasciando acquisizione e revisione. |

Cron da creare manualmente solo dopo approvazione, con sorgente sul branch di staging, runtime Node 22, installazione `npm ci`, comando `node workers/event-discovery-worker.js` e pianificazione iniziale `*/15 * * * *` in UTC. Usare un `DATABASE_URL` di staging con TLS e le sole variabili del modulo necessarie al worker. L’intervallo per fonte e quello di ricerca sono applicati in PostgreSQL. Il worker termina dopo ogni passaggio. Nessun nuovo Redis è richiesto. Nessun file Blueprint avvia servizi automaticamente.

### Checklist

- [ ] Eseguire [il preflight in sola lettura](../sql/event-discovery-preflight.sql) sull’ambiente autorizzato e confrontare colonne, indici, FK e PostGIS. Verificare anche il contratto delle categorie dell’app e l’eventuale frontend mobile separato.
- [ ] Applicare `migrations/006_event_discovery.sql` in staging con backup. Installare le dipendenze dal lockfile, eseguire i test isolati e compilare il frontend Next.js.
- [ ] Verificare nel browser la sessione Admin, i profili a permessi limitati e la dashboard su desktop e mobile.
- [ ] In shadow, attivare un gruppo ristretto di fonti autorizzate. Verificare finestre temporali, duplicati, tasso di variazioni, errori, durate e costi per ciclo. Confermare i termini Brave prima della conservazione e il contratto di geocodifica prima dell’invio degli indirizzi.
- [ ] Provare pubblicazione e associazione PIXEL sul database di staging. Eseguire smoke test di ricerca corse, POPBUS, prenotazioni, pagamenti e assegnazioni sullo stesso ambiente prima di proporre il rilascio.
- [ ] Ottenere approvazione esplicita prima di qualsiasi migrazione, attivazione o deploy LIVE.

### Retention e rollback

Proposta iniziale da approvare in staging: 90 giorni di esecuzioni concluse, 180 giorni per candidati rifiutati senza collegamento e 12 mesi di audit. Le evidenze degli eventi pubblicati seguono la policy editoriale. Applicare eventuali limiti contrattuali più restrittivi, inclusa la rimozione delle fonti derivate dal provider alla fine del contratto. Le cancellazioni di retention sono manuali e vanno provate in transazione su una copia. Nessun job automatico di cancellazione è installato.

Per disattivare, fermare il Cron e spegnere i flag backend e frontend. Fare un export delle sei tabelle del modulo prima di valutare la rimozione dello schema. Per rimuoverlo dopo approvazione, eseguire in transazione `DROP TABLE` per `event_discovery_territory`, `event_discovery_audit`, `event_discovery_runs`, `event_discovery_candidates`, `event_discovery_sources`, `event_discovery_settings`, in quest’ordine, senza `CASCADE`. I record già pubblicati restano nel catalogo. Eventuali correzioni editoriali richiedono l’audit esportato e una verifica dei riferimenti.

### Verifiche eseguite

30 test passati con Node 22, PostgreSQL 18.1 e PostGIS 3.6.1 locali. Le suite includono connettori, fusi e ricorrenze, retry, controllo accessi, concorrenza, ricerca simulata, geocodifica simulata, pubblicazione manuale e programmata, associazione PIXEL, rilevazione di rinvii e cancellazioni e regressioni isolate per PIXEL, pagamenti e cache. Il preflight SQL è stato eseguito sullo schema di test. Per riprodurre l’E2E usare un database vuoto denominato `event_discovery_test` su `127.0.0.1:55439` e indicarlo in `EVENT_DISCOVERY_TEST_DATABASE_URL`. Senza tale variabile, l’E2E viene saltato.

```sh
node --experimental-vm-modules --test tests/event-discovery.unit.test.mjs tests/event-discovery.e2e.test.mjs tests/backend-hardening.test.mjs tests/pixel-v57-plan.test.mjs tests/pixel-v561-coverage-regression.test.mjs
```

Build di produzione Next.js completata con il menu Event Discovery abilitato. Il controllo TypeScript in modalità strict è passato sui due componenti interessati. Per rendere la build riproducibile, il frontend dichiara ora `recharts@3.8.0`, già usato dalla dashboard Admin e già presente nel lockfile backend. La radice di tracciamento Next.js punta alla cartella del frontend.

Verifica su Microsoft Edge con API simulate. A 1280 px sono passati navigazione, ricerca, modifica, approvazione e pubblicazione con profilo Admin, incluse le intestazioni richieste dalle API. A 390 px è passato il controllo del profilo in sola lettura, senza scorrimento orizzontale. I due scenari non hanno prodotto eccezioni del browser. Gli smoke test completi di staging e l’osservazione shadow con fonti reali autorizzate restano da eseguire.

### File modificati

| Area | File |
| --- | --- |
| Database | `migrations/006_event_discovery.sql`, `sql/event-discovery-preflight.sql` |
| Motore | `services/event-discovery/service.js`, `extract.js`, `network.js`, `geocode.js` |
| API e worker | `routes/admin/event-discovery.routes.js`, `routes/admin/index.js`, `workers/event-discovery-worker.js` |
| Dashboard web | `turentu-frontend3/app/admin/eventi/discovery/page.tsx`, `turentu-frontend3/components/Topbar.tsx`, `turentu-frontend3/next.config.js`, `turentu-frontend3/package.json`, `turentu-frontend3/package-lock.json` |
| Test | `tests/event-discovery.unit.test.mjs`, `tests/event-discovery.e2e.test.mjs`, `tests/backend-hardening.test.mjs` |
| Dipendenze e report | `package.json`, `package-lock.json`, `docs/event-discovery.md` |

### Limiti e lavoro residuo

L’AI/OCR e l’acquisizione social effettiva sono da implementare. Nessuna credenziale reale è stata usata. Per le ricorrenze estese, i formati API proprietari, l’HTML senza metadati e l’aggiornamento di un record già pubblicato serve un passaggio dedicato. Le associazioni territoriali si consultano nel modulo. Una loro eventuale integrazione nella ricerca corse richiederà un’attività distinta con test sui contratti esistenti.
