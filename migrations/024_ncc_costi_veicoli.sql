ALTER TABLE public.ncc_parametri_pianificatore ADD COLUMN costi_veicoli jsonb NOT NULL DEFAULT '{}'::jsonb;
