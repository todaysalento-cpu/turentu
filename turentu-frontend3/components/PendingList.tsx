'use client';
import { MapPinIcon, CalendarIcon, UserIcon } from 'lucide-react';

interface PendingListProps {
  pending?: any[];
  loadingId?: number | null;
  onAccetta: (id: number) => void;
}

// 🔹 Parse semplice: ora il backend manda ISO corretto con timezone
const parseDate = (iso?: string) => {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
};

export default function PendingList({ pending = [], loadingId, onAccetta }: PendingListProps) {

  // ---------------- Formattazione data per utente (locale) ----------------
  const formatDateTime = (dt?: string) => {
    const date = parseDate(dt);
    if (!date) return 'N/D';

    const now = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(now.getDate() + 1);

    const optionsTime: Intl.DateTimeFormatOptions = {
      hour: '2-digit',
      minute: '2-digit'
    };

    const optionsFull: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    };

    // Confronto solo data locale
    const dateOnly = date.toDateString();
    const todayOnly = now.toDateString();
    const tomorrowOnly = tomorrow.toDateString();

    if (dateOnly === todayOnly)
      return `Oggi alle ${date.toLocaleTimeString('it-IT', optionsTime)}`;

    if (dateOnly === tomorrowOnly)
      return `Domani alle ${date.toLocaleTimeString('it-IT', optionsTime)}`;

    return date.toLocaleString('it-IT', optionsFull);
  };

  // ---------------- Mostra solo parti principali dell'indirizzo ----------------
  const displayAddress = (addr?: string) =>
    addr ? addr.split(',').slice(0, 2).join(', ') : 'N/D';

  // ---------------- Non renderizzare se lista vuota ----------------
  if (!pending.length) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
      {pending.map(c => {
        const posti = c.posti_richiesti || 1;

        return (
          <div
            key={c.id}
            className={`flex border-l-4 rounded-lg shadow-sm overflow-hidden ${
              c.stato === 'accettata'
                ? 'border-green-400 bg-green-50'
                : 'border-yellow-400 bg-yellow-50'
            }`}
          >
            {/* Colonna info corsa */}
            <div className="flex-1 p-1.5 flex flex-col gap-0.5 bg-gray-50 rounded-l-lg text-xs">
              
              {/* Cliente e tipo corsa */}
              <div className="flex justify-between items-center mb-1">
                <p className="font-semibold flex items-center gap-1 truncate">
                  {c.cliente || 'Cliente N/D'}
                  <span
                    className={`px-1 py-0.5 rounded-full text-[8px] font-medium ${
                      c.tipo_corsa === 'condivisa'
                        ? 'bg-blue-100 text-blue-600'
                        : 'bg-purple-100 text-purple-600'
                    }`}
                  >
                    {c.tipo_corsa === 'condivisa'
                      ? '👥 Condivisa'
                      : '🔒 Privata'}
                  </span>
                </p>
              </div>

              {/* Data partenza */}
              <p className="flex items-center gap-1 text-gray-500">
                <CalendarIcon className="w-3 h-3" />
                {formatDateTime(c.start_datetime)}
              </p>

              {/* Origine → Destinazione */}
              <p className="flex items-center gap-1 text-gray-700 truncate">
                <MapPinIcon className="w-3 h-3" />
                <span className="truncate">
                  {displayAddress(c.origine_address)}
                </span>
                <span className="mx-1 text-gray-400">→</span>
                <span className="text-red-600 truncate">
                  {displayAddress(c.destinazione_address)}
                </span>
              </p>

              {/* Passeggeri */}
              <p className="flex items-center gap-0.5 text-gray-700 text-[10px]">
                <UserIcon className="w-3 h-3" />
                {posti} {posti === 1 ? 'passeggero' : 'passeggeri'}
              </p>

              {/* Prezzo */}
              <p className="font-semibold text-sm mt-0.5">
                €{c.prezzo ? c.prezzo.toFixed(2) : 'N/D'}
              </p>
            </div>

            {/* Colonna pulsante */}
            <div className="flex flex-col justify-end p-1 bg-gray-50 rounded-r-lg gap-1">
              {c.stato === 'pending' && (
                <span className="text-[8px] bg-green-600 text-white px-1 py-0.5 rounded-full self-start">
                  Nuova
                </span>
              )}
              <button
                onClick={() => onAccetta(c.id)}
                disabled={
                  loadingId === c.id || c.stato === 'accettata'
                }
                className="px-2 py-0.5 w-full bg-green-600 text-white rounded hover:bg-green-700 transition disabled:opacity-50 text-[10px]"
              >
                {loadingId === c.id
                  ? 'Accettazione...'
                  : c.stato === 'accettata'
                  ? 'Accettata'
                  : 'Accetta'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}