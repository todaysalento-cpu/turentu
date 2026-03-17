'use client';
import { useState, useEffect } from 'react';
import { UserIcon } from 'lucide-react';

interface CorseGiornataProps {
  corse?: any[];
  onToggleCorsa?: (corsa: any) => void;
  loadingId?: number | null;
  onSelectCorsa?: (corsa: any | null) => void; // nuovo: callback per aprire/chiudere chat
}

export default function CorseGiornata({ corse = [], onToggleCorsa, loadingId, onSelectCorsa }: CorseGiornataProps) {
  const [corseGiornata, setCorseGiornata] = useState<any[]>([]);
  const [expandedMap, setExpandedMap] = useState<number | null>(null);
  const [, setNow] = useState(Date.now());

  // Aggiorna corse filtrando solo prenotabile e in_corso
  useEffect(() => {
    setCorseGiornata(
      (corse || []).filter(c => {
        const stato = c.stato?.toLowerCase().trim();
        return stato === 'prenotabile' || stato === 'in_corso';
      })
    );
  }, [corse]);

  // Aggiornamento countdown ogni 30s
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (dt?: string | null) =>
    dt ? new Date(dt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';

  const displayCity = (addr?: string | { lat: number; lon: number } | null) => {
    if (!addr) return 'N/D';
    return typeof addr === 'string' ? addr.split(',')[0] : `${addr.lat},${addr.lon}`;
  };

  const minutiDallaPartenza = (start?: string | null) =>
    start ? Math.ceil((Date.now() - new Date(start).getTime()) / 60000) : Infinity;

  const formatCountdown = (start?: string | null) => {
    if (!start) return '--';
    const diffMin = minutiDallaPartenza(start);
    const absMin = Math.abs(diffMin);
    const h = Math.floor(absMin / 60);
    const m = absMin % 60;
    return diffMin <= 0 ? `${h ? h + 'h ' : ''}${m}m` : `+${h ? h + 'h ' : ''}${m}m`;
  };

  if (!corseGiornata.length)
    return <p className="text-gray-500 text-sm">Nessuna corsa prenotabile o in corso per questo veicolo oggi</p>;

  return (
    <div className="space-y-0.5 font-mono text-[11px]">
      {/* Header */}
      <div className="grid grid-cols-[1fr_1fr_55px_55px_70px_120px] gap-1 px-0.5 font-bold text-gray-700 border-b border-gray-300">
        <span>Origine</span>
        <span>Destinazione</span>
        <span>Orario</span>
        <span>Posti</span>
        <span>Rim.</span>
        <span>Azioni</span>
      </div>

      {corseGiornata.map(c => {
        const minDallaPartenza = minutiDallaPartenza(c.start_datetime);
        const countdown = formatCountdown(c.start_datetime);
        const stato = c.stato?.toLowerCase().trim();
        const isExpanded = expandedMap === c.id;

        const showMap = stato === 'in_corso' || isExpanded;

        // Pulsante Inizia se corsa prenotabile (anche se già passata) fino a 1h dopo
        const showIniziaBtn = onToggleCorsa && stato === 'prenotabile' && minDallaPartenza <= 60;

        return (
          <div key={c.id}>
            {/* Riga corsa */}
            <div
              className={`grid grid-cols-[1fr_1fr_55px_55px_70px_120px] gap-1 items-center px-0.5 py-0.5 border-b border-gray-200
                        ${minDallaPartenza >= 0 && minDallaPartenza <= 10 ? 'bg-yellow-50 hover:bg-yellow-100' : 'bg-white hover:bg-gray-50'}`}
            >
              <span className="truncate">{displayCity(c.origine_address)}</span>
              <span className="truncate">{displayCity(c.destinazione_address)}</span>
              <span>{formatTime(c.start_datetime)}</span>
              <span className="flex items-center gap-0.5">
                <UserIcon className="w-3 h-3" />
                {c.posti_prenotati || 1}/{c.posti_totali || 1}
              </span>
              <span className="text-[10px] font-semibold">{countdown}</span>

              <div className="flex gap-1 justify-end">
                {showIniziaBtn && (
                  <button
                    onClick={() => {
                      onToggleCorsa?.(c);
                      setExpandedMap(c.id);
                      onSelectCorsa?.({ ...c, stato: 'in_corso' }); // apre chat
                    }}
                    disabled={loadingId === c.id}
                    className="px-1.5 py-0.5 text-[9px] bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                  >
                    Inizia
                  </button>
                )}

                {onToggleCorsa && stato === 'in_corso' && (
                  <>
                    <button
                      onClick={() => setExpandedMap(isExpanded ? null : c.id)}
                      className="px-1.5 py-0.5 text-[9px] bg-blue-600 text-white rounded hover:bg-blue-700"
                    >
                      Nav
                    </button>
                    <button
                      onClick={() => {
                        onToggleCorsa?.(c);
                        setExpandedMap(null);
                        onSelectCorsa?.(null); // chiude chat al termine
                      }}
                      disabled={loadingId === c.id}
                      className="px-1.5 py-0.5 text-[9px] bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                    >
                      Termina
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Card mappa inline */}
            {showMap && (
              <div className="p-1.5 border-l-4 border-blue-400 bg-blue-50 text-[10px] rounded-b-lg">
                <iframe
                  title={`mappa-${c.id}`}
                  width="100%"
                  height="180"
                  frameBorder="0"
                  style={{ border: 0 }}
                  src={`https://www.google.com/maps/embed/v1/directions?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&origin=${encodeURIComponent(
                    c.origine_address
                  )}&destination=${encodeURIComponent(c.destinazione_address)}&mode=driving`}
                  allowFullScreen
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}