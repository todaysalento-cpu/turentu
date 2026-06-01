import * as turf from '@turf/turf'; // Importa turf qui

// ... (tutto il resto dei tuoi import)

export async function cercaSlotUltra(richiesta) {
  console.log(`\n🔍 [SERVICE] Inizio ricerca dinamica | Posti: ${richiesta.posti_richiesti}`);
  
  await loadCachesUltra();

  const lat = Number(richiesta.coord?.lat ?? richiesta.lat);
  const lon = Number(richiesta.coord?.lon ?? richiesta.lon);
  const pStart = turf.point([lon, lat]); // Punto di riferimento per gli slot
  const targetDate = new Date(richiesta.start_datetime || Date.now());
  const postiRichiesti = Number(richiesta.posti_richiesti || 1);

  // 1. Recupero corse candidato (come prima)
  const hash = ngeohash.encode(lat, lon, GEOHASH_PRECISION_TRATTA);
  const hashes = [hash, ...ngeohash.neighbors(hash)];
  const results = await Promise.all(hashes.map(h => redisClient.sMembers(`corsa:in_area:${h}`)));
  const candidateIds = [...new Set(results.flat())];
  const corseCandidate = candidateIds.map(id => CacheStore.corseCache.get(Number(id))).filter(Boolean);

  // 2. Recupero prenotazioni batch (come prima)
  let prenotazioniBatch = [];
  if (corseCandidate.length > 0) {
    const pipeline = redisClient.multi();
    corseCandidate.forEach(c => pipeline.hVals(`corsa:prenotazioni:${c.id}`));
    prenotazioniBatch = await pipeline.exec();
  }

  // 3. ESECUZIONE FILTRI CORSE (Unica fonte di verità per le tratte)
  const { corse: corseValide } = await filterDisponibilita(
    { ...richiesta, posti_richiesti: postiRichiesti, coord: { lat, lon } },
    corseCandidate,
    prenotazioniBatch
  );

  // 4. Gestione Slot Generici (FILTRO SPAZIALE: devono essere vicini!)
  const TOLLERANZA_SLOT_KM = 50; 
  const allSlots = await Promise.all(
    Array.from(CacheStore.disponibilitaCache.values()).map(async (s) => {
      const veicolo = CacheStore.veicoloCache.get(Number(s.veicolo_id));
      if (!veicolo?.lat || !veicolo?.lon) return null;

      // Filtro solo per vicinanza geografica (indipendente dalla tratta)
      const dist = turf.distance(pStart, turf.point([veicolo.lon, veicolo.lat]), { units: 'kilometers' });
      if (dist > TOLLERANZA_SLOT_KM) return null;

      const stati = await getDisponibilita(s.driver_id, targetDate);
      return {
        ...s,
        disponibile: stati.some(st => st.disponibile),
        posti_totali: veicolo ? Number(veicolo.posti_totali || 0) : 0
      };
    })
  );
  
  const slotsLiberi = filterSlotOnly({ posti_richiesti: postiRichiesti }, allSlots.filter(Boolean));

  // 5. SEPARAZIONE E FUSIONE PULITA
  // Aggiungiamo le corse validate dal motore geometrico
  const risultatiCorse = corseValide.map(c => ({ ...c, is_slot: false }));
  
  // Aggiungiamo gli slot, ma solo se quel veicolo non è già impegnato in una delle corse valide
  const risultatiSlot = slotsLiberi.filter(s => 
    !risultatiCorse.some(c => c.veicolo_id === s.veicolo_id)
  ).map(s => ({ ...s, is_slot: true }));

  const risultatiFinali = [...risultatiCorse, ...risultatiSlot];
  
  console.log(`[SERVICE] Trovate ${risultatiCorse.length} corse e ${risultatiSlot.length} slot.`);

  if (risultatiFinali.length === 0) return [];

  // 6. Formattazione finale
  try {
    return await formatResults(richiesta, risultatiFinali, corseValide, CacheStore.veicoliCache);
  } catch (err) {
    console.error("💥 [SERVICE] Errore in formatResults:", err);
    return []; 
  }
}