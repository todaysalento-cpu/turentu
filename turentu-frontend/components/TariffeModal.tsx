'use client';
import { FaUserPlus } from 'react-icons/fa';
import { useEffect, useState } from 'react';
import { Tariffa } from './TariffeForm';

type TariffeModalProps = {
  open: boolean;
  veicoloId: number;
  veicoloModello: string;
  tariffeIniziali?: Tariffa[];
  loading?: boolean;
  onClose: () => void;
  onSaveAll: (tariffe: Tariffa[]) => void;
  onSimula?: () => void;
  distanzaSimulata?: number;
};

export default function TariffeModal({
  open,
  veicoloId,
  veicoloModello,
  tariffeIniziali = [],
  loading = false,
  onClose,
  onSaveAll,
  onSimula,
  distanzaSimulata,
}: TariffeModalProps) {
  const tipi: Tariffa['tipo'][] = ['standard', 'notturna', 'festivo'];
  const [form, setForm] = useState<Record<string, Tariffa>>({});
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const tipoColors: Record<Tariffa['tipo'], string> = {
    standard: 'bg-blue-200 text-blue-800',
    notturna: 'bg-purple-200 text-purple-800',
    festivo: 'bg-orange-200 text-orange-800',
  };

  // Inizializza il form con incremento
  useEffect(() => {
    if (!open) return;
    const init: Record<string, Tariffa> = {};
    tipi.forEach(tipo => {
      const existing = tariffeIniziali.find(t => t.tipo === tipo);
      init[tipo] = existing ?? {
        veicolo_id: veicoloId,
        tipo,
        euro_km: 1.1,
        prezzo_passeggero: 1,
        giorno_settimana: null,
        ora_inizio: '',
        ora_fine: '',
      };
    });
    setForm(init);
  }, [open, tariffeIniziali, veicoloId]);

  const handleFieldChange = (
    tipo: Tariffa['tipo'],
    field: keyof Pick<Tariffa, 'euro_km' | 'prezzo_passeggero' | 'giorno_settimana' | 'ora_inizio' | 'ora_fine'>,
    value: any
  ) => {
    setForm(prev => ({ ...prev, [tipo]: { ...prev[tipo], [field]: value } }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrorMsg(null);

    try {
      const savedTariffe: Tariffa[] = [];
      for (const tipo of tipi) {
        const t = form[tipo];
        if (!t) continue;

        const payload = {
          veicolo_id: veicoloId,
          tipo,
          euro_km: Number(t.euro_km),
          prezzo_passeggero: Number(t.prezzo_passeggero),
          giorno_settimana: t.giorno_settimana ?? null,
          ora_inizio: t.ora_inizio || null,
          ora_fine: t.ora_fine || null,
        };

        const url = t.id ? `http://localhost:3001/tariffe/${t.id}` : 'http://localhost:3001/tariffe';
        const method = t.id ? 'PUT' : 'POST';

        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Errore salvataggio tariffa ${tipo}`);

        savedTariffe.push({
          ...data,
          euro_km: Number(data.euro_km),
          prezzo_passeggero: Number(data.prezzo_passeggero),
        });
      }

      onSaveAll(savedTariffe);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const hasExistingTariffe = tariffeIniziali.length > 0;
  const submitLabel = hasExistingTariffe ? 'Aggiorna tariffe' : 'Aggiungi tariffe';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-lg w-full max-w-lg p-3 relative overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* X in alto a destra */}
        <button
          onClick={onClose}
          className="absolute top-2 right-2 text-gray-500 hover:text-gray-800 font-bold text-lg"
        >
          ×
        </button>

        {/* Titolo centrale */}
        <h2 className="text-center text-lg font-semibold mb-1">Tariffe {veicoloModello}</h2>
        <div className="border-b border-gray-200 mb-2"></div>

        {loading ? (
          <div className="text-center py-4 text-gray-500 text-[10px]">Caricamento tariffe...</div>
        ) : (
          <form key={veicoloId} onSubmit={handleSubmit} className="space-y-1 text-[10px]">
            {errorMsg && <div className="bg-red-100 text-red-700 p-1 rounded text-center">{errorMsg}</div>}

            {/* Header colonne centrato e neri */}
            <div className="grid grid-cols-4 gap-1 font-medium text-black text-center mb-1 text-[10px]">
              <div></div>
              <div>€/km</div>
              <div className="flex justify-center items-center gap-1">
                <FaUserPlus className="text-[10px]" /> €
              </div>
              <div>Stimato</div>
            </div>

            {/* Righe tariffe */}
            {tipi.map(tipo => {
              const t = form[tipo];
              if (!t) return null;

              const prezzoStimato =
                distanzaSimulata !== undefined ? (t.euro_km * distanzaSimulata).toFixed(2) : '–';

              return (
                <div key={tipo} className="grid grid-cols-4 gap-1 items-center text-[10px] text-center">
                  <div className={`px-1 py-1 rounded ${tipoColors[tipo]}`}>{tipo}</div>
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    value={t.euro_km}
                    onChange={e => handleFieldChange(tipo, 'euro_km', Number(e.target.value))}
                    className="px-1 py-1 border rounded text-center text-[10px]"
                    required
                  />
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    value={t.prezzo_passeggero}
                    onChange={e => handleFieldChange(tipo, 'prezzo_passeggero', Number(e.target.value))}
                    className="px-1 py-1 border rounded text-center text-[10px]"
                  />
                  <div className="px-1 py-1 rounded bg-green-50 text-green-800">
                    {prezzoStimato !== '–' ? `€ ${prezzoStimato}` : '–'}
                  </div>
                </div>
              );
            })}

            {/* Invito simulazione in badge giallo */}
            {onSimula && (
              <div className="text-center mt-2">
                <span className="text-[9px] italic bg-yellow-200 px-1 py-[1px] rounded font-medium text-black mr-1">
                  Vuoi stimare guadagno?
                </span>
                <button
                  type="button"
                  onClick={onSimula}
                  className="px-2 py-1 rounded bg-black text-white text-[9px] hover:bg-gray-800"
                >
                  Simula ora
                </button>
              </div>
            )}

            {/* Pulsanti centrati e compatti */}
            <div className="flex justify-center gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-2 py-1 rounded bg-white text-black border border-black hover:bg-gray-100 transition text-[9px]"
              >
                Annulla
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-2 py-1 rounded bg-black text-white hover:bg-gray-800 disabled:opacity-50 text-[9px]"
              >
                {saving ? 'Salvataggio...' : submitLabel}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}