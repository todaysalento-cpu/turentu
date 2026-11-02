from pathlib import Path
p=Path('services/popbus/v2/popbus-ar-acceptance.service.js')
s=p.read_text(encoding='utf-8')
old='{ attivazioneId, offertaId, operatoreId }'
assert s.count(old)==1, 'Firma inattesa'
s=s.replace(old,'{ attivazioneId, offertaId, operatoreId, sceltaConducente = null }',1)
anchor="  // Stesso lock globale dell'acceptance ordinaria."
assert s.count(anchor)==1
validation='''  // Validazione della forma; i vincoli reali sono verificati dal finalizzatore.
  const conducentiAttivi = process.env.POPBUS_CONDUCENTI_ENABLED === 'true';
  if (conducentiAttivi) {
    if (!sceltaConducente || typeof sceltaConducente !== 'object' ||
        Array.isArray(sceltaConducente) ||
        !['automatica', 'manuale', 'titolare'].includes(sceltaConducente.modalita)) {
      fail('Scelta del conducente obbligatoria', 'CONDUCENTE_SCELTA_RICHIESTA');
    }
    if (sceltaConducente.modalita === 'automatica' &&
        sceltaConducente.conducenteId != null) {
      fail('In modalita automatica non indicare conducenteId');
    }
    if (sceltaConducente.modalita === 'manuale' &&
        (!Number.isSafeInteger(Number(sceltaConducente.conducenteId)) ||
         Number(sceltaConducente.conducenteId) <= 0)) {
      fail('Conducente manuale non valido');
    }
    if (sceltaConducente.modalita === 'titolare' &&
        sceltaConducente.conducenteId != null &&
        Number(sceltaConducente.conducenteId) !== Number(operatoreId)) {
      fail('Conducente titolare non coerente');
    }
  } else if (sceltaConducente != null) {
    fail('Gestione conducenti non abilitata');
  }
  // Whitelist: non memorizzare attributi arbitrari del client.
  const scelta = !conducentiAttivi ? null : {
    modalita: sceltaConducente.modalita,
    ...(sceltaConducente.modalita === 'manuale' ? {
      conducenteId: Number(sceltaConducente.conducenteId),
      confermaDeroga: sceltaConducente.confermaDeroga === true,
      motivoDeroga: sceltaConducente.motivoDeroga ?? null
    } : {}),
    ...(sceltaConducente.modalita === 'titolare' ? {
      conducenteId: Number(operatoreId)
    } : {})
  };

'''
s=s.replace(anchor,validation+anchor,1)
anchor="    return { ...precedente, giaRegistrata: true };"
assert s.count(anchor)==1
s=s.replace(anchor,"""    if (JSON.stringify(precedente.scelta_conducente ?? null, Object.keys(scelta ?? {}).sort()) !==
        JSON.stringify(scelta, Object.keys(scelta ?? {}).sort())) {
      fail('Scelta conducente diversa da quella gia registrata');
    }
"""+anchor,1)
old="""       (attivazione_id, offerta_id, veicolo_id, stato, expires_at)
     VALUES ($1, $2, $3, 'provvisoria', $4)"""
assert s.count(old)==1
s=s.replace(old,"""       (attivazione_id, offerta_id, veicolo_id, stato, expires_at, scelta_conducente)
     VALUES ($1, $2, $3, 'provvisoria', $4, $5::jsonb)""",1)
old='[attivazioneId, offertaId, attivazione.veicolo_id, scadenza]'
assert s.count(old)==1
s=s.replace(old,'[attivazioneId, offertaId, attivazione.veicolo_id, scadenza, JSON.stringify(scelta)]',1)
p.write_text(s,encoding='utf-8')
print('OK: fase 1 applicata a',p)
