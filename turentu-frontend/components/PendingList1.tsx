'use client';
import { MapPinIcon, CalendarIcon, UserIcon } from 'lucide-react';

export default function PendingList({ pending, loadingId, onAccetta }) {
  // ---------------- Formattazione data ----------------
  const formatDateTime = dt => {
    if (!dt) return 'N/D';

    const date = new Date(dt);
    if (isNaN(date.getTime())) return 'N/D';

    const now = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(now.getDate() + 1);

    const optionsTime = { hour: '2-digit', minute: '2-digit' };
    const optionsFull = { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' };

    const dateLocal = new Date(date.getTime() + date.getTimezoneOffset() * 60000); // UTC → locale

    if (dateLocal.toDateString() === now.toDateString()) return `Oggi alle ${dateLocal.toLocaleTimeString('it-IT', optionsTime)}`;
    if (dateLocal.toDateString() === tomorrow.toDateString()) return `Domani alle ${dateLocal.toLocaleTimeString('it-IT', optionsTime)}`;

    return dateLocal.toLocaleString('it-IT', optionsFull);
  };

  // ---------------- Indirizzo ----------------
  const displayAddress = addr => (addr ? addr.split(',').slice(0, 2).join(', ') : 'N/D');

  // ---------------- Debug ----------------
  if (!pending?.length) return <p className="text-gray-500 text-sm">Nessun pending</p>;
  console.log('Pending in arrivo:', pending);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
      {pending.map(c => {
        const posti = c.posti_richiesti || 1;

        return (
          <div
            key={c.id}
            className={`flex border-l-4 rounded-lg shadow-sm overflow-hidden ${
              c.stato === 'accettata' ? 'border-green-400 bg-green-50' : 'border-yellow-400 bg-yellow-50'
            }`}
          >
            {/* Colonna Info corsa */}
            <div className="flex-1 p-1.5 flex flex-col gap-0.5 bg-gray-50 rounded-l-lg text-xs">
              {/* Cliente e tipo corsa */}
              <div className="flex justify-between items-center mb-1">
                <p className="font-semibold flex items-center gap-1 truncate">
                  {c.cliente || 'Cliente N/D'}
                  <span
                    className={`px-1 py-0.5 rounded-full text-[8px] font-medium ${
                      c.tipo_corsa === 'condivisa' ? 'bg-blue-100 text-blue-600' : 'bg-purple-100 text-purple-600'
                    }`}
                  >
                    {c.tipo_corsa === 'condivisa' ? '👥 Condivisa' : '🔒 Privata'}
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
                <span className="truncate">{displayAddress(c.origine_address)}</span>
                <span className="mx-1 text-gray-400">→</span>
                <span className="text-red-600 truncate">{displayAddress(c.destinazione_address)}</span>
              </p>

              {/* Passeggero */}
              <p className="flex items-center gap-0.5 text-gray-700 text-[10px]">
                <UserIcon className="w-3 h-3" />
                {posti} {posti === 1 ? 'passeggero' : 'passeggeri'}
              </p>

              {/* Prezzo */}
              <p className="font-semibold text-sm mt-0.5">€{c.prezzo?.toFixed(2) || 'N/D'}</p>
            </div>

            {/* Colonna Pulsante */}
            <div className="flex flex-col justify-end p-1 bg-gray-50 rounded-r-lg gap-1">
              {c.stato === 'pending' && (
                <span className="text-[8px] bg-green-600 text-white px-1 py-0.5 rounded-full self-start">Nuova</span>
              )}
              <button
                onClick={() => onAccetta(c.id)}
                disabled={loadingId === c.id || c.stato === 'accettata'}
                className="px-2 py-0.5 w-full bg-green-600 text-white rounded hover:bg-green-700 transition disabled:opacity-50 text-[10px]"
              >
                {loadingId === c.id ? 'Accettazione...' : c.stato === 'accettata' ? 'Accettata' : 'Accetta'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}