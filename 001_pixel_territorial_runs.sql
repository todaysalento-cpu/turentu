-- Metadati operativi PIXEL SHADOW. Nessun dato Google Places persistito.
CREATE TABLE IF NOT EXISTS public.pixel_territorial_runs (
  codice_istat_comune varchar(6) PRIMARY KEY REFERENCES public.pixel_budget_comunali(codice_istat_comune),
  ultima_esecuzione timestamptz,
  prossimo_tentativo timestamptz,
  stato varchar(30) NOT NULL DEFAULT 'mai_eseguito',
  durata_ms integer,
  nodi integer,
  candidati_distinti integer,
  selezionati_comunali integer,
  errori_categorie integer,
  ultimo_errore text,
  aggiornato_il timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pixel_territorial_runs_stato_chk CHECK (stato IN ('mai_eseguito','ok','parziale','errore','budget_esaurito'))
);
CREATE INDEX IF NOT EXISTS idx_pixel_territorial_runs_prossimo
ON public.pixel_territorial_runs(prossimo_tentativo);
