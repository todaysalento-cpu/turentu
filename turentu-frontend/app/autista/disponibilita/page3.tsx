'use client';

import { useEffect, useState, useMemo } from 'react';
import { useUser } from '../../../context/UserContext';
import GenericTable from '../../../components/DataTable';
import DisponibilitaForm, { Inattivita } from '../../../components/DisponibilitaForm';

const WEEK_DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

type Veicolo = { id: number; modello: string };
type Disponibilita = {
  id: number;
  veicolo_id: number;
  veicolo_modello: string;
  start: string;
  fine: string;
  giorni_esclusi: number[];
  inattivita: Inattivita[];
};

export default function DisponibilitaPage() {
  const { user } = useUser();

  const [veicoli, setVeicoli] = useState<Veicolo[]>([]);
  const [disponibilita, setDisponibilita] = useState<Disponibilita[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedVeicolo, setSelectedVeicolo] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  const [start, setStart] = useState('');
  const [fine, setFine] = useState('');
  const [giorniEsclusi, setGiorniEsclusi] = useState<number[]>([]);
  const [inattivita, setInattivita] = useState<Inattivita[]>([]);

  const [newInizioInatt, setNewInizioInatt] = useState('');
  const [newFineInatt, setNewFineInatt] = useState('');

  const [isModalOpen, setIsModalOpen] = useState(false);

  // ===============================
  // FETCH VEICOLI E DISPONIBILITA
  // ===============================
  useEffect(() => {
    if (!user) return;

    const fetchVeicoli = async () => {
      try {
        const res = await fetch(`http://localhost:3001/veicolo`, { credentials: 'include' });
        if (res.ok) setVeicoli(await res.json());
      } catch (err) {
        console.error('Errore fetch veicoli:', err);
      }
    };

    const fetchDisponibilita = async () => {
      try {
        const res = await fetch('http://localhost:3001/disponibilita', { credentials: 'include' });
        if (res.ok) setDisponibilita(await res.json());
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    fetchVeicoli();
    fetchDisponibilita();
  }, [user]);

  // ===============================
  // UTILITY FORM
  // ===============================
  const toggleGiorno = (day: number) =>
    setGiorniEsclusi(prev => (prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]));

  const addInattivita = (start: string, fine: string) => {
    if (!start || !fine) return;
    setInattivita(prev => [...prev, { start, fine }]);
    setNewInizioInatt('');
    setNewFineInatt('');
  };

  const removeInattivita = (idx: number) => setInattivita(prev => prev.filter((_, i) => i !== idx));

  const resetForm = () => {
    setEditingId(null);
    setSelectedVeicolo(null);
    setStart('');
    setFine('');
    setGiorniEsclusi([]);
    setInattivita([]);
    setNewInizioInatt('');
    setNewFineInatt('');
    setIsModalOpen(false);
  };

  // ===============================
  // SALVA DISPONIBILITA (POST/UPSERT)
  // ===============================
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVeicolo) return alert('Seleziona un veicolo');

    const inattivitaISO = inattivita.map(i => ({
      start: new Date(i.start).toISOString(),
      fine: new Date(i.fine).toISOString(),
    }));

    try {
      const res = await fetch('http://localhost:3001/disponibilita', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          veicolo_id: selectedVeicolo,
          start,
          fine,
          giorni_esclusi: giorniEsclusi,
          inattivita: inattivitaISO,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        return alert('Errore salvataggio: ' + text);
      }

      const nuovoTurno = await res.json();

      // ✅ aggiorna lo stato sostituendo il turno esistente
      setDisponibilita(prev => {
        const idx = prev.findIndex(d => d.veicolo_id === nuovoTurno.veicolo_id);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = nuovoTurno;
          return copy;
        }
        return [...prev, nuovoTurno];
      });

      resetForm();
    } catch (err) {
      console.error(err);
    }
  };

  // ===============================
  // MODIFICA / CREA
  // ===============================
  const handleEdit = (row: Veicolo) => {
    const dispo = disponibilita.find(d => d.veicolo_id === row.id);

    setSelectedVeicolo(row.id);

    if (dispo) {
      setEditingId(dispo.id);
      setStart(dispo.start);
      setFine(dispo.fine);
      setGiorniEsclusi(dispo.giorni_esclusi || []);
      setInattivita(dispo.inattivita || []);
    } else {
      setEditingId(null);
      setStart('');
      setFine('');
      setGiorniEsclusi([]);
      setInattivita([]);
    }

    setNewInizioInatt('');
    setNewFineInatt('');
    setIsModalOpen(true);
  };

  // ===============================
  // VEICOLI CON DISPONIBILITA (live)
  // ===============================
  const veicoliConDisponibilita = useMemo(
    () =>
      veicoli.map(v => {
        const dispo = disponibilita.find(d => d.veicolo_id === v.id);
        return {
          ...v,
          start: dispo?.start ?? null,
          fine: dispo?.fine ?? null,
          giorni_esclusi: dispo?.giorni_esclusi ?? [],
          inattivita: dispo?.inattivita ?? [],
        };
      }),
    [veicoli, disponibilita]
  );

  const columns = [
    {
      key: 'turno',
      header: 'Turno',
      render: (row: any) => {
        if (!row.start || !row.fine) return '—';
        const s = new Date(row.start);
        const f = new Date(row.fine);
        const format = (d: Date) =>
          `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        return `Dalle ${format(s)} alle ${format(f)}`;
      },
    },
    {
      key: 'giorni_esclusi',
      header: 'Giorni esclusi',
      render: (row: any) =>
        row.giorni_esclusi.length ? row.giorni_esclusi.map((i: number) => WEEK_DAYS[i]).join(', ') : '-',
    },
    {
      key: 'inattivita',
      header: 'Inattività',
      render: (row: any) =>
        row.inattivita.length
          ? row.inattivita
              .map(i => `Dal ${new Date(i.start).toLocaleDateString()} al ${new Date(i.fine).toLocaleDateString()}`)
              .join('; ')
          : '-',
    },
  ];

  const modelloSelezionato = selectedVeicolo
    ? veicoli.find(v => v.id === selectedVeicolo)?.modello
    : null;

  if (loading) return <p>Caricamento disponibilità...</p>;

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold mb-4">Orari di Disponibilità</h1>

      {isModalOpen && (
        <div className="fixed inset-0 flex items-center justify-center z-50">
          <div className="absolute inset-0 bg-black bg-opacity-50 backdrop-blur-sm" onClick={resetForm} />
          <div className="relative bg-white w-full max-w-lg rounded-xl shadow-2xl p-6 z-10">
            <h2 className="text-lg font-semibold mb-4">
              {modelloSelezionato
                ? `${editingId ? 'Modifica' : 'Nuovo'} Turno - Veicolo: ${modelloSelezionato}`
                : ''}
            </h2>

            <DisponibilitaForm
              key={editingId ?? 'new'} // ✅ usa editingId per reset corretto
              selectedVeicolo={selectedVeicolo}
              start={start}
              fine={fine}
              giorniEsclusi={giorniEsclusi}
              inattivita={inattivita}
              newInizioInatt={newInizioInatt}
              newFineInatt={newFineInatt}
              onChangeStart={setStart}
              onChangeFine={setFine}
              onToggleGiorno={toggleGiorno}
              onAddInattivita={addInattivita}
              onRemoveInattivita={removeInattivita}
              onChangeNewInizio={setNewInizioInatt}
              onChangeNewFine={setNewFineInatt}
              onSubmit={handleSave}
              onCancel={resetForm}
            />
          </div>
        </div>
      )}

<GenericTable
  data={veicoliConDisponibilita}
  layout="inline"
  columns={columns}
  actions={(row: any) => (
<button
  onClick={() => handleEdit(row)}
  className="bg-black text-white px-2 py-0.5 rounded text-[0.65rem] shadow-sm hover:bg-gray-800 transition-all duration-150"
>
  {row.start ? 'Modifica' : 'Aggiungi'}
</button>
  )}
/> </div>
  );
}