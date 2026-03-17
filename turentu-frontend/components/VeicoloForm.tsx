'use client';
import { useState, useEffect, useRef } from 'react';
import GoogleMapsLoader from '@/app/GoogleMapsLoader';

const SERVIZI_DISPONIBILI = [
  'WiFi', 'Aria condizionata', 'Animali ammessi', 'Bagagliaio grande', 'USB', 'Seggiolino bambini'
];

export const TIPI_VEICOLO = {
  citycar: { label: "City Car", icon: "🚗" },
  berlina: { label: "Berlina", icon: "🚘" },
  suv: { label: "SUV", icon: "🛻" },
  station_wagon: { label: "Station Wagon", icon: "🚙" },
  minivan: { label: "Minivan", icon: "🚐" },
  van: { label: "Van", icon: "🚐" },
  luxury: { label: "Luxury", icon: "💎" },
  electric: { label: "Elettrica", icon: "🔌" },
};

type Veicolo = {
  id?: number;
  marca?: string;
  modello: string;
  tipo?: string;
  anno?: number;
  posti_totali: number;
  targa?: string;
  servizi: string[];
  lat?: number;
  lon?: number;
  localita?: string;
  image_url?: string;
};

type Modello = { nome: string; tipo: string };
type MarcaCompleta = { id: string; nome: string; modelli: Modello[] };

type Props = {
  veicolo?: Veicolo;
  onSave: (v: Veicolo) => void;
  onCancel?: () => void;
};

export default function VeicoloForm({ veicolo, onSave, onCancel }: Props) {
  // --- Helper array sicuro ---
  const safeArray = <T,>(arr?: T[]): T[] => (Array.isArray(arr) ? arr : []);

  // --- State principali ---
  const [marca, setMarca] = useState<string>(veicolo?.marca || '');
  const [modello, setModello] = useState<string>(veicolo?.modello || '');
  const [tipo, setTipo] = useState<string>(veicolo?.tipo || '');
  const [anno, setAnno] = useState<number>(veicolo?.anno || new Date().getFullYear());
  const [posti, setPosti] = useState<number>(veicolo?.posti_totali || 4);
  const [targa, setTarga] = useState<string>(veicolo?.targa || '');
  const [servizi, setServizi] = useState<string[]>(safeArray(veicolo?.servizi));
  const [lat, setLat] = useState<number | undefined>(veicolo?.lat);
  const [lon, setLon] = useState<number | undefined>(veicolo?.lon);
  const [localita, setLocalita] = useState<string>(veicolo?.localita || '');
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // --- Marche e modelli ---
  const [marche, setMarche] = useState<MarcaCompleta[]>([]);
  const [modelli, setModelli] = useState<Modello[]>([]);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // --- Fetch marche e modelli ---
  useEffect(() => {
    async function fetchMarcheModelli() {
      try {
        const res = await fetch('http://localhost:3001/veicolo/marche-modelli', { credentials: 'include' });
        let data: any = await res.json();
        if (!Array.isArray(data)) data = [];
        setMarche(data);
      } catch (err) {
        console.error(err);
        setMarche([]);
      } finally {
        setLoading(false);
      }
    }
    fetchMarcheModelli();
  }, []);

  // --- Popola valori se veicolo esistente ---
  useEffect(() => {
    if (!veicolo || !marche.length) return;

    const marcaSelezionata = marche.find(
      m => m.nome === veicolo.marca || m.id === veicolo.marca
    );
    if (!marcaSelezionata) return;

    setMarca(marcaSelezionata.id);
    setModelli(marcaSelezionata.modelli);
    setModello(veicolo.modello);

    const modelloObj = marcaSelezionata.modelli.find(m => m.nome === veicolo.modello);
    setTipo(
      modelloObj?.tipo && Object.keys(TIPI_VEICOLO).includes(modelloObj.tipo)
        ? modelloObj.tipo
        : veicolo.tipo && Object.keys(TIPI_VEICOLO).includes(veicolo.tipo)
          ? veicolo.tipo
          : ''
    );
    setServizi(safeArray(veicolo.servizi));
  }, [veicolo, marche]);

  // --- Aggiorna modelli quando cambia marca ---
  useEffect(() => {
    if (!marca) return setModelli([]);
    const marcaSelezionata = marche.find(m => m.id === marca);
    setModelli(marcaSelezionata?.modelli || []);
    if (!veicolo) {
      setModello('');
      setTipo('');
    }
  }, [marca, marche, veicolo]);

  // --- Google Autocomplete ---
  useEffect(() => {
    if (!window.google || !inputRef.current) return;
    const autocomplete = new window.google.maps.places.Autocomplete(inputRef.current, {
      types: ['geocode'],
      componentRestrictions: { country: 'it' }
    });

    if (veicolo?.localita) setLocalita(veicolo.localita);
    if (veicolo?.lat !== undefined && veicolo?.lon !== undefined) {
      setLat(veicolo.lat);
      setLon(veicolo.lon);
    }

    const listener = autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place.geometry) return;
      setLat(place.geometry.location.lat());
      setLon(place.geometry.location.lng());
      setLocalita(place.formatted_address || '');
    });

    return () => listener.remove;
  }, []);

  // --- Toggle servizi ---
  const toggleServizio = (s: string) => {
    setServizi(prev => safeArray(prev).includes(s) ? prev.filter(x => x !== s) : [...safeArray(prev), s]);
  };

  // --- Submit form ---
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!marca || !modello || !tipo || !anno || !posti || !targa || !localita) {
      setErrorMsg('Tutti i campi obbligatori devono essere compilati');
      return;
    }

    setSaving(true);
    setErrorMsg(null);

    try {
      const payload: Veicolo = {
        marca: marche.find(m => m.id === marca)?.nome || marca,
        modello,
        tipo,
        anno,
        posti_totali: posti,
        targa,
        servizi: safeArray(servizi),
        lat,
        lon,
        localita
      };

      const res = await fetch(
        veicolo?.id ? `http://localhost:3001/veicolo/${veicolo.id}` : `http://localhost:3001/veicolo`,
        {
          method: veicolo?.id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload)
        }
      );

      const data = await res.json().catch(() => ({ error: 'Risposta non valida dal server' }));
      if (!res.ok) throw new Error(data.error || 'Errore salvataggio');
      onSave(data);

    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message);
    } finally {
      setSaving(false);
    }
  };

  const title = veicolo
    ? `Modifica veicolo: ${veicolo.marca} ${veicolo.modello} ${veicolo.targa || ''}`
    : 'Aggiungi veicolo';

  const inputClass = "border p-1 rounded w-full h-9";

  return (
    <>
      <GoogleMapsLoader />

      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-xl shadow-lg w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden text-sm"
        >
          <div className="p-4 overflow-auto flex-1 space-y-4 scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-gray-100">
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-lg font-semibold">{title}</h2>
              {onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="text-gray-500 hover:text-gray-700 font-bold text-xl"
                >
                  &times;
                </button>
              )}
            </div>

            <div className="border-b border-gray-200 mb-2"></div>

            {errorMsg && <p className="text-red-600 text-sm">{errorMsg}</p>}

            {/* Marca / Modello */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block mb-1">Marca*</label>
                <select
                  value={marca}
                  onChange={e => setMarca(e.target.value)}
                  className={inputClass}
                  disabled={loading}
                  required
                >
                  <option value="">{loading ? 'Caricamento...' : 'Seleziona marca'}</option>
                  {marche.map(m => <option key={m.id} value={m.id}>{m.nome}</option>)}
                </select>
              </div>

              <div>
                <label className="block mb-1">Modello*</label>
                <select
                  value={modello}
                  onChange={e => {
                    setModello(e.target.value);
                    const m = modelli.find(m => m.nome === e.target.value);
                    setTipo(m ? m.tipo : '');
                  }}
                  className={inputClass}
                  disabled={!modelli.length}
                  required
                >
                  <option value="">{modelli.length ? 'Seleziona modello' : 'Nessun modello'}</option>
                  {modelli.map((m, idx) => <option key={`${m.nome}-${idx}`} value={m.nome}>{m.nome}</option>)}
                </select>
              </div>
            </div>

            {/* Tipo / Anno / Posti */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block mb-1">Tipo*</label>
                <select
                  value={tipo}
                  onChange={e => setTipo(e.target.value)}
                  className={inputClass}
                  required
                >
                  <option value="">Seleziona tipo</option>
                  {Object.entries(TIPI_VEICOLO).map(([key, t]) => (
                    <option key={key} value={key}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block mb-1">Anno*</label>
                <input
                  type="number"
                  value={anno}
                  onChange={e => setAnno(Number(e.target.value))}
                  className={inputClass}
                  required
                />
              </div>
              <div>
                <label className="block mb-1">Posti*</label>
                <input
                  type="number"
                  value={posti}
                  onChange={e => setPosti(Number(e.target.value))}
                  className={inputClass}
                  required
                />
              </div>
            </div>

            {/* Targa / Località */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block mb-1">Targa*</label>
                <input type="text" value={targa} onChange={e => setTarga(e.target.value)} className={inputClass} required />
              </div>
              <div>
                <label className="block mb-1">Località*</label>
                <input type="text" ref={inputRef} value={localita} onChange={e => setLocalita(e.target.value)} className={inputClass} required />
              </div>
            </div>

            {/* Servizi */}
            <div>
              <label className="block mb-1">Servizi</label>
              <div className="flex flex-wrap gap-1">
                {SERVIZI_DISPONIBILI.map(s => (
                  <button
                    key={s}
                    type="button"
                    className={`px-2 py-1 border rounded text-sm ${
                      safeArray(servizi).includes(s) ? 'bg-blue-500 text-white' : 'bg-white text-black'
                    }`}
                    onClick={() => toggleServizio(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="border-t border-gray-200"></div>
          <div className="flex gap-2 p-3 bg-gray-50">
            <button type="submit" className="flex-1 bg-green-500 text-white py-2 rounded" disabled={saving}>
              {saving ? 'Salvando...' : 'Salva'}
            </button>
            {onCancel && (
              <button type="button" className="flex-1 bg-gray-300 py-2 rounded" onClick={onCancel}>
                Annulla
              </button>
            )}
          </div>
        </form>
      </div>
    </>
  );
}