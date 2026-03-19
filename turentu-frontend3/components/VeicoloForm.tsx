'use client';
import { useState, useEffect, useRef } from 'react';
import GoogleMapsLoader from '@/app/GoogleMapsLoader';
import { Veicolo } from '@/types/veicolo';

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

type Modello = { nome: string; tipo: string };
type MarcaCompleta = { id: string; nome: string; modelli: Modello[] };

type Props = {
  veicolo?: Veicolo;
  onSave: (v: Veicolo) => void;
  onCancel?: () => void;
};

export default function VeicoloForm({ veicolo, onSave, onCancel }: Props) {
  const safeArray = <T,>(arr?: T[]): T[] => (Array.isArray(arr) ? arr : []);

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

  const [marche, setMarche] = useState<MarcaCompleta[]>([]);
  const [modelli, setModelli] = useState<Modello[]>([]);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Fetch marche e modelli
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

  // Popola valori se veicolo esistente
  useEffect(() => {
    if (!veicolo || !marche.length) return;
    const marcaSelezionata = marche.find(m => m.nome === veicolo.marca || m.id === veicolo.marca);
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

  // Aggiorna modelli quando cambia marca
  useEffect(() => {
    if (!marca) return setModelli([]);
    const marcaSelezionata = marche.find(m => m.id === marca);
    setModelli(marcaSelezionata?.modelli || []);
    if (!veicolo) {
      setModello('');
      setTipo('');
    }
  }, [marca, marche, veicolo]);

  // Google Autocomplete
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

    return () => listener.remove();
  }, []);

  const toggleServizio = (s: string) => {
    setServizi(prev => safeArray(prev).includes(s) ? prev.filter(x => x !== s) : [...safeArray(prev), s]);
  };

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
                <label className="block mb-1">Marca</label>
                <select
                  className={inputClass}
                  value={marca}
                  onChange={e => setMarca(e.target.value)}
                >
                  <option value="">Seleziona marca</option>
                  {marche.map(m => (
                    <option key={m.id} value={m.id}>{m.nome}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block mb-1">Modello</label>
                <select
                  className={inputClass}
                  value={modello}
                  onChange={e => setModello(e.target.value)}
                >
                  <option value="">Seleziona modello</option>
                  {modelli.map(m => (
                    <option key={m.nome} value={m.nome}>{m.nome}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Tipo veicolo */}
            <div>
              <label className="block mb-1">Tipo</label>
              <select
                className={inputClass}
                value={tipo}
                onChange={e => setTipo(e.target.value)}
              >
                <option value="">Seleziona tipo</option>
                {Object.entries(TIPI_VEICOLO).map(([key, val]) => (
                  <option key={key} value={key}>{val.label}</option>
                ))}
              </select>
            </div>

            {/* Servizi */}
            <div>
              <label className="block mb-1">Servizi</label>
              <div className="flex flex-wrap gap-2">
                {SERVIZI_DISPONIBILI.map(s => (
                  <label key={s} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={servizi.includes(s)}
                      onChange={() => toggleServizio(s)}
                    />
                    {s}
                  </label>
                ))}
              </div>
            </div>

            {/* Località */}
            <div>
              <label className="block mb-1">Località</label>
              <input
                type="text"
                ref={inputRef}
                className={inputClass}
                value={localita}
                onChange={e => setLocalita(e.target.value)}
              />
            </div>

            {/* Anno, Posti, Targa */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block mb-1">Anno</label>
                <input
                  type="number"
                  className={inputClass}
                  value={anno}
                  onChange={e => setAnno(Number(e.target.value))}
                />
              </div>
              <div>
                <label className="block mb-1">Posti</label>
                <input
                  type="number"
                  className={inputClass}
                  value={posti}
                  onChange={e => setPosti(Number(e.target.value))}
                />
              </div>
              <div>
                <label className="block mb-1">Targa</label>
                <input
                  type="text"
                  className={inputClass}
                  value={targa}
                  onChange={e => setTarga(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="p-4 border-t flex justify-end gap-2">
            {onCancel && (
              <button type="button" onClick={onCancel} className="btn-cancel">
                Annulla
              </button>
            )}
            <button type="submit" disabled={saving} className="btn-save">
              {saving ? 'Salvando...' : 'Salva'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}