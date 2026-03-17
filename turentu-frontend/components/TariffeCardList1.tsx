'use client';

import { FaUserPlus } from 'react-icons/fa';

type Props = {
  veicoloModello: string;
  targa?: string;
  tariffe: Tariffa[];
  onConfigure: () => void;
};

const tipoColors: Record<Tariffa['tipo'], string> = {
  standard: 'bg-blue-200 text-blue-800',
  notturna: 'bg-purple-200 text-purple-800',
  festivo: 'bg-orange-200 text-orange-800',
};

const ordineTipi: Tariffa['tipo'][] = ['standard', 'notturna', 'festivo'];

// Piccola icona €/km inline ridotta
const EuroKmIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="30"
    height="12"
    viewBox="0 0 30 12"
    fill="currentColor"
  >
    <text x="0" y="10" fontSize="10" fontWeight="bold">€/km</text>
  </svg>
);

export default function TariffeCardList({ veicoloModello, targa, tariffe, onConfigure }: Props) {
  const hasTariffa = tariffe.length > 0;

  const tariffeOrdinate = ordineTipi
    .map(tipo => tariffe.find(t => t.tipo === tipo))
    .filter(Boolean) as Tariffa[];

  return (
    <div className="border rounded-lg p-3 bg-white shadow-sm flex flex-col gap-2">
      {/* Header con modello e targa + pulsante */}
      <div className="flex justify-between items-center mb-2 pb-2 border-b border-gray-200">
        <div>
          <h3 className="font-semibold text-lg">{veicoloModello}</h3>
          {targa && <span className="text-sm text-gray-500 font-medium">{targa}</span>}
        </div>
        <button
          onClick={onConfigure}
          className="px-2 py-1 rounded bg-blue-600 text-white text-sm hover:bg-blue-700 transition"
        >
          {hasTariffa ? 'Modifica' : 'Configura'}
        </button>
      </div>

      {/* Tariffe con intestazioni solo icone */}
      {hasTariffa ? (
        <div className="flex flex-col gap-1 text-sm text-gray-700">
          {/* Intestazioni */}
          <div className="flex items-center gap-2 font-medium text-xs text-gray-600">
            <div className="min-w-[70px]"></div> {/* spazio per tipo */}
            <div className="flex gap-2">
              <div className="flex items-center justify-center w-[60px] text-xs">
                <EuroKmIcon />
              </div>
              <div className="flex items-center justify-center w-[60px] text-xs">
                <FaUserPlus className="text-xs" />
              </div>
            </div>
          </div>

          {/* Tariffe ordinate */}
          {tariffeOrdinate.map(t => (
            <div key={t.tipo} className="flex items-center gap-2">
              {/* Tipo */}
              <div
                className={`px-2 py-0.5 rounded text-xs font-medium ${tipoColors[t.tipo]} text-center min-w-[70px]`}
              >
                {t.tipo}
              </div>

              {/* Valori euro/km e passeggero con sfondo neutro */}
              <div className="flex gap-2">
                <div className="px-2 py-0.5 rounded bg-gray-100 text-xs text-center whitespace-nowrap min-w-[60px] flex-shrink-0">
                  € {t.euro_km.toFixed(2)}
                </div>
                <div className="px-2 py-0.5 rounded bg-gray-100 text-xs text-center whitespace-nowrap min-w-[60px] flex-shrink-0">
                  € {t.prezzo_passeggero.toFixed(2)}
                </div>
              </div>

              {/* Spazio residuo a destra */}
              <div className="flex-1"></div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-gray-400 text-sm italic">Nessuna tariffa configurata</div>
      )}
    </div>
  );
}