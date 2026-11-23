ALTER TABLE public.ncc_parametri_pianificatore
  ADD COLUMN attesa_massima_minuti integer CHECK (attesa_massima_minuti BETWEEN 0 AND 1440);
