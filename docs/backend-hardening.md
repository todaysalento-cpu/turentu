# Configurazione e verifiche backend

- `DATABASE_URL` e `JWT_SECRET` sono obbligatori anche negli script che importano i relativi moduli. Il vecchio segreto JWT di test e rifiutato. Usare un segreto casuale di almeno 32 byte.
- PostgreSQL verifica il certificato TLS per default. Per CA private configurare `DATABASE_SSL_CA` in PEM (anche con newline `\n`). `DATABASE_SSL_MODE=disable` e consentito solo su localhost fuori produzione. I parametri SSL nella URL non possono disabilitare la verifica.
- Ruotare sul provider la credenziale PostgreSQL precedentemente incorporata nel sorgente e aggiornare `DATABASE_URL` negli ambienti e nei job. Rimuoverla dal codice non revoca la credenziale ne la elimina dalla cronologia Git.
- Tutto `/api/admin` richiede JWT e ruolo `Admin`/`admin`. Le diagnostiche mantengono anche il proprio token dedicato.
- `POST /api/admin/pagamenti/:corsaId/:action` accetta `rilascia` o `rimborso` e riconcilia esclusivamente esiti gia confermati da Stripe. Non esegue catture, trasferimenti o rimborsi. L'incasso operativo resta nel flusso di chiusura corsa. Per piu pagamenti sulla stessa corsa specificare `pagamento_id` nel JSON; il GET lo espone separatamente dall'ID corsa. Wallet, importi incoerenti, rimborsi parziali e stati non confermati restituiscono 409 senza cambiare il DB.
- Le disponibilita sono turni ricorrenti, uno per veicolo nel CRUD corrente: non si applica un filtro `fine > NOW()`. Il caricamento completo non tronca piu a 100 righe; una sola sincronizzazione e attiva per processo, con sostituzione dello snapshot solo al completamento. Gli indici Redis non costituiscono una transazione distribuita con PostgreSQL; una sincronizzazione fallita viene ritentata alla richiesta successiva.

Verifica isolata: `node --experimental-vm-modules --test tests/backend-hardening.test.mjs`. Usa dipendenze simulate, senza DB, Redis o Stripe reali. La configurazione Jest storica rimane un intervento separato.

## Preflight dei servizi configurati

`node scripts/backend-preflight.mjs --config-only` verifica la configurazione senza aprire connessioni. `node scripts/backend-preflight.mjs` esegue anche connessioni ai servizi indicati dalle variabili d'ambiente (caricate da `.env` se non gia impostate). Non importa il server, non avvia worker e non chiama Stripe. PostgreSQL viene interrogato in una transazione read-only; Redis riceve soltanto PING. L'output omette credenziali e dati applicativi. Il codice di uscita e diverso da zero anche quando le connessioni funzionano ma la configurazione JWT non e valida.

Controllo del 6 novembre 2026 dalla configurazione locale:

- PostgreSQL Render raggiungibile, TLS 1.3 e certificato verificato; presenti tutte le colonne controllate per autenticazione, cache e riconciliazione pagamenti. Non e una validazione completa dello schema dei worker.
- Redis configurato su Redis Cloud (non Render), raggiungibile con PONG; URL senza TLS. La disponibilita di un endpoint TLS va verificata sul provider prima di cambiare schema o porta.
- JWT locale non valido (assente, vuoto o vecchio segreto di test). La configurazione del servizio su Render non e stata letta: non si puo dedurne il valore remoto.
- Nessuna scrittura applicativa e nessun worker avviato. Rotazione della credenziale PostgreSQL ancora da confermare sul provider.
