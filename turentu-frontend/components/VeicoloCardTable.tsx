'use client';
import { FaCar, FaUser, FaEdit, FaTrash, FaMapMarkerAlt } from 'react-icons/fa';

type Veicolo = {
  id: number;
  marca?: string;
  modello: string;
  tipo?: string;
  posti_totali: number;
  raggio_km: number;
  targa?: string;
  servizi: string[];
  lat?: number;
  lon?: number;
};

type Props = {
  veicoli?: Veicolo[];
  onDelete: (id: number) => void;
  onEdit: (veicolo: Veicolo) => void;
};

export default function VeicoloCardTable({ veicoli = [], onDelete, onEdit }: Props) {
  if (!veicoli.length) {
    return <p className="text-gray-500 text-sm">Nessun veicolo disponibile</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {veicoli.map((v) => (
        <div
          key={v.id}
          className="flex bg-white rounded-md p-3 shadow-sm border border-gray-200 hover:shadow-md transition"
        >
          {/* Colonna Info veicolo */}
          <div className="flex-1 flex flex-col gap-1">
            {/* Riga 1: Icona + Marca/Modello | Targa | Posti */}
            <div className="flex items-center">
              {/* Icona + Marca/Modello */}
              <div className="flex items-center gap-1 min-w-[120px]">
                <FaCar className="text-green-600" size={14} />
                {v.marca && <span className="font-bold">{v.marca}</span>}
                <span>{v.modello}</span>
              </div>

              {/* Targa */}
              {v.targa && (
                <div className="min-w-[80px] text-xs text-gray-500 flex items-center ml-4">
                  {v.targa}
                </div>
              )}

              {/* Posti (gap ridotto a -1 per avvicinare a Targa) */}
              <div className="min-w-[50px] text-xs text-gray-500 flex items-center gap-1 -ml-1">
                <FaUser size={10} className="text-gray-600" /> {v.posti_totali}
              </div>
            </div>

            {/* Riga 2: Tipo */}
            {v.tipo && (
              <div className="text-gray-600 text-xs">
                <span className="font-bold">Tipo:</span> {v.tipo}
              </div>
            )}

            {/* Riga 3: Servizi */}
            {v.servizi.length > 0 && (
              <div className="flex flex-wrap gap-1 text-gray-600 text-xs">
                <span className="font-bold">Servizi:</span> {v.servizi.join(', ')}
              </div>
            )}

            {/* Riga 4: Posizione */}
            {v.lat != null && v.lon != null && (
              <div className="flex items-center gap-1 text-gray-500 text-xs">
                <FaMapMarkerAlt size={10} /> <span className="font-bold">Posizione:</span> {v.lat.toFixed(5)}, {v.lon.toFixed(5)}
              </div>
            )}
          </div>

          {/* Colonna Pulsanti */}
          <div className="flex flex-col gap-1 ml-4 mt-1">
            <button
              onClick={() => onEdit(v)}
              title="Modifica"
              className="bg-blue-100 text-blue-700 p-1 rounded hover:bg-blue-200 transition"
            >
              <FaEdit size={12} />
            </button>
            <button
              onClick={() => onDelete(v.id)}
              title="Elimina"
              className="bg-red-100 text-red-700 p-1 rounded hover:bg-red-200 transition"
            >
              <FaTrash size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}