'use client';

import { useState } from 'react';
import { FaCar } from 'react-icons/fa';
import DisponibilitaForm, { Inattivita } from './DisponibilitaForm';
import Modal from './Modal';

type Column<T> = {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
};

type Veicolo = {
  id: number;
  modello: string;
  start?: string;
  fine?: string;
  giorni_esclusi?: number[];
  inattivita?: Inattivita[];
};

type Props<T> = {
  data: T[];
  columns: Column<T>[];
  actions?: (row: T) => React.ReactNode;
  onSaveDisponibilita?: (updatedVeicolo: T) => void;
};

const WEEK_DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

export default function GenericTable<T extends Veicolo>({
  data,
  columns,
  actions,
  onSaveDisponibilita,
}: Props<T>) {
  const [popupVeicolo, setPopupVeicolo] = useState<T | null>(null);

  const openModal = (veicolo: T) => setPopupVeicolo({ ...veicolo });
  const handleSaveDisponibilita = (updatedVeicolo: T) => {
    onSaveDisponibilita?.(updatedVeicolo);
    setPopupVeicolo(null);
  };

  const now = new Date();
  const today = now.getDay();

  // ===============================
  // HELPER: Controlla solo l'orario del turno
  // ===============================
  const isOraInTurno = (startISO: string, endISO: string) => {
    const start = new Date(startISO);
    const end = new Date(endISO);

    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = start.getHours() * 60 + start.getMinutes();
    const endMinutes = end.getHours() * 60 + end.getMinutes();

    return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  };

  // Priorità stati per ordinamento
  const statoPriorita: Record<string, number> = {
    'In turno': 0,
    'Fuori turno': 1,
    'Inattivo': 2,
    'Nessuna disponibilità': 3,
  };

  // ===============================
  // Ordinamento dati con stato aggiornato
  // ===============================
  const sortedData = data
    .map(row => {
      const start = row.start;
      const end = row.fine;
      const inattivita = row.inattivita ?? [];
      const giorniEsclusi = row.giorni_esclusi ?? [];

      const hasDisponibilita = !!start && !!end;

      const isInattivo = inattivita.some(i => {
        const s = new Date(i.start);
        const e = new Date(i.fine);
        return now >= s && now <= e;
      });

      const isGiornoEscluso = giorniEsclusi.includes(today);

      const isInTurno = hasDisponibilita && !isInattivo && !isGiornoEscluso && isOraInTurno(start!, end!);

      let stato = 'Fuori turno';
      if (!hasDisponibilita) stato = 'Nessuna disponibilità';
      else if (isInattivo) stato = 'Inattivo';
      else if (isInTurno) stato = 'In turno';

      return { ...row, stato };
    })
    .sort((a, b) => (statoPriorita[a.stato] ?? 99) - (statoPriorita[b.stato] ?? 99));

  return (
    <>
      <div className="flex flex-col gap-2">
        {sortedData.map(row => {
          const start = row.start;
          const end = row.fine;
          const inattivita = row.inattivita ?? [];
          const giorniEsclusi = row.giorni_esclusi ?? [];

          const hasDisponibilita = !!start && !!end;

          const color =
            row.stato === 'In turno'
              ? 'green'
              : row.stato === 'Fuori turno'
              ? 'yellow'
              : row.stato === 'Inattivo'
              ? 'red'
              : 'gray';

          const borderColor =
            color === 'green'
              ? 'border-green-500'
              : color === 'red'
              ? 'border-red-600'
              : color === 'yellow'
              ? 'border-yellow-500'
              : 'border-gray-400';

          const iconColor =
            color === 'green'
              ? 'text-green-600'
              : color === 'red'
              ? 'text-red-600'
              : color === 'yellow'
              ? 'text-yellow-600'
              : 'text-gray-600';

          return (
            <div
              key={row.id}
              className={`flex flex-col border-l-4 ${borderColor} rounded-lg p-2 shadow-sm hover:shadow-md bg-white transition duration-150`}
            >
              {/* Header */}
              <div className="flex justify-between items-center mb-1">
                <div className="flex items-center text-gray-800 font-semibold text-sm">
                  <div className="flex items-center gap-1 w-28">
                    <FaCar size={18} className={iconColor} />
                    <span className="truncate">{row.modello ?? '—'}</span>
                  </div>

                  <div className="flex items-center ml-2 gap-1">
                    <span className="relative w-3 h-3 flex items-center justify-center">
                      <span
                        className={`absolute w-3 h-3 rounded-full opacity-30 animate-ping ${
                          color === 'green'
                            ? 'bg-green-400'
                            : color === 'red'
                            ? 'bg-red-400'
                            : color === 'yellow'
                            ? 'bg-yellow-400'
                            : 'bg-gray-400'
                        }`}
                      ></span>
                      <span
                        className={`relative w-2 h-2 rounded-full ${
                          color === 'green'
                            ? 'bg-green-600'
                            : color === 'red'
                            ? 'bg-red-600'
                            : color === 'yellow'
                            ? 'bg-yellow-600'
                            : 'bg-gray-600'
                        }`}
                      ></span>
                    </span>

                    <span
                      className={`px-1.5 py-0.5 rounded text-[0.55rem] font-medium ${
                        color === 'green'
                          ? 'bg-green-100 text-green-800'
                          : color === 'red'
                          ? 'bg-red-100 text-red-800'
                          : color === 'yellow'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {row.stato}
                    </span>
                  </div>
                </div>

                <div>
                  {actions ? (
                    actions(row)
                  ) : (
                    <button
                      onClick={() => openModal(row)}
                      className="bg-black text-white px-2 py-1 rounded text-[0.65rem] shadow-sm hover:bg-gray-800 transition-all duration-150"
                    >
                      {hasDisponibilita ? 'Modifica' : 'Aggiungi'}
                    </button>
                  )}
                </div>
              </div>

              {hasDisponibilita && (
                <div className="text-[0.55rem] text-gray-800 mt-1 space-y-1">
                  <div className="flex gap-2">
                    <span className="font-semibold">{'Turno:'}</span>
                    <span className="flex-1">
                      {start && end
                        ? `${new Date(start).toLocaleTimeString('it-IT', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })} - ${new Date(end).toLocaleTimeString('it-IT', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}`
                        : '-'}
                    </span>
                  </div>

                  <div className="flex gap-2">
                    <span className="font-semibold">{'Giorni esclusi:'}</span>
                    <span className="flex-1">
                      {giorniEsclusi.length ? giorniEsclusi.map(i => WEEK_DAYS[i]).join(', ') : '-'}
                    </span>
                  </div>

                  <div className="flex gap-2">
                    <span className="font-semibold">{'Periodo inattività:'}</span>
                    <span className="flex-1 flex flex-col">
                      {inattivita.length
                        ? inattivita.map((i, index) => (
                            <span key={index}>
                              Dal {new Date(i.start).toLocaleDateString('it-IT', {
                                day: '2-digit',
                                month: 'short',
                                year: 'numeric',
                              })}{' '}
                              al{' '}
                              {new Date(i.fine).toLocaleDateString('it-IT', {
                                day: '2-digit',
                                month: 'short',
                                year: 'numeric',
                              })}
                            </span>
                          ))
                        : '-'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {popupVeicolo && (
        <Modal onClose={() => setPopupVeicolo(null)}>
          <DisponibilitaForm
            key={popupVeicolo.id}
            selectedVeicolo={popupVeicolo.id}
            start={popupVeicolo.start ?? ''}
            fine={popupVeicolo.fine ?? ''}
            giorniEsclusi={popupVeicolo.giorni_esclusi ?? []}
            inattivita={popupVeicolo.inattivita ?? []}
            newInizioInatt=""
            newFineInatt=""
            onChangeStart={v => setPopupVeicolo(prev => (prev ? { ...prev, start: v } : prev))}
            onChangeFine={v => setPopupVeicolo(prev => (prev ? { ...prev, fine: v } : prev))}
            onToggleGiorno={day =>
              setPopupVeicolo(prev =>
                prev
                  ? {
                      ...prev,
                      giorni_esclusi: prev.giorni_esclusi?.includes(day)
                        ? prev.giorni_esclusi.filter(d => d !== day)
                        : [...(prev.giorni_esclusi ?? []), day],
                    }
                  : prev
              )
            }
            onAddInattivita={(start, fine) =>
              setPopupVeicolo(prev =>
                prev ? { ...prev, inattivita: [...(prev.inattivita ?? []), { start, fine }] } : prev
              )
            }
            onRemoveInattivita={idx =>
              setPopupVeicolo(prev =>
                prev ? { ...prev, inattivita: prev.inattivita?.filter((_, i) => i !== idx) } : prev
              )
            }
            onChangeNewInizio={() => {}}
            onChangeNewFine={() => {}}
            onSubmit={e => {
              e.preventDefault();
              if (popupVeicolo) handleSaveDisponibilita(popupVeicolo);
            }}
            onCancel={() => setPopupVeicolo(null)}
          />
        </Modal>
      )}
    </>
  );
}