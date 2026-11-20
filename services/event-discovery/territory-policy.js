// Permanent event associations use active territorial infrastructure. The
// verification flag is informative; test, rejected and temporary Google stops
// must not become permanent event destinations. PIXEL/POPBUS are not modified.
export function eventStopEligible(alias = 'p') {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error('Invalid SQL alias');
  return `${alias}.attiva AND ${alias}.posizione IS NOT NULL
    AND (to_jsonb(${alias})->>'google_place_id') IS NULL
    AND ${alias}.nome !~* '^[[:space:]]*(\\[TEST PIXEL\\]|TEST PIXEL([[:space:]]|$))'
    AND NOT EXISTS (SELECT 1 FROM public.pixel_fermate_test_metadata tm WHERE tm.fermata_id=${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM public.pixel_fermate_fonti ff
      WHERE ff.fermata_id=${alias}.id AND ff.stato_verifica='non_ammessa')`;
}
