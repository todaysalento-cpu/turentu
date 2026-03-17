'use client';
import { FaCar, FaUser, FaEdit, FaTrash } from 'react-icons/fa';

type Veicolo = {
  id: number;
  modello: string;
  posti_totali: number;
  raggio_km: number;
  targa?: string;
  servizi: string[];
};

type Props = {
  veicoli: Veicolo[];
  onDelete: (id: number) => void;
  onEdit: (veicolo: Veicolo) => void;
};

export default function VeicoloCardTable({ veicoli, onDelete, onEdit }: Props) {
  return (
    <div className="flex flex-col gap-3">
      {veicoli.map((v) => (
        <div
          key={v.id}
          className="flex items-center justify-between border-l-4 border-green-500 bg-gray-50 rounded-lg p-3 shadow-sm hover:shadow-md transition"
        >
          {/* Info veicolo */}
          <div className="flex-1 flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <FaCar className="text-green-600" size={18} />
              <span className="font-semibold">{v.modello}</span>
              <span className="flex items-center gap-1 text-gray-600">
                <FaUser size={12} /> {v.posti_totali}
              </span>
              {v.targa && <span className="text-gray-500 font-medium">[{v.targa}]</span>}
            </div>
            <div className="flex flex-wrap gap-2 text-sm text-gray-700">
              <span>Raggio: {v.raggio_km} km</span>
              {v.servizi.length > 0 && <span>Servizi: {v.servizi.join(', ')}</span>}
            </div>
          </div>

          {/* Pulsanti icona */}
          <div className="flex flex-col gap-1 ml-3">
            <button
              onClick={() => onEdit(v)}
              title="Modifica"
              className="bg-blue-100 text-blue-700 p-2 rounded hover:bg-blue-200 transition"
            >
              <FaEdit size={14} />
            </button>
            <button
              onClick={() => onDelete(v.id)}
              title="Elimina"
              className="bg-red-100 text-red-700 p-2 rounded hover:bg-red-200 transition"
            >
              <FaTrash size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
