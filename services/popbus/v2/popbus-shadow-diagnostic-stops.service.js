// Solo collaudo: aggiunge punti NON CENSITI in memoria.
// NON usare in LIVE, prenotazioni, persistenza o attivazioni.
import { generaAlternativeFisichePixelShadow } from './popbus-pixel-stop-bridge.service.js';
import { cercaFermateCandidate } from './popbus-stop-candidates.service.js';

const PUNTI = Object.freeze([
  { nome:'Tricase - DIAGNOSTICO NON CENSITO', nodo_territoriale_id:8,
    lat:39.9336473, lon:18.3529294 },
  { nome:'Lecce Central Bus Station - DIAGNOSTICO NON CENSITO', nodo_territoriale_id:7,
    lat:40.363194, lon:18.168352 }
]);
const R = Math.PI / 180;
function metri(a,b) {
  const dlat=(b.lat-a.lat)*R, dlon=(b.lon-a.lon)*R;
  const h=Math.sin(dlat/2)**2 + Math.cos(a.lat*R)*Math.cos(b.lat*R)*Math.sin(dlon/2)**2;
  return 6371008.8 * 2 * Math.asin(Math.min(1,Math.sqrt(h)));
}

export async function bridgeFermateDiagnostiche(args) {
  if (process.env.POPBUS_SHADOW_DIAGNOSTIC_STOPS !== '1')
    throw new Error('Attivare esplicitamente POPBUS_SHADOW_DIAGNOSTIC_STOPS=1');
  if (!args?.client?.query) throw new Error('Client PostgreSQL obbligatorio');
  return generaAlternativeFisichePixelShadow({
    ...args,
    servizi: {
      cercaFermateCandidate: async ({client,richiestaIds,raggioMetri,limite}) => {
        const base=await cercaFermateCandidate({client,richiestaIds,raggioMetri,limite});
        const {rows:collisioni}=await client.query(
          `SELECT id FROM public.pixel_fermate WHERE id = ANY($1::bigint[])`,
          [[900000001,900000002]]);
        if (collisioni.length) throw new Error('Collisione ID fermata diagnostica');
        const {rows:richieste}=await client.query(`
          SELECT id,
            ST_Y(origine::geometry) AS salita_lat,
            ST_X(origine::geometry) AS salita_lon,
            ST_Y(destinazione::geometry) AS discesa_lat,
            ST_X(destinazione::geometry) AS discesa_lon
          FROM public.richieste_pop_bus WHERE id=ANY($1::bigint[])`,[richiestaIds]);
        if (richieste.length !== new Set(richiestaIds.map(Number)).size)
          throw new Error('Richieste diagnostiche incomplete');
        const punti=new Map(richieste.map(r=>[Number(r.id),r]));
        return base.map(item=>{
          const r=punti.get(Number(item.richiesta_id));
          if (!r) throw new Error('Richiesta assente');
          const next={...item,salita:[...item.salita],discesa:[...item.discesa]};
          for (const [index,p] of PUNTI.entries()) {
            for (const tipo of ['salita','discesa']) {
              const lat=Number(r[tipo+'_lat']),lon=Number(r[tipo+'_lon']);
              if (!Number.isFinite(lat)||!Number.isFinite(lon)) continue;
              const distanza=metri({lat,lon},p);
              if (distanza>raggioMetri) continue;
              next[tipo].push({fermata_id:900000001+index,nome:p.nome,
                nodo_territoriale_id:p.nodo_territoriale_id,lat:p.lat,lon:p.lon,
                distanza_metri:distanza,verificata:false,tipi_veicolo_ammessi:[],
                solo_diagnostica:true});
            }
          }
          for (const tipo of ['salita','discesa']) {
            next[tipo].sort((a,b)=>a.distanza_metri-b.distanza_metri || a.fermata_id-b.fermata_id);
            next[tipo]=next[tipo].slice(0,limite);
          }
          next.completa=next.salita.length>0&&next.discesa.length>0;
          return next;
        });
      }
    }
  });
}
