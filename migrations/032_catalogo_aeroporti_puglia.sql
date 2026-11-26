BEGIN;
INSERT INTO public.catalogo_luoghi(codice,nome,categoria,codice_iata,comune,provincia,codice_istat_comune,regione,paese,attivo) VALUES
('AEROPORTO-BDS','Aeroporto del Salento','AEROPORTO','BDS','Brindisi','BR','074001','Puglia','IT',false),
('AEROPORTO-BRI','Aeroporto Karol Wojtyla','AEROPORTO','BRI','Bari','BA','072006','Puglia','IT',false),
('AEROPORTO-FOG','Aeroporto Gino Lisa','AEROPORTO','FOG','Foggia','FG','071024','Puglia','IT',false),
('AEROPORTO-TAR','Aeroporto Marcello Arlotta','AEROPORTO','TAR','Grottaglie','TA','073008','Puglia','IT',false)
ON CONFLICT (codice) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'BDS','bds' FROM public.catalogo_luoghi WHERE codice_iata='BDS' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Aeroporto di Brindisi','aeroporto di brindisi' FROM public.catalogo_luoghi WHERE codice_iata='BDS' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Aeroporto del Salento','aeroporto del salento' FROM public.catalogo_luoghi WHERE codice_iata='BDS' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Papola Casale','papola casale' FROM public.catalogo_luoghi WHERE codice_iata='BDS' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Aeroporto Papola Casale','aeroporto papola casale' FROM public.catalogo_luoghi WHERE codice_iata='BDS' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Brindisi Airport','brindisi airport' FROM public.catalogo_luoghi WHERE codice_iata='BDS' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Aeroporto di Brindisi (BDS), Brindisi','aeroporto di brindisi bds brindisi' FROM public.catalogo_luoghi WHERE codice_iata='BDS' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'BRI','bri' FROM public.catalogo_luoghi WHERE codice_iata='BRI' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Aeroporto di Bari','aeroporto di bari' FROM public.catalogo_luoghi WHERE codice_iata='BRI' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Bari Palese','bari palese' FROM public.catalogo_luoghi WHERE codice_iata='BRI' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Aeroporto di Bari Palese','aeroporto di bari palese' FROM public.catalogo_luoghi WHERE codice_iata='BRI' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Karol Wojtyla','karol wojtyla' FROM public.catalogo_luoghi WHERE codice_iata='BRI' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Bari Airport','bari airport' FROM public.catalogo_luoghi WHERE codice_iata='BRI' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'FOG','fog' FROM public.catalogo_luoghi WHERE codice_iata='FOG' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Aeroporto di Foggia','aeroporto di foggia' FROM public.catalogo_luoghi WHERE codice_iata='FOG' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Gino Lisa','gino lisa' FROM public.catalogo_luoghi WHERE codice_iata='FOG' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Aeroporto Gino Lisa','aeroporto gino lisa' FROM public.catalogo_luoghi WHERE codice_iata='FOG' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Foggia Airport','foggia airport' FROM public.catalogo_luoghi WHERE codice_iata='FOG' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'TAR','tar' FROM public.catalogo_luoghi WHERE codice_iata='TAR' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Aeroporto di Grottaglie','aeroporto di grottaglie' FROM public.catalogo_luoghi WHERE codice_iata='TAR' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Aeroporto di Taranto','aeroporto di taranto' FROM public.catalogo_luoghi WHERE codice_iata='TAR' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Aeroporto Taranto Grottaglie','aeroporto taranto grottaglie' FROM public.catalogo_luoghi WHERE codice_iata='TAR' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;
INSERT INTO public.catalogo_luoghi_alias(luogo_id,alias,alias_normalizzato) SELECT id,'Marcello Arlotta','marcello arlotta' FROM public.catalogo_luoghi WHERE codice_iata='TAR' ON CONFLICT (luogo_id,alias_normalizzato) DO NOTHING;

COMMIT;
