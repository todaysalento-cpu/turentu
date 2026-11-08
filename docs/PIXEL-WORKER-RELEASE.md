# PIXEL-first: rilascio progressivo e arresto

Le modifiche locali non avviano o distribuiscono automaticamente il worker. Render è già configurato LIVE: non distribuire il commit mantenendo inconsapevolmente tale configurazione.

## Osservazione

Solo dopo approvazione delle modifiche remote, impostare prima del deploy:

```
POPBUS_PIXEL_FIRST_ENABLED=true
POPBUS_PIXEL_FIRST=1
POPBUS_PIXEL_FIRST_MODE=ROLLBACK_ONLY
POPBUS_PIXEL_PHYSICAL_OBSERVATION=1
POPBUS_WORKER_ENABLED=false
POPBUS_PIXEL_AR_WORKER_SHADOW=0
POPBUS_PIXEL_FEASIBILITY_READONLY=0
```

Revocare i consensi LIVE durante l'osservazione. Verificare separatamente che l'altro servizio legacy non esegua worker. Il flag di osservazione è rifiutato con LIVE, prima di eseguire lavoro.

Se PIXEL_FIRST_PIPELINE_ENABLED=1, anche PIXEL usa ROLLBACK_ONLY: le sue nuove opportunità non sono visibili a POPBUS dopo il rollback. Il selettore fisico osserva opportunità già persistite, senza hook diagnostici di persistenza: non è un E2E delle nuove opportunità.

Il calcolo fisico può usare Maps reale e consumare quota. Rivedere perimetro e budget prima di avviare il cron remoto: la precedente autorizzazione al routing di test non è illimitata. Non aumentare limiti per aggirare errori senza misurare il carico.

## Stato e stop

- GET /api/admin/pixel-worker: stato scheduler, ciclo attivo, arresto in corso, ultimo esito/durata e PID. Non restituisce candidati, passeggeri o credenziali.
- POST /api/admin/pixel-worker/stop, JSON {"waitMs":10000}: invalida subito future partenze, distrugge il task cron e attende al massimo il tempo richiesto (0–30000 ms).

Serve JWT Bearer valido con ruolo Admin/admin, oltre alla protezione del router admin. Il solo cookie non autorizza il controllo.

200 con running=false: nessun ciclo attivo in questo processo. 202 con running=true: nuove partenze bloccate, ciclo ancora in conclusione. Leggere lo stato fino a running=false. Non chiude API, Socket.IO, Redis o pool SQL e non forza la cancellazione delle transazioni: il ciclo corrente può ancora completare una scrittura LIVE già autorizzata.

Portata: singolo processo. Lo stop non persiste dopo riavvio/deploy e non raggiunge altre repliche. Non esiste una rotta per riabilitare il worker. Prima di riavviare/ripristinare, disabilitare con approvazione POPBUS_PIXEL_FIRST_ENABLED; il riavvio riguarda anche l'API. Più repliche richiedono un controllo condiviso aggiuntivo o verifica/arresto di ogni processo. Lo stop distribuito non è certificato.

## Rollback e stadi successivi

Conservare commit precedente/candidato, configurazione e log. Arrestare e verificare la conclusione dei cicli; rendere disabilitato l'avvio prima di riavviare; ripristinare la versione precedente solo con approvazione. Non cancellare attivazioni, corse, prenotazioni o pagamenti. Non rimuovere automaticamente la migrazione 004 già approvata e applicata.

L'osservazione deve dimostrare cicli conclusi, conteggi completi e durate entro budget. L'ultimo esito tecnico non dimostra da solo l'esistenza di una missione utile: confrontare la diagnostica del selettore. Il wrapper non stampa il payload completo dei candidati.

Canary richiede perimetro verificato e approvazione specifica; il limite delle opportunità non costituisce un canary. LIVE completo richiede ulteriore approvazione. Le impostazioni LIVE preesistenti non sostituiscono tali approvazioni.

L'istanza Free può sospendersi per inattività. Continuità, account Render, altri servizi e monitoraggio remoto restano da risolvere/verificare. Nessun cambio di piano o pagamento fa parte del commit.

## Test locali

Eseguire dalla radice: node --experimental-vm-modules tests/test_pixel_worker_lifecycle.mjs

Task node-cron reale, API HTTP locale, JWT effettivi e cicli asincroni controllati verificano stop, sovrapposizioni, drenaggio, timeout, errori, autorizzazioni e propagazione delle opzioni fisiche. Le dipendenze applicative sono controllate: zero connessioni DB e zero provider. Queste prove non sostituiscono il collaudo transazionale precedente o il bootstrap del server su Render.


## Osservazione fisica singola, separata dal cron

La nuova rotta POST /api/admin/pixel-worker/observe-once richiede le stesse protezioni Bearer/admin e una configurazione esplicita aggiuntiva:

- POPBUS_PIXEL_OBSERVATION_ONCE_ALLOWED=1
- POPBUS_PIXEL_OBSERVATION_IDS: uno o due ID distinti, separati da virgola, nel perimetro approvato.
- POPBUS_PIXEL_OBSERVATION_ROUTING_LIMIT: intero 1–8, predefinito 8.
- Worker ordinario e legacy disabilitati, modalità ROLLBACK_ONLY e tutti e tre i consensi LIVE a 0.

Non pubblica nuove opportunità PIXEL e non abilita il cron. Usa esclusivamente il selettore fisico SHADOW corrente e la sua transazione READ ONLY, senza writer o test di persistenza. Il perimetro deve esistere integralmente e non avere finestre o scadenze trascorse. Una prova su uno o due ID non certifica il carico completo.

Risponde subito 202; leggere GET /api/admin/pixel-worker/observation fino a COMPLETED, INCOMPLETE o FAILED. Nessun payload di candidati o errore interno viene restituito. Dopo il primo avvio non accetta altre esecuzioni nello stesso processo, neppure dopo un errore o un retry HTTP. Questa memoria non è distribuita e si azzera al riavvio; nessuna ripartenza automatica della prova, che richiede sempre POST amministratore. Dopo la prova revocare il flag ALLOWED secondo l'approvazione.

Il budget è condiviso tra costruzione dei candidati e selezione dei cicli. Prenota al massimo otto tratte distinte; un errore consuma comunque la prenotazione. Cache e coincidenze possono ridurre le chiamate effettive al provider. Non avvia nuove tratte dopo 30 secondi, ma non annulla quelle in corso, il lavoro CPU o le query: non è un limite rigido della durata del processo. Il normale stop del cron non cancella questa osservazione separata. Se il budget viene raggiunto, l'esito non viene presentato come completo anche se livelli interni catturano l'errore.

Prima di un nuovo deploy o esecuzione remota servono approvazione specifica, budget Maps, perimetro e una sessione amministratore legittima. Non creare identità o token firmati di comodo per aggirare il login. Nessun costo di hosting aggiuntivo è richiesto da questa modalità singola; i limiti dell'istanza Free restano validi per il futuro cron continuo.
