'use client';
import { useState } from 'react';

type DistanzaPopupProps = {
  isOpen: boolean;
  onClose: () => void;
  onSimula?: (origine: string, destinazione: string, distanza: number) => void;
};

export default function DistanzaPopup({ isOpen, onClose, onSimula }: DistanzaPopupProps) {
  const [origine, setOrigine] = useState('');
  const [destinazione, setDestinazione] = useState('');
  const [loading, setLoading] = useState(false);
  const [distanza, setDistanza] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCalcola = async () => {
    if (!origine || !destinazione) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `http://localhost:3001/distanza?origine=${encodeURIComponent(origine)}&destinazione=${encodeURIComponent(destinazione)}`
      );
      if (!res.ok) throw new Error('Errore calcolo distanza');
      const data = await res.json();
      const km = Number(data.distanzaKm ?? data.km ?? 0);
      setDistanza(km);
      if (onSimula) onSimula(origine, destinazione, km);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Errore calcolo distanza');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-80 shadow-lg flex flex-col gap-3 relative">
        {/* X in alto a destra */}
        <button
          onClick={onClose}
          className="absolute top-2 right-2 text-gray-500 hover:text-gray-700 font-bold text-lg transition"
        >
          ×
        </button>

        <h2 className="text-lg font-semibold text-center">Simulazione corsa</h2>

        <input
          type="text"
          placeholder="Origine"
          className="border rounded p-2 w-full text-sm"
          value={origine}
          onChange={e => setOrigine(e.target.value)}
        />

        <input
          type="text"
          placeholder="Destinazione"
          className="border rounded p-2 w-full text-sm"
          value={destinazione}
          onChange={e => setDestinazione(e.target.value)}
        />

        {error && <p className="text-red-600 text-xs text-center">{error}</p>}
        {distanza !== null && (
          <p className="text-sm text-gray-600 text-center">Distanza: {distanza.toFixed(2)} km</p>
        )}

        {/* Pulsante centrale */}
        <div className="flex justify-center mt-3">
          <button
            onClick={handleCalcola}
            className="px-6 py-2 rounded text-white bg-black hover:bg-gray-800 transition text-sm"
          >
            {loading ? 'Calcolo...' : 'Simula'}
          </button>
        </div>
      </div>
    </div>
  );
}