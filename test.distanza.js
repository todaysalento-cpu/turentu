import * as turf from '@turf/turf';
import polyline from 'polyline';

function testDistanzaPura() {
  console.log("🔍 Avvio Test: Verifica calcolo distanza geometrica...");

  // Percorso: Una linea retta da A a B
  const points = [[9.1900, 45.4642], [9.2270, 45.4781]];
  const line = turf.lineString(points);

  // Punto A: Esattamente sul percorso (Distanza attesa: 0)
  const puntoSullLinea = turf.point([9.1900, 45.4642]);
  
  // Punto B: Vicino al percorso (circa 0.5 km)
  const puntoVicino = turf.point([9.1905, 45.4647]);

  const distA = turf.pointToLineDistance(puntoSullLinea, line);
  const distB = turf.pointToLineDistance(puntoVicino, line);

  console.log(`Distanza Punto A: ${distA.toFixed(4)} km`);
  console.log(`Distanza Punto B: ${distB.toFixed(4)} km`);

  if (distA < 0.0001 && distB > 0 && distB < 1.0) {
    console.log("✅ Successo: Il motore di calcolo Turf.js è preciso.");
  } else {
    console.log("❌ Fallito: Il calcolo geometrico non produce i risultati attesi.");
  }
}

testDistanzaPura();