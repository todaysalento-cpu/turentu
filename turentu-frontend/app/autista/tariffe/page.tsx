'use client';
import { useEffect, useState } from 'react';
import { useUser } from '../../../context/UserContext';
import TariffeCardList from '../../../components/TariffeCardList';
import TariffeModal from '../../../components/TariffeModal';
import DistanzaPopup from '../../../components/DistanzaPopup';
import { Tariffa } from '../../../components/TariffeForm';

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
  const [message, setMessage] = useState('');
  const [errorVeicoli, setErrorVeicoli] = useState<string | null>(null);
  const [loadingVeicoli, setLoadingVeicoli] = useState(false);
  const [loadingTariffeId, setLoadingTariffeId] = useState<number | null>(null);

  const [origine, setOrigine] = useState('');
  const [destinazione, setDestinazione] = useState('');
  const [distanza, setDistanza] = useState<number | null>(null);

  const [popupTariffeVeicolo, setPopupTariffeVeicolo] = useState<Veicolo | null>(null);
  const [popupSimulaOpen, setPopupSimulaOpen] = useState(false);

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
  // FETCH TARIFFE
  // ===============================
  const fetchTariffe = async (veicoloId: number) => {
    setLoadingTariffeId(veicoloId);
    try {
      const res = await fetch(`http://localhost:3001/tariffe/veicolo/${veicoloId}`, { credentials: 'include' });
      if (!res.ok) {
        if (res.status === 404) {
          // Nessuna tariffa trovata → manteniamo array vuoto
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

      setTariffe(prev => [...prev.filter(t => t.veicolo_id !== veicoloId), ...data]);
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoadingTariffeId(null);
    }
  };

  useEffect(() => {
    veicoli.forEach(v => fetchTariffe(v.id));
  }, [veicoli]);

  // ===============================
  // APRI POPUP CONFIGURAZIONE TARIFFE
  // ===============================
  const handleConfigureTariffe = (veicolo: Veicolo) => {
    setPopupTariffeVeicolo(veicolo);
    fetchTariffe(veicolo.id);
  };

  // ===============================
  // SIMULAZIONE
  // ===============================
  const handleSimula = (o: string, d: string, km: number) => {
    setOrigine(o);
    setDestinazione(d);
    setDistanza(km);
    document.getElementById('simulazione-globale')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-center">Gestione Tariffe</h1>

      {message && <div className="bg-green-100 text-green-800 p-2 rounded">{message}</div>}
      {errorVeicoli && <div className="bg-red-100 text-red-700 p-2 rounded">{errorVeicoli}</div>}

      {/* CARD VEICOLI */}
      {loadingVeicoli ? (
        <div className="text-center py-8 text-gray-500">Caricamento veicoli...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {veicoli.map(v => {
            const veicoloTariffe = tariffe.filter(t => t.veicolo_id === v.id);
            const hasTariffe = veicoloTariffe.length > 0;

            return (
              <TariffeCardList
                key={v.id}
                veicoloModello={v.modello}
                targa={v.targa}
                tariffe={veicoloTariffe}
                distanzaSimulata={distanza ?? undefined}
                origineSimulata={origine || undefined}
                destinazioneSimulata={destinazione || undefined}
                onConfigure={() => handleConfigureTariffe(v)}
                onSimula={() => setPopupSimulaOpen(true)}
                // Mostra pulsante aggiungi tariffe se non ci sono
                showAddButton={!hasTariffe}
                onAdd={() => handleConfigureTariffe(v)}
              />
            );
          })}
        </div>
      )}

      {/* POPUP CONFIGURAZIONE TARIFFE */}
      {popupTariffeVeicolo && (
        <TariffeModal
          open={!!popupTariffeVeicolo}
          veicoloId={popupTariffeVeicolo.id}
          veicoloModello={popupTariffeVeicolo.modello}
          tariffeIniziali={tariffe.filter(t => t.veicolo_id === popupTariffeVeicolo.id)}
          loading={loadingTariffeId === popupTariffeVeicolo.id}
          onClose={() => setPopupTariffeVeicolo(null)}
          onSaveAll={savedTariffe => {
            setTariffe(prev => [
              ...prev.filter(t => t.veicolo_id !== popupTariffeVeicolo.id),
              ...savedTariffe,
            ]);
            setPopupTariffeVeicolo(null);
          }}
          onSimula={() => setPopupSimulaOpen(true)}
          distanzaSimulata={distanza ?? undefined}
          origineSimulata={origine || undefined}
          destinazioneSimulata={destinazione || undefined}
        />
      )}

      {/* POPUP SIMULAZIONE */}
      <DistanzaPopup
        isOpen={popupSimulaOpen}
        onClose={() => setPopupSimulaOpen(false)}
        onSimula={handleSimula}
      />
    </div>
  );
}