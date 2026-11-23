BEGIN;

CREATE TABLE public.ncc_prenotazioni_esterne (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operatore_id integer NOT NULL REFERENCES public.utente(id) ON DELETE CASCADE,
  cliente varchar(160) NOT NULL,
  recapito varchar(160),
  origine varchar(250) NOT NULL,
  destinazione varchar(250) NOT NULL,
  prelievo_il timestamptz NOT NULL,
  passeggeri integer NOT NULL CHECK (passeggeri > 0),
  bagagli varchar(500),
  prezzo_centesimi integer CHECK (prezzo_centesimi >= 0),
  volo_numero varchar(10),
  volo_aeroporto varchar(3),
  volo_direzione varchar(8) CHECK (volo_direzione IN ('arrivo', 'partenza')),
  volo_programmato_il timestamptz,
  volo_aggiornato_il timestamptz,
  annullata_il timestamptz,
  creata_il timestamptz NOT NULL DEFAULT now(),
  aggiornata_il timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(volo_numero, volo_aeroporto, volo_direzione,
    volo_programmato_il, volo_aggiornato_il) IN (0, 5))
);

CREATE INDEX ncc_prenotazioni_esterne_agenda
  ON public.ncc_prenotazioni_esterne (operatore_id, prelievo_il, id);

CREATE INDEX ncc_prenotazioni_esterne_volo
  ON public.ncc_prenotazioni_esterne (operatore_id, volo_numero, prelievo_il)
  WHERE volo_numero IS NOT NULL;

COMMIT;
