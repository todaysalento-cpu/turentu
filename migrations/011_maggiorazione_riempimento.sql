BEGIN;
ALTER TABLE veicolo
  ADD COLUMN maggiorazione_riempimento_percentuale NUMERIC NOT NULL DEFAULT 0,
  ADD CONSTRAINT veicolo_maggiorazione_riempimento_valida
    CHECK (maggiorazione_riempimento_percentuale >= 0 AND maggiorazione_riempimento_percentuale < 'Infinity'::numeric);
ALTER TABLE pending ADD COLUMN prezzo_riempimento_concordato BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE prenotazioni ADD COLUMN prezzo_riempimento_concordato BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pending ADD COLUMN base_condivisa_riempimento NUMERIC,
                    ADD COLUMN percentuale_condivisa_riempimento NUMERIC;
ALTER TABLE corse ADD COLUMN base_condivisa_riempimento NUMERIC,
                  ADD COLUMN percentuale_condivisa_riempimento NUMERIC;
ALTER TABLE richieste_pop_bus ADD COLUMN prezzo_massimo_autorizzato NUMERIC;
COMMIT;
