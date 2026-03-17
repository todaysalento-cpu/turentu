'use client';
import { useEffect, useState } from 'react';
import { useUser } from '../../../context/UserContext';
import TariffaForm, { Tariffa } from '../../../components/TariffeForm';

type Veicolo = {
  id: number;
  modello: string;
  posti_totali: number;
  raggio_km: number;
  targa?: string;
  servizi: string[];
};

const TIPI: Tariffa['tipo'][] = ['standard', 'notturna', 'festivo'];

export default function TariffePage() {
  const { user } = useUser();

  const [veicoli, setVeicoli] = useState<Veicolo[]>([]);
  const [tariffe, setTariffe] = useState<Tariffa[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // =========================
  // FETCH VEICOLI
  // =========================
  useEffect(() => {
    if (!user) return;

    const fetchVeicoli = async () => {
      setLoading(true);
      try {
        const res = await fetch('http://localhost:3001/veicolo', {
          credentials: 'include',
        });
        if (!res.ok) throw new Error('Errore fetch veicoli');
        const data = await res.json();
        setVeicoli(data);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchVeicoli();
  }, [user]);

  // =========================
  // FETCH TARIFFE
  // =========================
  useEffect(() => {
    if (!veicoli.length) return;

    const fetchAllTariffe = async () => {
      try {
        const all: Tariffa[] = [];

        for (const v of veicoli) {
          const res = await fetch(
            `http://localhost:3001/tariffe/veicolo/${v.id}`,
            { credentials: 'include' }
          );
          if (!res.ok) continue;

          const data: Tariffa[] = await res.json();
          all.push(
            ...data.map(t => ({
              ...t,
              euro_km: Number(t.euro_km),
              prezzo_passeggero: Number(t.prezzo_passeggero),
            }))
          );
        }

        setTariffe(all);
      } catch (err: any) {
        setError(err.message);
      }
    };

    fetchAllTariffe();
  }, [veicoli]);

  // =========================
  // SALVA / AGGIORNA
  // =========================
  const handleSaveTariffa = async (t: Tariffa) => {
    try {
      const exists = t.id && tariffe.some(tr => tr.id === t.id);

      let res;

      if (exists) {
        res = await fetch(`http://localhost:3001/tariffe/${t.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(t),
        });
      } else {
        res = await fetch(`http://localhost:3001/tariffe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(t),
        });
      }

      if (!res.ok) throw new Error('Errore salvataggio');

      const saved = await res.json();

      setTariffe(prev => {
        const already = prev.find(tr => tr.id === saved.id);
        if (already) {
          return prev.map(tr => (tr.id === saved.id ? saved : tr));
        }
        return [...prev, saved];
      });
    } catch (err: any) {
      setError(err.message);
    }
  };

  // =========================
  // RENDER
  // =========================
  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      <h1 className="text-2xl font-bold">Gestione Tariffe</h1>

      {error && <p className="text-red-600">{error}</p>}
      {loading && <p>Caricamento...</p>}

      <div className="space-y-8">
        {veicoli.map(v => {
          const veicoloTariffe = tariffe.filter(
            t => t.veicolo_id === v.id
          );

          return (
            <div
              key={v.id}
              className="border rounded-xl p-6 shadow bg-white space-y-6"
            >
              <div>
                <h2 className="text-lg font-semibold">{v.modello}</h2>
                <p className="text-sm text-gray-500">
                  {v.posti_totali} posti • Raggio {v.raggio_km} km
                </p>
              </div>

              <div className="grid md:grid-cols-3 gap-6">
                {TIPI.map(tipo => {
                  const existing = veicoloTariffe.find(
                    t => t.tipo === tipo
                  );

                  return (
                    <div
                      key={tipo}
                      className="border rounded-lg p-4 bg-gray-50"
                    >
                      <h3 className="font-medium mb-3 capitalize">
                        Tariffa {tipo}
                      </h3>

                      <TariffaForm
                        tariffa={
                          existing ??
                          ({
                            veicolo_id: v.id,
                            tipo,
                          } as Tariffa)
                        }
                        selectedVeicolo={v}
                        onSave={handleSaveTariffa}
                        onCancel={() => {}}
                        veicoli={veicoli}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
