'use client';
import { useEffect, useState } from 'react';
import { useUser } from '../../../context/UserContext';
import TariffeForm, { Tariffa } from '../../../components/TariffeForm';
import TariffeCardList from '../../../components/TariffeCardList';

type Veicolo = {
  id: number;
  modello: string;
  posti_totali: number;
  raggio_km: number;
  targa?: string;
  servizi: string[];
};

export default function TariffePage() {
  const { user } = useUser();

  const [veicoli, setVeicoli] = useState<Veicolo[]>([]);
  const [tariffe, setTariffe] = useState<Tariffa[]>([]);
  const [selectedVeicolo, setSelectedVeicolo] = useState<Veicolo | null>(null);
  const [message, setMessage] = useState('');
  const [errorVeicoli, setErrorVeicoli] = useState<string | null>(null);
  const [errorTariffe, setErrorTariffe] = useState<string | null>(null);
  const [loadingVeicoli, setLoadingVeicoli] = useState(false);
  const [loadingTariffeId, setLoadingTariffeId] = useState<number | null>(null);

  // ===============================
  // FETCH VEICOLI
  // ===============================
  useEffect(() => {
    if (!user) return;

    const fetchVeicoli = async () => {
      setLoadingVeicoli(true);
      setErrorVeicoli(null);
      try {
        const res = await fetch('http://localhost:3001/veicolo', { credentials: 'include' });
        if (!res.ok) throw new Error(`Errore fetch veicoli: ${res.status}`);
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          throw new Error(`Risposta non JSON: ${await res.text()}`);
        }
        const data: Veicolo[] = await res.json();
        setVeicoli(data);
      } catch (err: any) {
        console.error(err);
        setErrorVeicoli(err.message || 'Errore fetch veicoli');
      } finally {
        setLoadingVeicoli(false);
      }
    };

    fetchVeicoli();
  }, [user]);

  // ===============================
  // FETCH TARIFFE DI UN VEICOLO
  // ===============================
  const fetchTariffe = async (veicoloId: number) => {
    setLoadingTariffeId(veicoloId);
    setErrorTariffe(null);
    try {
      const res = await fetch(`http://localhost:3001/tariffe/veicolo/${veicoloId}`, {
        credentials: 'include',
      });

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Risposta non JSON: ${await res.text()}`);
      }

      if (!res.ok) {
        if (res.status === 404) {
          setTariffe(prev => prev.filter(t => t.veicolo_id !== veicoloId));
          return;
        }
        throw new Error(`Errore fetch tariffe: ${res.status}`);
      }

      const data: Tariffa[] = (await res.json()).map(t => ({
        ...t,
        euro_km: Number(t.euro_km),
        prezzo_passeggero: Number(t.prezzo_passeggero),
      }));

      setTariffe(prev => {
        const others = prev.filter(tr => tr.veicolo_id !== veicoloId);
        return [...others, ...data];
      });
    } catch (err: any) {
      console.error(err);
      setErrorTariffe(err.message || 'Errore fetch tariffe');
    } finally {
      setLoadingTariffeId(null);
    }
  };

  // ===============================
  // CARICA LE TARIFFE APPENA VEICOLI SONO CARICATI
  // ===============================
  useEffect(() => {
    veicoli.forEach(v => fetchTariffe(v.id));
  }, [veicoli]);

  // ===============================
  // CONFIGURA TARIFFE
  // ===============================
  const handleConfigureTariffe = (veicolo: Veicolo) => {
    setSelectedVeicolo(veicolo);
    setMessage('');
  };

  return (
    <div className="p-4 max-w-4xl mx-auto space-y-8">
      <h1 className="text-2xl font-bold">Gestione Tariffe</h1>

      {errorVeicoli && <p className="text-red-600 text-sm">{errorVeicoli}</p>}
      {loadingVeicoli && <p className="text-gray-600 text-sm">Caricamento veicoli...</p>}
      {errorTariffe && <p className="text-red-600 text-sm">{errorTariffe}</p>}
      {message && <p className="text-sm text-gray-600">{message}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {veicoli.map(v => {
          const veicoloTariffe = tariffe.filter(t => t.veicolo_id === v.id);
          const isLoading = loadingTariffeId === v.id;

          return (
            <div key={v.id} className="relative">
              {isLoading && (
                <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10">
                  <span className="text-gray-600 text-sm">Caricamento tariffe...</span>
                </div>
              )}
              <TariffeCardList
                veicoloModello={v.modello}
                tariffe={veicoloTariffe}
                onConfigure={() => handleConfigureTariffe(v)}
              />
            </div>
          );
        })}
      </div>

      {selectedVeicolo && (
        <div className="mt-4 border p-4 rounded bg-white shadow">
          <h2 className="text-lg font-semibold mb-2">
            Tariffe per {selectedVeicolo.modello}
          </h2>
          <TariffeForm
            tariffeIniziali={tariffe.filter(t => t.veicolo_id === selectedVeicolo.id)}
            veicoloId={selectedVeicolo.id}
            onSaveAll={(savedTariffe) => {
              setTariffe(prev => {
                const others = prev.filter(t => t.veicolo_id !== selectedVeicolo.id);
                return [...others, ...savedTariffe];
              });
              setSelectedVeicolo(null);
              setMessage('Tariffe salvate!');
            }}
            onCancel={() => setSelectedVeicolo(null)}
          />
        </div>
      )}
    </div>
  );
}