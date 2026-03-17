'use client';

import { useEffect } from 'react';

const WEEK_DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

export type Inattivita = { start: string; fine: string };

type Props = {
  selectedVeicolo: number | null;
  start: string;
  fine: string;
  giorniEsclusi: number[];
  inattivita?: Inattivita[]; // rendiamo opzionale
  onChangeStart: (v: string) => void;
  onChangeFine: (v: string) => void;
  onToggleGiorno: (day: number) => void;
  onAddInattivita: (start: string, fine: string) => void;
  onRemoveInattivita: (idx: number) => void;
  newInizioInatt: string;
  newFineInatt: string;
  onChangeNewInizio: (v: string) => void;
  onChangeNewFine: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  onVeicoloChange?: () => void;
};

// Helper per garantire sempre un array
const safeArray = <T,>(arr?: T[]): T[] => (Array.isArray(arr) ? arr : []);

export default function DisponibilitaForm({
  selectedVeicolo,
  start,
  fine,
  giorniEsclusi,
  inattivita,
  onChangeStart,
  onChangeFine,
  onToggleGiorno,
  onAddInattivita,
  onRemoveInattivita,
  newInizioInatt,
  newFineInatt,
  onChangeNewInizio,
  onChangeNewFine,
  onSubmit,
  onCancel,
  onVeicoloChange
}: Props) {
  // Reset form interno se cambia il veicolo selezionato
  useEffect(() => {
    if (onVeicoloChange) onVeicoloChange();
  }, [selectedVeicolo, onVeicoloChange]);

  const extractTime = (isoOrTime: string) => {
    if (!isoOrTime) return '';
    const d = new Date(isoOrTime);
    if (!isNaN(d.getTime())) {
      const hours = String(d.getHours()).padStart(2, '0');
      const minutes = String(d.getMinutes()).padStart(2, '0');
      return `${hours}:${minutes}`;
    }
    return isoOrTime;
  };

  const formatDate = (iso: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  };

  const handleAddInattivita = () => {
    if (!newInizioInatt || !newFineInatt) return alert('Compila entrambe le date per aggiungere inattività');
    if (newInizioInatt > newFineInatt) return alert('La data di inizio deve precedere la data di fine');
    onAddInattivita(newInizioInatt, newFineInatt);
  };

  // Garantiamo che inattivita sia sempre un array
  const inattivitaArray = safeArray(inattivita);

  return (
    <form onSubmit={onSubmit} className="space-y-4 text-sm">
      <input type="hidden" value={selectedVeicolo ?? ''} />

      {/* Orari disponibilità */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block mb-1 font-medium">Ora inizio:</label>
          <input
            type="time"
            value={extractTime(start)}
            onChange={e => onChangeStart(e.target.value)}
            className="border p-2 rounded w-full"
            required
          />
        </div>
        <div>
          <label className="block mb-1 font-medium">Ora fine:</label>
          <input
            type="time"
            value={extractTime(fine)}
            onChange={e => onChangeFine(e.target.value)}
            className="border p-2 rounded w-full"
            required
          />
        </div>
      </div>

      {/* Giorni esclusi */}
      <div>
        <label className="block mb-1 font-medium">Giorni esclusi:</label>
        <div className="flex flex-wrap gap-1">
          {WEEK_DAYS.map((d, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onToggleGiorno(i)}
              className={`px-2 py-1 text-xs rounded font-medium border transition ${
                giorniEsclusi.includes(i)
                  ? 'bg-red-600 text-white border-red-600'
                  : 'bg-gray-100 text-gray-800 border-gray-300'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* Periodi di inattività */}
      <div>
        <label className="block mb-1 font-medium">Periodo di inattività:</label>
        <div className="flex flex-col gap-1 mb-2">
          {inattivitaArray.length
            ? inattivitaArray.map((i, idx) => (
                <div
                  key={idx}
                  className="flex justify-between items-center gap-2 bg-red-100 px-2 py-1 rounded text-xs text-red-800"
                >
                  <span>Dal {formatDate(i.start)} al {formatDate(i.fine)}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveInattivita(idx)}
                    className="text-red-600 hover:underline text-[0.6rem]"
                  >
                    Rimuovi
                  </button>
                </div>
              ))
            : <span className="text-gray-500 text-xs">— Nessuna inattività —</span>}
        </div>

        <div className="flex gap-2 items-center">
          <input
            type="date"
            value={newInizioInatt}
            onChange={e => onChangeNewInizio(e.target.value)}
            className="border p-1 rounded w-1/2"
          />
          <input
            type="date"
            value={newFineInatt}
            onChange={e => onChangeNewFine(e.target.value)}
            className="border p-1 rounded w-1/2"
          />
          <button
            type="button"
            onClick={handleAddInattivita}
            className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 transition text-sm"
          >
            Aggiungi
          </button>
        </div>
      </div>

      {/* Pulsanti */}
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="bg-gray-400 text-white px-4 py-2 rounded hover:bg-gray-500 transition"
        >
          Annulla
        </button>
        <button
          type="submit"
          className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600 transition-all duration-200"
        >
          Salva
        </button>
      </div>
    </form>
  );
}