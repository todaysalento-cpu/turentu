ALTER TABLE public.ncc_parametri_pianificatore
  ADD COLUMN durata_massima_missione_minuti integer CHECK (durata_massima_missione_minuti BETWEEN 1 AND 1440);
